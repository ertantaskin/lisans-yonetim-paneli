import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { Queue } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { NotificationsService } from '../notifications/notifications.service';
import { SweepAlarmService } from './sweep-alarm.service';

export const RECONCILE_QUEUE = 'reconcile';

/**
 * Mutabakat/tutarlılık denetimi periyodu (ms). Süre-bitişi taramasının aksine tam
 * tablo taraması olduğu için daha seyrek çalışır (kritik veri bozulması saatler değil
 * dakikalar içinde görünür ama 5 dk'lık sweep israfı olur). §16.
 */
const SWEEP_EVERY_MS = 15 * 60 * 1000;

/**
 * Kritik bildirim (Telegram) dedupe penceresi (saat). Mutabakat İHLALLERİ DÜZELTİLMEZ (§16) →
 * kalıcı bir ihlal her 15dk sweep'te aksi halde ~96 özdeş kritik alarm üretir.
 *
 * DİKKAT — dedupe ARTIK "türe bakmadan sustur" DEĞİL, İHLAL PARMAK İZİNE bağlıdır
 * (bkz. violationFingerprint). Eskiden pencere içindeki HERHANGİ bir 'reconcile_violation'
 * bildirimi yeni alarmları 12 saat boyunca susturuyordu → ilk (belki önemsiz) sayaç sapmasından
 * sonra ortaya çıkan YENİ bir ÇİFTE SATIŞ ihlali panelde/Telegram'da 12 saat HİÇ görünmüyordu.
 * Artık yalnız AYNI ihlal kümesi susturulur; küme değişirse (yeni ihlal, yeni kayıt, tür
 * değişimi) pencere içinde de yeni kritik alarm üretilir.
 *
 * logger.error dedupe'a TABİ DEĞİL — her sweep'te çalışır (gözlemlenebilirlik korunur).
 */
const NOTIFY_DEDUPE_WINDOW_HOURS = 12;

/**
 * "Ayakta" (canlı) atama statüleri — teslimatı hâlâ temsil edenler. fulfilled_qty ve
 * tek-kullanım işgali BUNLARI sayar. revoke fulfilled_qty'yi düşürür (§2 iade); replace
 * eskisini net'ler → ikisi de hariç. suspend/expire fulfilled_qty'ye DOKUNMAZ (§4 geri
 * alınabilir gizleme, §2 "hak geri gelmez") → sayıma DAHİL. Bu yüzden mutabakat yalnız
 * status='active' saysaydı her suspend/expire yanlış-pozitif kritik alarm üretirdi.
 */
const STANDING_STATUSES = sql`('active', 'suspended', 'expired')`;

/** SICAK-yol pencere varsayılanı (gün) — env RECONCILE_WINDOW_DAYS ile geçersiz kılınır. */
const RECONCILE_WINDOW_DAYS_DEFAULT = 30;

/**
 * SICAK-yol pencere yüklemi (§16 ölçek). RECONCILE_FULL=true ise BOŞ döner (TAM tablo taraması);
 * aksi halde `AND <createdAt> > now() - (windowDays * interval '1 day')` → son N günü tarar.
 * Env (`process.env`) ile okunur → ReconcileService ctor imzası DEĞİŞMEZ (mevcut testler korunur).
 *
 * CORRECTNESS NOTU (bilinçli sınır): pencere yalnız SICAK yolu (line_fulfillment/single_occupancy)
 * son N güne daraltır → çok eski kayıtlarda teorik bir drift (ör. 30 günden eski bir çifte-satış,
 * her iki atama da eskiyse) bu koşuda KAÇABİLİR. Karşı-önlemler: (1) YENİ ihlaller her zaman
 * pencerede oluşur (drift satış anında, taze kayıtta yakalanır); (2) haftalık/aylık TAM mutabakat
 * için `RECONCILE_FULL=true` ile pencere kaldırılıp elle (POST /admin/maintenance/reconcile) veya
 * ayrı bir cron ile tetiklenmeli. TODO(ops): haftalık RECONCILE_FULL tam koşu zamanlaması ekle.
 * multi_capacity pencereye TABİ DEĞİL (license_items üzerinde ucuz filtreli tarama, GROUP BY yok).
 */
function recentFilter(createdAt: SQL): SQL {
  if (process.env.RECONCILE_FULL === 'true') return sql``;
  const raw = process.env.RECONCILE_WINDOW_DAYS;
  const parsed = raw && raw.trim() !== '' ? Number.parseInt(raw, 10) : NaN;
  const days = Number.isFinite(parsed) && parsed > 0 ? parsed : RECONCILE_WINDOW_DAYS_DEFAULT;
  return sql`AND ${createdAt} > now() - (${days} * interval '1 day')`;
}

/** Denetim ihlali — düzeltme yapılmaz, yalnız raporlanır ve kritik loglanır (§16). */
export type ReconcileViolation =
  | {
      check: 'multi_capacity';
      licenseItemId: string;
      useCount: number;
      maxUses: number;
    }
  | {
      check: 'line_fulfillment';
      lineId: string;
      orderId: string;
      fulfilledQty: number;
      standingUnits: number;
    }
  | {
      check: 'single_occupancy';
      licenseItemId: string;
      standingAssignments: number;
    };

export interface ReconcileReport {
  /** Denetlenen kayıt sayısı (üç denetimin nüfus toplamı). */
  checked: number;
  violations: ReconcileViolation[];
}

/** İhlalin kimliği: tür + ihlal eden kaydın id'si (sayaç DEĞERLERİ hariç — aşağıya bakın). */
function violationKey(v: ReconcileViolation): string {
  switch (v.check) {
    case 'multi_capacity':
      return `multi_capacity:${v.licenseItemId}`;
    case 'single_occupancy':
      return `single_occupancy:${v.licenseItemId}`;
    case 'line_fulfillment':
      return `line_fulfillment:${v.lineId}`;
  }
}

/**
 * İhlal KÜMESİNİN parmak izi (sha256, kısa). Dedupe bunun üzerinden yapılır: küme aynıysa
 * pencere boyunca tek alarm, küme değiştiyse (yeni/kaybolan ihlal, yeni tür) hemen yeni alarm.
 *
 * Sıralama deterministiktir (sort) → aynı ihlaller farklı SQL satır sırasında gelse bile aynı
 * parmak izi üretilir (aksi halde her sweep "yeni küme" sanılıp dedupe hiç çalışmazdı).
 *
 * SAYAÇ DEĞERLERİ (use_count/fulfilled_qty…) BİLİNÇLİ OLARAK DIŞARIDA: aynı bozuk kaydın sayacı
 * her satışta bir artarsa parmak izi de değişir ve dedupe yine spam'e dönerdi. Kimlik kümesi
 * değiştiği an — ki YENİ bir çifte satış her zaman yeni bir id ekler — alarm zaten üretilir.
 */
function violationFingerprint(violations: ReconcileViolation[]): string {
  const keys = violations.map(violationKey).sort();
  return createHash('sha256').update(keys.join('|'), 'utf8').digest('hex').slice(0, 32);
}

/**
 * Mutabakat/tutarlılık denetçisi (§16). Bağımsız kaynakları (sayaç kolonları ↔ atamalar)
 * karşılaştırıp değişmezleri doğrular; İHLAL bulursa DÜZELTMEZ, yalnız kritik loglar ve
 * rapora yazar (elle inceleme + kök-neden analizi için). Otomatik düzeltme bir bug'ı
 * gizleyebileceğinden bilinçli olarak yapılmaz.
 *
 * Denetimler:
 *  (a) multi_capacity   — multi license_item: use_count ≤ max_uses (kapasite aşımı → çifte satış).
 *  (b) line_fulfillment — order_line.fulfilled_qty = Σ(ayakta atama units) (sayaç sapması).
 *  (c) single_occupancy — tek-kullanım (max_uses=1) license_item başına ≤1 ayakta atama (çifte satış).
 */
@Injectable()
export class ReconcileService implements OnModuleInit {
  private readonly logger = new Logger(ReconcileService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(RECONCILE_QUEUE) private readonly queue: Queue,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Boot'ta tekrarlı denetimi KARARLI job-scheduler kimliğiyle upsert eder (BullMQ v5).
   * Periyot ileride değişirse eski zamanlama atomik değiştirilir — `queue.add` repeat'in
   * aksine ortada yetim (mükerrer) schedule kalmaz. schedulerId sabit → tekilleştirme garantili.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'reconcile-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
  }

  /**
   * Üç tutarlılık denetimini çalıştırır; ihlalleri kritik loglar ve özet döndürür.
   * @returns { checked, violations } — düzeltme YAPILMAZ (§16).
   */
  async reconcile(): Promise<ReconcileReport> {
    const violations: ReconcileViolation[] = [];
    let checked = 0;

    checked += await this.checkMultiCapacity(violations);
    checked += await this.checkLineFulfillment(violations);
    checked += await this.checkSingleOccupancy(violations);

    if (violations.length > 0) {
      this.logger.error(
        `Mutabakat: ${violations.length} İHLAL bulundu (${checked} kayıt denetlendi) — elle inceleme gerekli`,
      );
      // Kritik alarm yolu (§16): logger.error tek başına gözlemlenebilir değil (kimse tail'lemiyorsa
      // çifte-satış ihlali sessiz kalır). severity 'critical' bildirim NotificationsService üzerinden
      // env-gated Telegram'a düşer. Bildirim best-effort — mutabakat sonucunu KESMEZ.
      await this.notify(checked, violations);
    } else {
      this.logger.log(`Mutabakat temiz: ${checked} kayıt, ihlal yok`);
    }
    return { checked, violations };
  }

  /**
   * Mutabakat ihlallerini kritik bildirime çevirir (§16 alarm yolu). NotificationsService.create
   * severity 'critical' → env-gated Telegram'a düşer. GİZLİLİK: mesaj (Telegram'a giden) yalnız
   * SAYAÇ içerir; iç kayıt id'leri sır/PII değildir ve yalnız DB'de kalan meta'ya yazılır (Telegram
   * gövdesi meta'yı taşımaz). payload/e-posta/key ASLA konmaz. Best-effort: bildirim hatası yutulur
   * (mutabakat çıktısı zaten döndürülür + kritik loglandı).
   *
   * DEDUPE (parmak-izi bazlı): sweep her 15dk çalışır ve ihlalleri DÜZELTMEZ → kalıcı bir ihlal
   * dedupe olmadan ~96 özdeş kritik Telegram alarmı/gün üretir. Bu yüzden pencerede AYNI PARMAK
   * İZLİ ('reconcile_violation' + meta.fingerprint) bildirim varsa create/Telegram push atlanır.
   * Küme DEĞİŞİRSE (yeni ihlal eklendi/çıktı, tür değişti) parmak izi de değişir → pencere içinde
   * de alarm üretilir; yani yeni bir çifte-satış ihlali ASLA 12 saat gizlenmez.
   *
   * NEDEN "kapasite/çifte-satış ihlallerinde dedupe'u tamamen atla" DEĞİL: o yaklaşım kalıcı tek
   * bir ihlalde günde ~96 özdeş kritik alarm üretip alarm körlüğü yaratırdı. Parmak izi, aranan
   * güvenceyi (YENİ ihlal hemen görünür) spam üretmeden sağlar.
   *
   * logger.error yine her sweep'te çalışır (reconcile() içinde) — yalnız bildirim/Telegram kadansı kısılır.
   */
  private async notify(checked: number, violations: ReconcileViolation[]): Promise<void> {
    // Denetim başına kırılım (özet mesaj + meta için).
    const byCheck: Record<ReconcileViolation['check'], number> = {
      multi_capacity: 0,
      line_fulfillment: 0,
      single_occupancy: 0,
    };
    for (const v of violations) byCheck[v.check] += 1;

    const fingerprint = violationFingerprint(violations);

    try {
      // Dedupe penceresi kontrolü: yakın zamanda AYNI parmak izli bildirim varsa Telegram spam'i önle.
      // meta->>'fingerprint' karşılaştırması: parmak izi taşımayan ESKİ kayıtlar eşleşmez → sürüm
      // geçişinden sonraki ilk sweep bir kez alarm üretebilir (bilinçli, güvenli yön).
      const recent = await rawRows<{ exists: boolean }>(this.db, sql`
        SELECT EXISTS (
          SELECT 1 FROM notifications
          WHERE type = 'reconcile_violation'
            AND created_at > now() - (${NOTIFY_DEDUPE_WINDOW_HOURS} * interval '1 hour')
            AND meta->>'fingerprint' = ${fingerprint}
        ) AS exists;
      `);
      if (recent[0]?.exists) {
        this.logger.warn(
          `Mutabakat bildirimi dedupe: son ${NOTIFY_DEDUPE_WINDOW_HOURS} saatte AYNI ihlal kümesi ` +
            `(fingerprint=${fingerprint.slice(0, 8)}) zaten bildirildi — kritik alarm/Telegram push ` +
            `atlandı (logger.error her sweep'te sürüyor; küme değişirse yeni alarm üretilir)`,
        );
        return;
      }

      await this.notifications.create({
        type: 'reconcile_violation',
        severity: 'critical',
        title: 'Mutabakat ihlali (tutarlılık denetimi)',
        // Telegram'a gider → yalnız sayaç/kırılım, sır/PII yok.
        message:
          `${violations.length} tutarlılık ihlali bulundu (${checked} kayıt denetlendi) — elle inceleme gerekli. ` +
          `Kapasite aşımı=${byCheck.multi_capacity}, sayaç sapması=${byCheck.line_fulfillment}, ` +
          `tek-kullanım çift atama=${byCheck.single_occupancy}.`,
        // meta yalnız DB'de saklanır (Telegram'a gitmez) → kök-neden için iç kayıt id'leri + sayaçlar.
        // fingerprint dedupe anahtarıdır: bir sonraki sweep bu değerle karşılaştırma yapar.
        meta: { checked, total: violations.length, byCheck, violations, fingerprint },
      });
    } catch (err) {
      this.logger.warn(
        `Mutabakat bildirimi üretilemedi (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * (a) multi_capacity — çok kullanımlık key kapasite aşımı. use_count > max_uses ise
   * atomik kapasite guard'ı (§2) delinmiş demektir → olası çifte satış.
   * @returns denetlenen multi license_item sayısı
   */
  private async checkMultiCapacity(out: ReconcileViolation[]): Promise<number> {
    const rows = await rawRows<{
      license_item_id: string;
      use_count: number;
      max_uses: number;
    }>(this.db, sql`
      SELECT li.id AS license_item_id, li.use_count AS use_count, li.max_uses AS max_uses
      FROM license_items li
      JOIN products p ON p.id = li.product_id
      WHERE p.usage_mode = 'multi'
        AND li.use_count > li.max_uses;
    `);
    for (const r of rows) {
      const useCount = Number(r.use_count);
      const maxUses = Number(r.max_uses);
      out.push({ check: 'multi_capacity', licenseItemId: r.license_item_id, useCount, maxUses });
      this.logger.error(
        `Mutabakat İHLALİ [multi_capacity]: license_item=${r.license_item_id} ` +
          `use_count=${useCount} > max_uses=${maxUses} (kapasite aşımı — olası çifte satış)`,
      );
    }
    return await this.count(sql`
      SELECT count(*)::int AS c
      FROM license_items li
      JOIN products p ON p.id = li.product_id
      WHERE p.usage_mode = 'multi';
    `);
  }

  /**
   * (b) line_fulfillment — sipariş satırı sayacı ↔ atamalar mutabakatı.
   * fulfilled_qty, ayakta (STANDING) atamaların units toplamına eşit olmalı.
   * Sapma; teslim edilmemiş/çifte sayılmış birim ya da atlanan revoke düşümü demektir.
   * @returns denetlenen sipariş satırı sayısı
   */
  private async checkLineFulfillment(out: ReconcileViolation[]): Promise<number> {
    const rows = await rawRows<{
      line_id: string;
      order_id: string;
      fulfilled_qty: number;
      standing_units: number;
    }>(this.db, sql`
      SELECT
        ol.id AS line_id,
        ol.order_id AS order_id,
        ol.fulfilled_qty AS fulfilled_qty,
        COALESCE(SUM(a.units) FILTER (WHERE a.status IN ${STANDING_STATUSES}), 0)::int AS standing_units
      FROM order_lines ol
      LEFT JOIN assignments a ON a.line_id = ol.id
      WHERE true ${recentFilter(sql`ol.created_at`)}
      GROUP BY ol.id, ol.order_id, ol.fulfilled_qty
      HAVING ol.fulfilled_qty
        <> COALESCE(SUM(a.units) FILTER (WHERE a.status IN ${STANDING_STATUSES}), 0);
    `);
    for (const r of rows) {
      const fulfilledQty = Number(r.fulfilled_qty);
      const standingUnits = Number(r.standing_units);
      out.push({
        check: 'line_fulfillment',
        lineId: r.line_id,
        orderId: r.order_id,
        fulfilledQty,
        standingUnits,
      });
      this.logger.error(
        `Mutabakat İHLALİ [line_fulfillment]: line=${r.line_id} order=${r.order_id} ` +
          `fulfilled_qty=${fulfilledQty} <> Σ(ayakta atama units)=${standingUnits} (sayaç sapması)`,
      );
    }
    // `checked` sayacı da SICAK-yol penceresini yansıtır (dürüst rapor: kaç satır GERÇEKTEN tarandı).
    return await this.count(sql`
      SELECT count(*)::int AS c FROM order_lines ol
      WHERE true ${recentFilter(sql`ol.created_at`)};
    `);
  }

  /**
   * (c) single_occupancy — tek-kullanım (max_uses=1) license_item başına en çok 1 ayakta
   * atama olmalı. >1 ise atomik SELECT ... FOR UPDATE SKIP LOCKED atama (§2) delinmiş →
   * aynı key iki kez satılmış demektir.
   * @returns denetlenen tek-kullanım license_item sayısı
   */
  private async checkSingleOccupancy(out: ReconcileViolation[]): Promise<number> {
    const rows = await rawRows<{
      license_item_id: string;
      standing_assignments: number;
    }>(this.db, sql`
      SELECT a.license_item_id AS license_item_id, COUNT(*)::int AS standing_assignments
      FROM assignments a
      JOIN license_items li ON li.id = a.license_item_id
      WHERE li.max_uses = 1
        AND a.status IN ${STANDING_STATUSES}
        ${recentFilter(sql`a.created_at`)}
      GROUP BY a.license_item_id
      HAVING COUNT(*) > 1;
    `);
    for (const r of rows) {
      const standingAssignments = Number(r.standing_assignments);
      out.push({
        check: 'single_occupancy',
        licenseItemId: r.license_item_id,
        standingAssignments,
      });
      this.logger.error(
        `Mutabakat İHLALİ [single_occupancy]: license_item=${r.license_item_id} ` +
          `ayakta_atama=${standingAssignments} > 1 (tek-kullanım çift atama — çifte satış)`,
      );
    }
    // `checked` sayacı taranan AYAKTA tek-kullanım atamalarını yansıtır (scan ile aynı pencere/yüklem)
    // → dürüst rapor. Eski sürümdeki "tüm tek-kullanım license_item sayısı" yerine gerçekten
    // denetlenen satır kümesi sayılır (ihlal TESPİTİ değişmez; yalnız `checked` bilgi sayacı).
    return await this.count(sql`
      SELECT count(*)::int AS c
      FROM assignments a
      JOIN license_items li ON li.id = a.license_item_id
      WHERE li.max_uses = 1
        AND a.status IN ${STANDING_STATUSES}
        ${recentFilter(sql`a.created_at`)};
    `);
  }

  /** Tek satırlık count(*)::int sorgusunu çalıştırıp sayıyı döndürür. */
  private async count(query: SQL): Promise<number> {
    const list = await rawRows<{ c: number }>(this.db, query);
    return Number(list[0]?.c ?? 0);
  }
}

/** Tekrarlı mutabakat denetimini çalıştırır (§16). ExpiryProcessor deseniyle aynı. */
@Processor(RECONCILE_QUEUE)
export class ReconcileProcessor extends WorkerHost {
  constructor(
    private readonly reconcile: ReconcileService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ checked: number; violations: number }> {
    const report = await this.reconcile.reconcile();
    return { checked: report.checked, violations: report.violations.length };
  }

  /**
   * İş patlarsa kritik alarm (dedupe'lu) + logger.error — sessiz ölüm bitti (§16). Bu, İHLAL
   * alarmından (reconcile() içi, veri tutarsızlığı) AYRIDIR: burada işin KENDİSİ patlar (DB
   * erişimi/timeout) → tutarlılık denetimi HİÇ koşamaz, o yüzden ayrı 'sweep_failed' türü.
   */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(RECONCILE_QUEUE, job?.name ?? 'sweep', err);
  }
}
