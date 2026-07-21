import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { CustomerRisk, RiskBand } from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { customers } from '../db/schema/customers';

/**
 * Değişim-oranı eşiği — security.service ile aynı semantik (0.25). Bunun ÜSTÜ riskli sinyal.
 * Sabitler security.service'te module-local tutulur (export yok); burada da aynı desende.
 */
const REPLACEMENT_RATIO_THRESHOLD = 0.25;
/** Bu atama sayısının altında değişim oranı skora KATILMAZ (düşük hacimde şişmesin). */
const RISK_MIN_ASSIGNMENTS = 3;
/** Değişim-oranı faktörünün tavan katkısı. */
const MAX_REPLACEMENT_POINTS = 45;

/** Güvenlik olayı faktörünün tavan katkısı + olay başına puan (severity'e göre). */
const MAX_SECURITY_POINTS = 30;
const SEC_POINTS_WARNING = 6;
const SEC_POINTS_CRITICAL = 12;
/** Güvenlik olayı penceresi (saat) ve dikkate alınan türler (§5/§15). */
const SECURITY_WINDOW_HOURS = 48;
const SECURITY_EVENT_TYPES = ['velocity', 'anomaly', 'quota_exceeded'] as const;

/**
 * Elle etiket ağırlıkları — "risky"/"blocked" büyük artırır, "vip"/"wholesale" azaltır (§13).
 * Etiket lowercase eşleştirilir; tanımsız etiket skora etki etmez.
 */
const TAG_WEIGHTS: Record<string, number> = {
  blocked: 50,
  risky: 30,
  vip: -25,
  wholesale: -15,
};

/** Hesap yeniliği/aktivite penceresi — küçük katkı (yeni/patlama aktivitesi hafif risk). */
const NEW_ACCOUNT_DAYS = 7;
const NEW_ACCOUNT_POINTS = 8;
const RECENT_ORDER_HOURS = 24;
const RECENT_ORDER_POINTS = 5;
const MAX_RECENCY_POINTS = 10;

/** Band eşikleri: <34 low, <67 medium, aksi high. */
const BAND_LOW_MAX = 34;
const BAND_MEDIUM_MAX = 67;

/** KVKK anonimleştirme maskesinin alan-adı (compliance.service.redactedFor). */
const ANON_DOMAIN = '@redacted.invalid';

/**
 * replacementRate = onaylı değişim / GREATEST(atama, 1) — sıfıra bölme yok
 * (customers.service.rate deseninin yeniden kullanımı).
 */
function rate(replacementCount: number, assignmentCount: number): number {
  return replacementCount / Math.max(assignmentCount, 1);
}

/** Skoru banda çevirir (eşik tablosu tek yerde). */
function toBand(score: number): RiskBand {
  if (score < BAND_LOW_MAX) return 'low';
  if (score < BAND_MEDIUM_MAX) return 'medium';
  return 'high';
}

/** Bulunamayan/anonimleştirilmiş müşteri → nötr (0/low), tek şeffaf faktörle. */
function neutralRisk(email: string, generatedAt: string, reason: string): CustomerRisk {
  return {
    email,
    score: 0,
    band: 'low',
    factors: [{ key: 'no_data', label: 'Veri yok', contribution: 0, detail: reason }],
    generatedAt,
  };
}

/**
 * RiskScoreService (§8/§9) — müşteri ADVISORY risk skoru. OKUMA-ANINDA türetilir;
 * hiçbir tabloya YAZMAZ ve HİÇBİR otomatik eylem tetiklemez ("panel önerir, insan
 * karar verir", §15). Ağırlıklı toplam: (a) değişim oranı, (b) müşterinin site(ler)inde
 * son 48s güvenlik olayları, (c) elle etiketler, (d) hesap yeniliği. Skor 0-100 clamp;
 * her faktör şeffaf gerekçe taşır. Anonimleştirilmiş/bulunamayan müşteri → nötr.
 *
 * Migration YOK: mevcut tabloları (orders/assignments/replacement_requests/security_events/
 * customers) SALT-OKUNUR okur.
 */
@Injectable()
export class RiskScoreService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Müşterinin advisory risk skorunu okuma-anında türetir (yazma/eylem YOK). */
  async scoreCustomer(email: string): Promise<CustomerRisk> {
    const key = email.trim().toLowerCase();
    const generatedAt = new Date().toISOString();

    // Anonimleştirilmiş müşteri (KVKK maskesi) → risk değerlendirilmez.
    if (key.endsWith(ANON_DOMAIN)) {
      return neutralRisk(key, generatedAt, 'Anonimleştirilmiş müşteri (KVKK) — risk değerlendirilmez');
    }

    // Kalıcı meta (varsa) — yalnız etiketler; not/PII okunmaz.
    const [meta] = await this.db
      .select({ tags: customers.tags })
      .from(customers)
      .where(eq(customers.email, key))
      .limit(1);
    const tags = meta?.tags ?? [];

    // Türetilmiş istatistik (orders/assignments + RAW replacement_requests) — anlık.
    const statRows = await rawRows<{
      order_count: number;
      assignment_count: number;
      replacement_count: number;
      first_order_at: Date | string | null;
      last_order_at: Date | string | null;
    }>(this.db, sql`
      SELECT
        (SELECT COUNT(*)::int FROM orders o WHERE lower(o.customer_email) = ${key}) AS order_count,
        (SELECT COUNT(*)::int FROM assignments asg
           JOIN orders o ON o.id = asg.order_id
           WHERE lower(o.customer_email) = ${key}) AS assignment_count,
        (SELECT COUNT(*)::int FROM replacement_requests
           WHERE lower(customer_email) = ${key} AND status = 'approved') AS replacement_count,
        (SELECT MIN(created_at) FROM orders WHERE lower(customer_email) = ${key}) AS first_order_at,
        (SELECT MAX(created_at) FROM orders WHERE lower(customer_email) = ${key}) AS last_order_at
    `);
    const s = statRows[0] ?? {
      order_count: 0,
      assignment_count: 0,
      replacement_count: 0,
      first_order_at: null,
      last_order_at: null,
    };
    const orderCount = Number(s.order_count);
    const assignmentCount = Number(s.assignment_count);
    const replacementCount = Number(s.replacement_count);

    // Ne sipariş ne meta → müşteri bilinmiyor → nötr.
    if (orderCount === 0 && !meta) {
      return neutralRisk(key, generatedAt, 'Müşteri kaydı bulunamadı — sipariş/geçmiş yok');
    }

    // Müşterinin site(ler)indeki son 48s güvenlik olayları (subject=e-posta eşleşmesi de dahil).
    // Pencere/türler sabit (kullanıcı girdisi değil); interval güvenli make_interval ile.
    const secRows = await rawRows<{ total: number; critical: number }>(this.db, sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE severity = 'critical')::int AS critical
      FROM security_events se
      WHERE se.created_at >= now() - make_interval(hours => ${SECURITY_WINDOW_HOURS})
        AND se.type IN (${sql.join(
          SECURITY_EVENT_TYPES.map((t) => sql`${t}`),
          sql`, `,
        )})
        AND (
          lower(se.subject) = ${key}
          OR se.site_id IN (
            SELECT DISTINCT site_id FROM orders
            WHERE lower(customer_email) = ${key} AND site_id IS NOT NULL
          )
        )
    `);
    const secTotal = Number(secRows[0]?.total ?? 0);
    const secCritical = Number(secRows[0]?.critical ?? 0);
    const secWarning = Math.max(0, secTotal - secCritical);

    // --- Faktör (a): değişim oranı ---
    const r = rate(replacementCount, assignmentCount);
    const ratePct = Math.round(r * 100);
    const thresholdPct = Math.round(REPLACEMENT_RATIO_THRESHOLD * 100);
    let replacementContribution = 0;
    let replacementDetail: string;
    if (assignmentCount < RISK_MIN_ASSIGNMENTS) {
      replacementDetail = `Yetersiz veri: ${assignmentCount} atama (< ${RISK_MIN_ASSIGNMENTS} eşik) — değişim oranı skora katılmadı`;
    } else if (r <= REPLACEMENT_RATIO_THRESHOLD) {
      replacementDetail = `Değişim oranı normal: %${ratePct} (${replacementCount}/${assignmentCount}) ≤ %${thresholdPct} eşik`;
    } else {
      const over = (r - REPLACEMENT_RATIO_THRESHOLD) / (1 - REPLACEMENT_RATIO_THRESHOLD);
      replacementContribution = Math.round(Math.min(MAX_REPLACEMENT_POINTS, over * MAX_REPLACEMENT_POINTS));
      replacementDetail = `Yüksek değişim oranı: %${ratePct} (${replacementCount}/${assignmentCount}) > %${thresholdPct} eşik`;
    }

    // --- Faktör (b): güvenlik olayları (48s) ---
    let securityContribution = 0;
    let securityDetail: string;
    if (secTotal === 0) {
      securityDetail = `Son ${SECURITY_WINDOW_HOURS}s müşterinin site(ler)inde güvenlik olayı yok`;
    } else {
      securityContribution = Math.min(
        MAX_SECURITY_POINTS,
        secCritical * SEC_POINTS_CRITICAL + secWarning * SEC_POINTS_WARNING,
      );
      securityDetail = `Son ${SECURITY_WINDOW_HOURS}s: ${secTotal} güvenlik olayı (${secCritical} kritik) müşterinin site(ler)inde — velocity/anomaly/quota_exceeded`;
    }

    // --- Faktör (c): elle etiketler ---
    let tagContribution = 0;
    const appliedTags: string[] = [];
    for (const tag of tags) {
      const w = TAG_WEIGHTS[tag.toLowerCase()];
      if (w !== undefined) {
        tagContribution += w;
        appliedTags.push(`${tag} (${w > 0 ? '+' : ''}${w})`);
      }
    }
    const tagDetail = appliedTags.length
      ? `Elle etiket: ${appliedTags.join(', ')}`
      : 'Riski etkileyen elle etiket yok';

    // --- Faktör (d): hesap yeniliği / son-sipariş yakınlığı (küçük) ---
    let recencyContribution = 0;
    const recencyParts: string[] = [];
    if (s.first_order_at) {
      const ageDays = (Date.now() - new Date(s.first_order_at).getTime()) / 86_400_000;
      if (ageDays < NEW_ACCOUNT_DAYS) {
        recencyContribution += NEW_ACCOUNT_POINTS;
        recencyParts.push(`yeni müşteri (ilk sipariş ${Math.max(0, Math.floor(ageDays))} gün önce)`);
      }
    }
    if (s.last_order_at) {
      const sinceHours = (Date.now() - new Date(s.last_order_at).getTime()) / 3_600_000;
      if (sinceHours < RECENT_ORDER_HOURS) {
        recencyContribution += RECENT_ORDER_POINTS;
        recencyParts.push('son 24 saatte sipariş');
      }
    }
    recencyContribution = Math.min(MAX_RECENCY_POINTS, recencyContribution);
    const recencyDetail = recencyParts.length
      ? `Hesap yeniliği: ${recencyParts.join('; ')}`
      : 'Hesap yaşı/aktivitesi nötr';

    // Ağırlıklı toplam → 0-100 clamp.
    const raw = replacementContribution + securityContribution + tagContribution + recencyContribution;
    const score = Math.max(0, Math.min(100, Math.round(raw)));

    return {
      email: key,
      score,
      band: toBand(score),
      factors: [
        { key: 'replacement_rate', label: 'Değişim oranı', contribution: replacementContribution, detail: replacementDetail },
        { key: 'security_events', label: `Güvenlik olayları (${SECURITY_WINDOW_HOURS}s)`, contribution: securityContribution, detail: securityDetail },
        { key: 'tags', label: 'Elle etiketler', contribution: tagContribution, detail: tagDetail },
        { key: 'recency', label: 'Hesap yeniliği', contribution: recencyContribution, detail: recencyDetail },
      ],
      generatedAt,
    };
  }
}
