import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue, type Job } from 'bullmq';
import { sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { SweepAlarmService } from './sweep-alarm.service';

export const RETENTION_QUEUE = 'retention';

/** Saklama/budama taraması periyodu (ms) — GÜNLÜK (log/olay budaması dakikalık aciliyet taşımaz). */
const SWEEP_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * Her batch'te silinen/güncellenen azami satır. Tek dev DELETE ile milyon satır kilitlemek yerine
 * `ctid IN (SELECT ... LIMIT BATCH_SIZE)` döngüsüyle küçük kilit + statement_timeout dostu budama.
 */
const BATCH_SIZE = 5000;

/**
 * Sonsuz döngü koruması: bir tabloda tek koşuda en çok BATCH_SIZE×MAX_BATCHES satır işlenir
 * (5000×20000 = 100M/tablo/koşu tavanı — pratikte asla ulaşılmaz; bir bug batch'i küçültmezse
 * günlük iş sonsuza kilitlenmesin). Ulaşılırsa uyarı loglanır, kalan bir sonraki koşuya kalır.
 */
const MAX_BATCHES = 20000;

/** Bir saklama koşusunun sonuç özeti (görünürlük + elle-tetik yanıtı). */
export interface RetentionReport {
  /** fulfillment_events: N günden eski SİLİNEN satır. */
  fulfillmentEventsDeleted: number;
  /** outbox_events: status='delivered' VE N günden eski SİLİNEN satır. */
  outboxDeleted: number;
  /** security_events: N günden eski SİLİNEN satır. */
  securityEventsDeleted: number;
  /** email_log: N günden eski to_email MASKELENEN satır (KVKK — silinmez, maskelenir). */
  emailMasked: number;
  /** email_log: N günden eski SİLİNEN satır. */
  emailDeleted: number;
  /** audit_log: gürültü auto-reveal (meta.auto=true) N günden eski SİLİNEN satır. */
  auditRevealDeleted: number;
  /** audit_log: (yalnız RETENTION_AUDIT_ALL_DAYS set ise) N günden eski TÜM SİLİNEN satır. */
  auditAllDeleted: number;
}

/**
 * Saklama/budama motoru (§9 KVKK + §16 ops). Sınırsız büyüyen operasyonel tabloları (denetim/
 * mail/webhook-kuyruk/güvenlik/olay izleri) CÖMERT varsayılan pencerelerle batch'ler halinde budar.
 * BullMQ GÜNLÜK tekrarlı iş (kararlı schedulerId — expiry/reconcile deseni).
 *
 * TASARIM İLKELERİ:
 *  - VARSAYILANLAR CÖMERT + ConfigService ile env override (env yoksa varsayılan).
 *  - Batch delete (ctid + LIMIT) → uzun kilit/timeout yok; her batch AYRI komut.
 *  - UYUM KAYDI KORUNUR: audit_log'da yalnız GÜRÜLTÜ (auto-reveal) satırları silinir; GERÇEK
 *    denetim aksiyonları (revoke/replace/import/anonymize...) SİLİNMEZ (tam budama vars. KAPALI).
 *  - PII (§9): email_log.to_email 365g sonra MASKELENİR (silinmez), 730g sonra satır silinir.
 *    Maskeleme compliance.service.ts deseniyle tutarlı (yerel-kısım ilk 2 hane + domain korunur).
 *  - Teslim EDİLMEMİŞ/başarısız outbox'a DOKUNULMAZ (replay için gerekli) — yalnız 'delivered'.
 */
@Injectable()
export class RetentionService implements OnModuleInit {
  private readonly logger = new Logger(RetentionService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @InjectQueue(RETENTION_QUEUE) private readonly queue: Queue,
    private readonly config: ConfigService,
  ) {}

  /**
   * Boot'ta günlük tekrarlı budamayı KARARLI job-scheduler kimliğiyle upsert eder (BullMQ v5).
   * Periyot değişse bile eski zamanlama atomik değiştirilir (yetim mükerrer schedule kalmaz) —
   * expiry/reconcile ile aynı desen.
   */
  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'retention-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
    );
  }

  /** Pozitif tamsayı env okur (ConfigService); eksik/geçersizse varsayılana düşer. */
  private days(name: string, def: number): number {
    const v = this.config.get<string>(name);
    if (v === undefined || String(v).trim() === '') return def;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : def;
  }

  /**
   * Opsiyonel pozitif tamsayı env (varsayılanı YOK — set edilmezse null/kapalı). RETENTION_AUDIT_ALL_DAYS
   * gibi "yalnız bilinçli set edilirse çalışan" tehlikeli budamalar için.
   */
  private optionalDays(name: string): number | null {
    const v = this.config.get<string>(name);
    if (v === undefined || String(v).trim() === '') return null;
    const n = Number.parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /**
   * Tüm saklama politikalarını uygular ve tablo-bazlı sayaç özeti döndürür.
   * Her adım bağımsız batch döngüsüyle çalışır (bir tablonun hatası diğerini engellemesin diye
   * çağıran/processor best-effort ise korunur; burada adımlar seri — biri throw ederse üstteki
   * @OnWorkerEvent('failed') alarmı devreye girer).
   */
  async runRetention(): Promise<RetentionReport> {
    // --- Pencereler (gün) — CÖMERT varsayılan + env override ---
    const fulfillmentDays = this.days('RETENTION_FULFILLMENT_DAYS', 180);
    const outboxDays = this.days('RETENTION_OUTBOX_DAYS', 30);
    const securityDays = this.days('RETENTION_SECURITY_DAYS', 365);
    const emailMaskDays = this.days('RETENTION_EMAIL_MASK_DAYS', 365);
    const emailDeleteDays = this.days('RETENTION_EMAIL_DELETE_DAYS', 730);
    const auditRevealDays = this.days('RETENTION_AUDIT_REVEAL_DAYS', 90);
    const auditAllDays = this.optionalDays('RETENTION_AUDIT_ALL_DAYS'); // null = KAPALI (varsayılan)

    // (1) fulfillment_events — sipariş timeline'ı ~2×sipariş hızında büyür; N günden eski sil.
    const fulfillmentEventsDeleted = await this.pruneBatched(
      'fulfillment_events',
      sql`
        DELETE FROM fulfillment_events
        WHERE ctid IN (
          SELECT ctid FROM fulfillment_events
          WHERE created_at < now() - (${fulfillmentDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // (2) outbox_events — YALNIZ 'delivered' + N günden eski. Teslim edilmemiş/başarısız DOKUNULMAZ
    //     (replay için gerekli, §16 dead-letter).
    const outboxDeleted = await this.pruneBatched(
      'outbox_events',
      sql`
        DELETE FROM outbox_events
        WHERE ctid IN (
          SELECT ctid FROM outbox_events
          WHERE status = 'delivered'
            AND created_at < now() - (${outboxDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // (3) security_events — N günden eski sil (güvenlik/anomali izi; 1 yıl cömert).
    const securityEventsDeleted = await this.pruneBatched(
      'security_events',
      sql`
        DELETE FROM security_events
        WHERE ctid IN (
          SELECT ctid FROM security_events
          WHERE created_at < now() - (${securityDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // (4) email_log — PII (§9 KVKK). SIRA: önce SİL (≥emailDeleteDays), sonra MASKELE (≥emailMaskDays).
    //     Delete-first: silinecek (en eski) satırları önce kaldırırız → maskeleme onları BOŞUNA
    //     güncellemez (mask sonra sil = aynı satıra iki yazma). Son durum sıradan bağımsız aynıdır.
    const emailDeleted = await this.pruneBatched(
      'email_log(delete)',
      sql`
        DELETE FROM email_log
        WHERE ctid IN (
          SELECT ctid FROM email_log
          WHERE created_at < now() - (${emailDeleteDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // Maskeleme: yerel-kısmın ilk 2 hanesi + '***@' + domain (compliance.service.ts ile tutarlı yön).
    // İdempotans: zaten maskeli satır ('***@' içeren) atlanır → batch döngüsü sonlanır (maske sonrası
    // satır artık NOT LIKE '%***@%' yüklemine girmez) ve tekrar koşularda gereksiz yazma olmaz.
    const emailMasked = await this.pruneBatched(
      'email_log(mask)',
      sql`
        UPDATE email_log
        SET to_email = left(split_part(to_email, '@', 1), 2) || '***@' || split_part(to_email, '@', 2)
        WHERE ctid IN (
          SELECT ctid FROM email_log
          WHERE created_at < now() - (${emailMaskDays} * interval '1 day')
            AND to_email NOT LIKE '%***@%'
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // (5a) audit_log — YALNIZ gürültü: auto-reveal (sayfa/detay açılışında yazılan meta.auto=true
    //      görüntüleme izi). GERÇEK denetim aksiyonları (revoke/replace/import/anonymize/login...)
    //      SİLİNMEZ (uyum kaydı). Bu filtre admin-orders.service.ts'teki liste yükleminin aynısı.
    const auditRevealDeleted = await this.pruneBatched(
      'audit_log(auto-reveal)',
      sql`
        DELETE FROM audit_log
        WHERE ctid IN (
          SELECT ctid FROM audit_log
          WHERE action = 'reveal'
            AND meta->>'auto' = 'true'
            AND created_at < now() - (${auditRevealDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    // (5b) audit_log TAM budama — VARSAYILAN KAPALI. Yalnız RETENTION_AUDIT_ALL_DAYS set edilirse
    //      o kadar eski TÜM audit satırı silinir (uyum politikası bilinçli gevşetilirse). Gürültü
    //      budaması (5a) bundan bağımsız her zaman çalışır.
    let auditAllDeleted = 0;
    if (auditAllDays !== null) {
      auditAllDeleted = await this.pruneBatched(
        'audit_log(all)',
        sql`
          DELETE FROM audit_log
          WHERE ctid IN (
            SELECT ctid FROM audit_log
            WHERE created_at < now() - (${auditAllDays} * interval '1 day')
            LIMIT ${BATCH_SIZE}
          )
          RETURNING id;
        `,
      );
    }

    const report: RetentionReport = {
      fulfillmentEventsDeleted,
      outboxDeleted,
      securityEventsDeleted,
      emailMasked,
      emailDeleted,
      auditRevealDeleted,
      auditAllDeleted,
    };
    this.logger.log(
      `Saklama koşusu bitti: fulfillment=${fulfillmentEventsDeleted} sil, outbox=${outboxDeleted} sil, ` +
        `security=${securityEventsDeleted} sil, email=${emailMasked} maske/${emailDeleted} sil, ` +
        `audit auto-reveal=${auditRevealDeleted} sil` +
        (auditAllDays !== null ? `, audit tam=${auditAllDeleted} sil (${auditAllDays}g)` : ''),
    );
    return report;
  }

  /**
   * Verilen DELETE/UPDATE sorgusunu satır kalmayana dek BATCH'ler halinde çalıştırır. Her batch
   * `ctid IN (SELECT ... LIMIT BATCH_SIZE) RETURNING id` → dönen satır sayısı o batch'in etkisidir.
   * batch < BATCH_SIZE → tükendi, döngü durur. MAX_BATCHES tavanı sonsuz-döngü sigortasıdır.
   *
   * NOT: aynı SQL nesnesi her iterasyonda yeniden çalıştırılır — WHERE `now() - interval` (ve mask
   * için `NOT LIKE '%***@%'`) her batch'te taze değerlendiği için sonraki batch DAHA AZ satır bulur
   * ve döngü kesin sonlanır (drizzle SQL descriptor'ı immutable; yeniden-execute güvenli).
   */
  private async pruneBatched(label: string, query: SQL): Promise<number> {
    let total = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const rows = await rawRows<{ id: string }>(this.db, query);
      const n = rows.length;
      total += n;
      if (n < BATCH_SIZE) break;
      if (i === MAX_BATCHES - 1) {
        this.logger.warn(
          `Budama [${label}] MAX_BATCHES(${MAX_BATCHES}) tavanına ulaştı — kalan satır bir sonraki koşuya kaldı.`,
        );
      }
    }
    if (total > 0) this.logger.log(`Budama [${label}]: ${total} satır işlendi`);
    return total;
  }
}

/**
 * Tekrarlı saklama/budama işini çalıştırır (§9/§16). ExpiryProcessor/ReconcileProcessor deseniyle
 * aynı; @OnWorkerEvent('failed') ile başarısızlık SESSİZCE ölmez → SweepAlarmService kritik alarmı.
 */
@Processor(RETENTION_QUEUE)
export class RetentionProcessor extends WorkerHost {
  constructor(
    private readonly retention: RetentionService,
    private readonly alarm: SweepAlarmService,
  ) {
    super();
  }

  async process(_job: Job): Promise<RetentionReport> {
    return this.retention.runRetention();
  }

  /** İş patlarsa kritik alarm (dedupe'lu) + logger.error — sessiz ölüm bitti (§16). */
  @OnWorkerEvent('failed')
  async onFailed(job: Job, err: Error): Promise<void> {
    await this.alarm.report(RETENTION_QUEUE, job?.name ?? 'sweep', err);
  }
}
