import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue, type Job } from 'bullmq';
import { inArray, sql, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { pluginReleases } from '../db/schema';
import { compareVersions } from '../updates/updates.service';
import { SweepAlarmService } from './sweep-alarm.service';
import { upsertSoleJobScheduler } from '../queue/sole-scheduler';

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
  /**
   * supplier_claim_items: KAPANMIŞ fişte N günden eski `key_snapshot` MASKELENEN satır.
   * Satır SİLİNMEZ (fiş izi ve tedarikçi karnesi korunur) — yalnız düz metin anahtar silinir.
   */
  claimKeysMasked: number;
  /** audit_log: gürültü auto-reveal (meta.auto=true) N günden eski SİLİNEN satır. */
  auditRevealDeleted: number;
  /** audit_log: (yalnız RETENTION_AUDIT_ALL_DAYS set ise) N günden eski TÜM SİLİNEN satır. */
  auditAllDeleted: number;
  /** notifications: OKUNMUŞ (read_at dolu) VE N günden eski SİLİNEN satır. */
  notificationsDeleted: number;
  /**
   * notifications: (yalnız RETENTION_NOTIFICATION_ALL_DAYS set ise) N günden eski
   * OKUNMAMIŞ satırlar dahil TÜM SİLİNEN satır.
   */
  notificationsAllDeleted: number;
  /** deployments: TAMAMLANMIŞ (success/failed) VE N günden eski SİLİNEN satır. */
  deploymentsDeleted: number;
  /** site_connect_tokens: tüketilmiş VEYA süresi çoktan geçmiş SİLİNEN satır. */
  connectTokensDeleted: number;
  /**
   * plugin_releases: gövdesi (zip_b64) ARŞİVDEN DÜŞÜRÜLEN sürüm sayısı. Satır SİLİNMEZ —
   * sürüm geçmişi panelde görünür kalır (kullanıcının açıkça istediği özellik); yalnız .zip
   * base64 gövdesi boşaltılır.
   */
  pluginZipsArchived: number;
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
    await upsertSoleJobScheduler(
      this.queue,
      'retention-sweep',
      { every: SWEEP_EVERY_MS },
      { name: 'sweep', data: {}, opts: { removeOnComplete: 50, removeOnFail: 50 } },
      this.logger,
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
    const notificationDays = this.days('RETENTION_NOTIFICATION_DAYS', 180);
    const notificationAllDays = this.optionalDays('RETENTION_NOTIFICATION_ALL_DAYS'); // null = KAPALI
    const deploymentDays = this.days('RETENTION_DEPLOYMENT_DAYS', 365);
    const connectTokenDays = this.days('RETENTION_CONNECT_TOKEN_DAYS', 7);
    // Kapanmış tedarikçi fişinde düz metin anahtarın maskeleneceği yaş (varsayılan 1 yıl:
    // uyuşmazlık penceresi kapandıktan sonra kanıt metnine ihtiyaç kalmaz).
    const claimKeyMaskDays = this.days('RETENTION_CLAIM_KEY_MASK_DAYS', 365);

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
    //
    // KVKK anonimleştirmesi (compliance.service.anonymize) HARİÇ tutulur: o yol e-postayı
    // `anon-<sha256[0..12]>@redacted.invalid` DETERMİNİSTİK takma adına çevirir ve bunu bilinçli
    // yapar ("aynı kişi = aynı maske → satır ilişkisi izlenebilir kalır"). O satır zaten PII
    // TAŞIMAZ; buradaki maske onu `an***@redacted.invalid`e çevirip takma ad bağını (ve dolayısıyla
    // unutulma-hakkı sonrası kalan operasyonel izlenebilirliği) GERİ DÖNÜŞSÜZ yok ederdi.
    const emailMasked = await this.pruneBatched(
      'email_log(mask)',
      sql`
        UPDATE email_log
        SET to_email = left(split_part(to_email, '@', 1), 2) || '***@' || split_part(to_email, '@', 2)
        WHERE ctid IN (
          SELECT ctid FROM email_log
          WHERE created_at < now() - (${emailMaskDays} * interval '1 day')
            AND to_email NOT LIKE '%***@%'
            AND to_email NOT LIKE '%@redacted.invalid'
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    /*
     * (4c) supplier_claim_items.key_snapshot — KAPANMIŞ fişlerde DÜZ METİN anahtarın temizlenmesi.
     *
     * Bu kolon, tedarikçiye gönderilen raporun kanıtı olsun diye ölü anahtarın DÜZ METİN anlık
     * görüntüsünü tutar (kasıtlı: fiş bir ay sonra da birebir aynı dosyayı vermeli). Ama
     * `license_items.payload_enc` ŞİFRELİYKEN bu kolon şifresizdir ve hiç budanmıyordu → düz
     * metin lisans değerleri veritabanında SÜRESİZ birikiyordu (yedeklerde de). Asimetri gerçek
     * bir maruziyet: aynı sırrın bir kopyası korumasız duruyor.
     *
     * TASARIM: satır SİLİNMEZ (fiş izi, tedarikçi karnesi ve "bu anahtar bildirildi mi?"
     * yüklemi bozulmamalı) — yalnız KAPANMIŞ (closed/canceled) fişlerin N günden eski
     * kalemlerinde anahtar metni maskeye çevrilir. Açık fişe DOKUNULMAZ: rapor hâlâ indirilebilir
     * olmalı. İdempotans: maskelenen satır bir daha yükleme girmez (LIKE süzgeci).
     */
    const claimKeysMasked = await this.pruneBatched(
      'supplier_claim_items(key mask)',
      sql`
        UPDATE supplier_claim_items
        SET key_snapshot = '[saklama süresi doldu]'
        WHERE ctid IN (
          SELECT sci.ctid FROM supplier_claim_items sci
          JOIN supplier_claims sc ON sc.id = sci.claim_id
          WHERE sc.status IN ('closed', 'canceled')
            AND coalesce(sc.closed_at, sc.created_at) < now() - (${claimKeyMaskDays} * interval '1 day')
            AND sci.key_snapshot IS NOT NULL
            AND sci.key_snapshot <> '[saklama süresi doldu]'
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

    /*
     * (6) notifications — düşük-stok taraması (30dk) + günlük özet sürekli satır yazar;
     *     yılda binlerce satır birikir ve HİÇ budanmıyordu. YALNIZ OKUNMUŞ (read_at dolu)
     *     ve N günden eski satırlar silinir: okunmamış bir uyarıyı silmek, operatörün HİÇ
     *     görmediği bir alarmı sessizce yok etmek olurdu (bu projede "sessiz kayıp" yasak).
     *     Partial index `notifications_unread_idx` okunmamışları kapsar; buradaki yüklem
     *     ise `notifications_created_idx` üzerinden ilerler.
     */
    const notificationsDeleted = await this.pruneBatched(
      'notifications',
      sql`
        DELETE FROM notifications
        WHERE ctid IN (
          SELECT ctid FROM notifications
          WHERE read_at IS NOT NULL
            AND created_at < now() - (${notificationDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    /*
     * (6b) notifications TAM budama — VARSAYILAN KAPALI (audit_log 5b deseni).
     *      Okunmamış bildirimler hiç okunmazsa (6) onları asla silmez → tablo yine de
     *      büyümeye devam eder. Bu kapı, operatörün bilinçli olarak "N günden eski her
     *      bildirimi at" demesi içindir; açılmadıkça okunmamış uyarı KAYBOLMAZ.
     */
    let notificationsAllDeleted = 0;
    if (notificationAllDays !== null) {
      notificationsAllDeleted = await this.pruneBatched(
        'notifications(all)',
        sql`
          DELETE FROM notifications
          WHERE ctid IN (
            SELECT ctid FROM notifications
            WHERE created_at < now() - (${notificationAllDays} * interval '1 day')
            LIMIT ${BATCH_SIZE}
          )
          RETURNING id;
        `,
      );
    }

    /*
     * (7) deployments — satır başına `log` alanı 20.000 karaktere kadar çıkabilir (deploy.sh
     *     çıktısının kuyruğu) → az satırla bile disk/yedek boyutunu büyütür.
     *
     *     KRİTİK: 'pending'/'running' satırlara ASLA DOKUNULMAZ. Bu tablo "aynı anda tek
     *     aktif dağıtım" kilidinin kendisidir (request/claim bekleyen işi burada arar) ve
     *     runner claim'i buradan okur; aktif bir satırı silmek koşan bir dağıtımın sonucunu
     *     yazamaz hale getirir. Bu yüzden BEYAZ LİSTE (`IN ('success','failed')`) kullanılır:
     *     ileride yeni bir ara durum eklenirse (NOT IN yazımının aksine) otomatik olarak
     *     KORUNUR — yanlış tarafa düşen hata sessiz veri kaybı olurdu.
     *
     *     DİKKAT (pencereyi kısaltacak operatöre): yedek/tatbikat geçmişi de BU tabloda durur
     *     (`deployments.backupSummary`, target 'backup'/'backup-drill' — ayrı tablo AÇILMADI).
     *     Pencereyi tatbikat aralığının ALTINA çekmek son BAŞARILI tatbikat kaydını siler →
     *     panel "hiç tatbikat yok" der ve `drill_stale` alarmı yanlış yere ateşler. 365 gün
     *     varsayılanı bilerek cömerttir.
     */
    const deploymentsDeleted = await this.pruneBatched(
      'deployments',
      sql`
        DELETE FROM deployments
        WHERE ctid IN (
          SELECT ctid FROM deployments
          WHERE status IN ('success', 'failed')
            AND created_at < now() - (${deploymentDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    /*
     * (8) site_connect_tokens — tek-seferlik onboarding kodu (§14). Tüketilen/süresi geçen
     *     satırlar şifreli creds'i null'lansa da SATIR OLARAK kalıyordu; hiç budanmıyordu.
     *
     *     ONBOARDING AKIŞI KIRILMAZ: iki dal da PENCERE İLE korunur — canlı bir kod (15dk
     *     TTL, tüketilmemiş) hiçbir dala girmez. Tüketilmiş kod zaten tek kullanımlıktır
     *     (claim idempotent değil, yeniden kullanılamaz) → silinmesi davranışı değiştirmez.
     */
    const connectTokensDeleted = await this.pruneBatched(
      'site_connect_tokens',
      sql`
        DELETE FROM site_connect_tokens
        WHERE ctid IN (
          SELECT ctid FROM site_connect_tokens
          WHERE (
                  consumed_at IS NOT NULL
                  AND consumed_at < now() - (${connectTokenDays} * interval '1 day')
                )
             OR expires_at < now() - (${connectTokenDays} * interval '1 day')
          LIMIT ${BATCH_SIZE}
        )
        RETURNING id;
      `,
    );

    const pluginZipsArchived = await this.archivePluginZips(
      this.days('RETENTION_PLUGIN_RELEASE_KEEP', 20),
    );

    const report: RetentionReport = {
      fulfillmentEventsDeleted,
      outboxDeleted,
      securityEventsDeleted,
      emailMasked,
      emailDeleted,
      claimKeysMasked,
      auditRevealDeleted,
      auditAllDeleted,
      notificationsDeleted,
      notificationsAllDeleted,
      deploymentsDeleted,
      connectTokensDeleted,
      pluginZipsArchived,
    };
    this.logger.log(
      `Saklama koşusu bitti: fulfillment=${fulfillmentEventsDeleted} sil, outbox=${outboxDeleted} sil, ` +
        `security=${securityEventsDeleted} sil, email=${emailMasked} maske/${emailDeleted} sil, ` +
        `fis anahtari=${claimKeysMasked} maske, ` +
        `audit auto-reveal=${auditRevealDeleted} sil` +
        (auditAllDays !== null ? `, audit tam=${auditAllDeleted} sil (${auditAllDays}g)` : '') +
        `, bildirim=${notificationsDeleted} sil` +
        (notificationAllDays !== null
          ? `, bildirim tam=${notificationsAllDeleted} sil (${notificationAllDays}g)`
          : '') +
        `, dagitim=${deploymentsDeleted} sil, baglan-kodu=${connectTokensDeleted} sil` +
        `, eklenti-paketi=${pluginZipsArchived} arsiv`,
    );
    return report;
  }

  /**
   * plugin_releases: EN YENİ `keep` sürümün DIŞINDA kalanların .zip gövdesini boşaltır.
   *
   * NEDEN (ÖLÇÜLDÜ): eklenti paketleri base64 olarak DB'de tutuluyor (bilinçli mimari karar) ve
   * bu tablo saklama kapsamında DEĞİLDİ → her yayınla kalıcı ~108 KB büyüyor. Prod'da 18 yayının
   * gövdesi 1947 kB, gecelik yedek dosyası ise 1,1 MB: yani YEDEĞİN NEREDEYSE TAMAMI tarihî
   * eklenti zip'leri. Dış kopya (offsite) henüz kurulmadığı ve DR hedefi RPO≤5dk/RTO≤2sa olduğu
   * için yedeği ince tutmanın somut değeri var.
   *
   * SATIR SİLİNMEZ: yalnız gövde boşaltılır. Sürüm geçmişinin panelde görünür kalması kullanıcının
   * açıkça istediği bir özellik; ayrıca `latest()` yalnız meta kolonları okur, yani güncelleme
   * denetçisi bundan etkilenmez.
   *
   * EN YÜKSEK SEMVER HER HÂLÜKÂRDA KORUNUR: müşteri siteleri güncellemede TAM O paketi indirir.
   * `created_at` sıralaması tek başına yetmez — sırasız yayında (1.4.0'dan sonra hotfix 1.3.9)
   * en yeni KAYIT ile en yüksek SÜRÜM farklı satırlar olabilir; `latest()` semver'e baktığı için
   * yalnız tarihe güvenmek CANLI güncelleme paketini silebilirdi.
   *
   * VARSAYILAN 20: bugünkü 18 yayında TAM NO-OP (davranış değişmez), yani değişiklik canlıya
   * risksiz gider ve ancak ileride devreye girer. Geri alma derinliği olarak da fazlasıyla yeterli.
   */
  private async archivePluginZips(keep: number): Promise<number> {
    // Yalnız meta + gövdesi DOLU satırlar (arşivlenmişler tekrar işlenmesin → idempotent).
    const rows = await rawRows<{ id: string; version: string }>(
      this.db,
      sql`
        SELECT id, version FROM plugin_releases
         WHERE zip_b64 <> ''
         ORDER BY created_at DESC, id DESC
      `,
    );
    if (rows.length <= keep) return 0;

    const keepIds = new Set(rows.slice(0, keep).map((r) => r.id));
    const newest = rows.reduce((best, r) => (compareVersions(r.version, best.version) > 0 ? r : best));
    keepIds.add(newest.id); // semver-en-yüksek: canlı güncelleme paketi ASLA arşivlenmez
    const doomed = rows.filter((r) => !keepIds.has(r.id)).map((r) => r.id);
    if (doomed.length === 0) return 0;

    // `inArray` parametreli IN üretir — bu kod tabanında `ANY(${dizi}::uuid[])` biçimi drizzle
    // şablonunda BOZUK SQL ürettiği için (iki kez yaşandı) bilinçli olarak kullanılmıyor.
    await this.db.update(pluginReleases).set({ zipB64: '' }).where(inArray(pluginReleases.id, doomed));
    return doomed.length;
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
