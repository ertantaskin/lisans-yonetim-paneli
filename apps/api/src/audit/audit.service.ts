import { Inject, Injectable } from '@nestjs/common';
import { sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { auditActionEnum } from '../db/schema/enums';

/**
 * DENETİM İZİ OKUMA SERVİSİ (§8) — `audit_log` SALT-OKUNUR listeleme.
 *
 * NEDEN VAR: tablo doluydu (her reveal/revoke/import/login bir satır yazıyor) ama onu
 * listeleyen HİÇBİR uç yoktu → "bu anahtarı kim gösterdi", "bu siparişi kim iptal etti",
 * "dün gece kim ne yaptı" soruları ancak veritabanına ELLE bağlanarak yanıtlanabiliyordu.
 *
 * APPEND-ONLY: bu modül YALNIZ SELECT yapar. Yazma/silme/güncelleme ucu bilerek YOK —
 * denetim izinin değeri değiştirilemez olmasından gelir (şema yorumu: "UPDATE/DELETE
 * uygulama katmanında yasak"). Görüntüleme de audit'e YAZILMAZ; gerekçe `list()` içinde.
 */

/** `audit_action` PG enum'unun tam listesi — TEK KAYNAK şema (elle kopya sapma üretir). */
export const AUDIT_ACTIONS = auditActionEnum.enumValues;

/**
 * `total` üst sınırı. audit_log append-only ve en hızlı büyüyen tablolardan biri; süzgeçsiz
 * bir `count(*)` (ya da `count(*) OVER ()`) HER SAYFA AÇILIŞINDA tam tablo taraması demektir
 * ve sayfanın kendisi (created_at DESC + LIMIT) indexten karşılanırken sayacın taraması
 * ekranı zamanla kullanılamaz hale getirirdi.
 *
 * Bu yüzden sayım `LIMIT CAP+1` ile SINIRLI bir alt sorgu üzerinden yapılır: gerçek toplam
 * sınırın altındaysa TAM doğrudur; üstündeyse `totalCapped=true` ile DÜRÜSTÇE söylenir
 * ("10.000+"). Sessizce yanlış bir toplam göstermek bu projede yasak (sessiz kırpma sınıfı).
 */
export const AUDIT_COUNT_CAP = 10_000;

/** İzin verilen sayfa boyutları — istemci sapması olmasın diye sunucu bunlara KIRPAR. */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 50;

export interface AuditListParams {
  /** Aktör KISMİ eşleşme (ILIKE) — "ali" yazınca `panel:ali@x.com` bulunur. */
  actor?: string;
  /** `audit_action` enum değeri (controller doğrular → geçersizde 400, ham 500 değil). */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** ISO tarih/zaman (dahil). */
  from?: string;
  to?: string;
  traceId?: string;
  page?: number;
  pageSize?: number;
}

export interface AuditEntry {
  id: string;
  action: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  meta: unknown;
  traceId: string | null;
  createdAt: Date;
}

export interface AuditPage {
  items: AuditEntry[];
  /** Süzgece uyan kayıt sayısı — `totalCapped` true ise "en az bu kadar" anlamına gelir. */
  total: number;
  totalCapped: boolean;
  page: number;
  pageSize: number;
  /** Sayımın kırpıldığı sınır — istemci "10.000+" gibi dürüst bir metin kurabilsin. */
  countCap: number;
}

interface AuditRawRow {
  id: string;
  action: string;
  actor: string;
  target_type: string | null;
  target_id: string | null;
  meta: unknown;
  trace_id: string | null;
  created_at: Date;
}

/** Ayrıştırılabilir tarihi ISO dizeye çevirir; boş/bozuk değerde null (süzgeç uygulanmaz). */
function toIsoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** LIKE joker karakterlerini kaçırır (aktör aramasında '%'/'_' joker gibi davranmasın). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * `meta` içinde SIR TAŞIYABİLECEK anahtar adları.
 *
 * BUGÜN NO-OP: tüm audit yazarları (30 çağrı yeri) tarandı — meta yalnız sayaç, id, enum ve
 * operatörün yazdığı `reason` metni taşıyor; düz-metin lisans/parola ASLA girmiyor (şema
 * sözleşmesi). Bu kalkan GELECEK içindir: yeni bir yazar meta'ya `password`/`payload` koyarsa
 * denetim ekranı onu sessizce yaymasın. `compliance.service` içinde security_events.meta için
 * aynı risk açıkça not edilmiş — aynı sınıf hatayı burada kapıda karşılıyoruz.
 *
 * DEĞER SİLİNMEZ, `[gizlendi]` ile DEĞİŞTİRİLİR: anahtarın varlığı görünür kalsın (sessiz
 * kaybolma, operatöre "böyle bir bilgi yok" yalanını söyler).
 */
const SENSITIVE_META_KEY_RE =
  /(payload|secret|password|passwd|token|api_?key|hmac|private_?key|plaintext|license_?key)/i;
const REDACTED = '[gizlendi]';
/** Özyineleme tavanı — jsonb keyfi derinlikte olabilir; yığın taşmasına karşı sabit sınır. */
const MAX_META_DEPTH = 6;

function redactMeta(value: unknown, depth = 0): unknown {
  if (depth >= MAX_META_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redactMeta(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_META_KEY_RE.test(k) ? REDACTED : redactMeta(v, depth + 1);
  }
  return out;
}

@Injectable()
export class AuditService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Denetim kaydı sayfası. Tüm süzgeçler opsiyonel; hiçbiri verilmezse en yeni kayıtlar.
   *
   * GÖRÜNTÜLEME AUDIT'E YAZILMAZ (bilinçli): bu ekran hiçbir SIR göstermez (bkz. controller'daki
   * yetki kararı), yani "reveal audit'e düşer" kuralının konusu değildir. Üstelik denetim
   * görüntülemesini denetime yazmak KENDİNİ BESLEYEN bir döngü kurardı — her ziyaret bir satır
   * ekler, o satır sonraki ziyarette listenin başında görünür ve gerçek olayları aşağı iter
   * (retention servisi zaten `auto` reveal gürültüsünü budamak zorunda kalmıştı).
   */
  async list(params: AuditListParams = {}): Promise<AuditPage> {
    const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
    const pageSize = (AUDIT_PAGE_SIZES as readonly number[]).includes(params.pageSize ?? 0)
      ? (params.pageSize as number)
      : DEFAULT_PAGE_SIZE;
    const offset = (page - 1) * pageSize;

    // ── Süzgeç fragmanı TEK YERDE ──
    // Sayfa sorgusu ve sayım sorgusu BİREBİR aynı `where` nesnesini kullanır; iki ayrı yazım
    // bu projede daha önce "toplam ile liste çelişir" hatasını doğurmuştu.
    const conds: SQL[] = [sql`true`];

    const actor = (params.actor ?? '').trim();
    // KISMİ eşleşme: operatör tam aktör dizesini (ör. 'panel:ali@x.com') ezberlemek zorunda
    // değil. `audit_log_actor_idx` bu dalda kullanılamaz (baştan joker) — kabul edilir:
    // aktör araması dar bir teşhis işi, sayım zaten CAP ile sınırlı.
    if (actor) conds.push(sql`actor ILIKE ${`%${escapeLike(actor)}%`} ESCAPE '\\'`);

    // PARAMETRE cast'i (kolon cast'i DEĞİL): `action::text = $1` yazımı kolonu fonksiyona
    // sokar ve `audit_log_action_idx`i kullanılamaz kılar (envanter listesinde ölçülmüş ders).
    if (params.action) conds.push(sql`action = ${params.action}::audit_action`);

    if (params.targetType) conds.push(sql`target_type = ${params.targetType}`);
    if (params.targetId) conds.push(sql`target_id = ${params.targetId}`);
    if (params.traceId) conds.push(sql`trace_id = ${params.traceId}`);

    /*
     * Tarih sınırları DAHİL (>=, <=). Controller yalnız "ayrıştırılabilir mi" diye bakar;
     * normalleştirme burada — geçersiz değer buraya HİÇ ulaşmaz.
     *
     * ISO DİZE + AÇIK `::timestamptz` (Date NESNESİ DEĞİL): bu fragman ham `sql` şablonuyla
     * kuruluyor ve `rawRows` üzerinden sürücüye gidiyor; oraya bir `Date` konduğunda postgres.js
     * bind aşamasında ERR_INVALID_ARG_TYPE ile patlıyor (drizzle'ın kolon-farkında yolu değil).
     * Projede tarih süzgeci olan diğer yer (`admin-orders.service`) de tam olarak bu deseni
     * kullanıyor — tek yazım biçimi. Cast ŞART: cast'siz parametre `text` olarak bind edilir ve
     * `timestamptz` ile karşılaştırma 42883 verir.
     */
    const fromIso = toIsoOrNull(params.from);
    const toIso = toIsoOrNull(params.to);
    if (fromIso) conds.push(sql`created_at >= ${fromIso}::timestamptz`);
    if (toIso) conds.push(sql`created_at <= ${toIso}::timestamptz`);

    const where = sql.join(conds, sql` AND `);

    /*
     * SIRALAMA + TIE-BREAK (zorunlu): `created_at DESC` TEK BAŞINA yetmez. Bir işlem içinde
     * yazılan satırlar (ör. toplu geçersiz kılma: kalem başına bir audit satırı) AYNI
     * transaction damgasını taşır → tie-break'siz bir LIMIT/OFFSET sayfalamasında aynı kayıt
     * iki sayfada görünebilir ya da hiç görünmeyebilir (bu projenin bilinen hata sınıfı).
     *
     * Tie-break `id`: audit_log'da `seq` gibi bir ekleme sırası kolonu YOK ve id rastgele
     * uuid'dir → eşit damgalı satırların İÇ SIRASI anlamlı değildir, ama KARARLIDIR; sayfalama
     * tutarlılığı için gereken tam olarak budur.
     */
    const rows = await rawRows<AuditRawRow>(this.db, sql`
      SELECT id, action::text AS action, actor, target_type, target_id, meta, trace_id, created_at
      FROM audit_log
      WHERE ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT ${pageSize} OFFSET ${offset};
    `);

    // Sayım SINIRLI alt sorgu üzerinden (bkz. AUDIT_COUNT_CAP): CAP+1 satır görüldüyse
    // "en az CAP kadar var" denir. `SELECT 1` seçilir — sayım için kolon okumaya gerek yok.
    const counted = await rawRows<{ n: number }>(this.db, sql`
      SELECT count(*)::int AS n
      FROM (SELECT 1 FROM audit_log WHERE ${where} LIMIT ${AUDIT_COUNT_CAP + 1}) capped;
    `);
    const raw = Number(counted[0]?.n ?? 0);
    const totalCapped = raw > AUDIT_COUNT_CAP;

    return {
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        actor: r.actor,
        targetType: r.target_type,
        targetId: r.target_id,
        meta: redactMeta(r.meta),
        traceId: r.trace_id,
        createdAt: r.created_at,
      })),
      total: totalCapped ? AUDIT_COUNT_CAP : raw,
      totalCapped,
      page,
      pageSize,
      countCap: AUDIT_COUNT_CAP,
    };
  }
}
