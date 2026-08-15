import { BadRequestException, ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { deployments, type Deployment } from '../db/schema/deployments';

/**
 * Geçerli iş hedefleri (whitelist — enjeksiyon yok).
 *
 * 'api' | 'admin' | 'api admin' → doğrudan `deploy.sh` argümanı (panel→prod dağıtımı).
 * 'plugin'                      → deploy.sh argümanı DEĞİL; runner'ın AYRI dallandığı hedef:
 *                                 repo HEAD'inden WP eklenti zip'i üretip panele publish eder
 *                                 (`scripts/publish-plugin.sh`). Runner target'ı görünce şube
 *                                 seçer; panel yine yalnız İSTEĞİ kaydeder (Docker soketi verilmez).
 * 'backup' | 'backup-drill'     → §16 DR: yedek alma / yedeği ayrı `*_drill` DB'sine geri yükleyip
 *                                 doğrulama. `scripts/backup-runner.sh` bu iki hedefi işler
 *                                 (`scripts/backup-drill.sh`). Şema DEĞİŞMEDİ: `target` kolonu
 *                                 TEXT olduğu için yeni hedef migration GEREKTİRMEZ; whitelist
 *                                 uygulama katmanında. Kuyruk sözleşmesi (tek-aktif guard, zombi
 *                                 temizliği, claim/finish, owner-only) hedeften BAĞIMSIZ ve
 *                                 bu hedefler için de AYNEN geçerlidir (ayrı yol açılmadı).
 */
export const DEPLOY_TARGETS = [
  'api',
  'admin',
  'api admin',
  'plugin',
  'backup',
  'backup-drill',
] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * Hedeflerin runner sınıfları. İki AYRI cron runner aynı kuyruğu yoklar
 * (`deploy-runner.sh` ve `backup-runner.sh`); `claimNext(targets)` filtresi olmasaydı
 * yedek runner'ı bir dağıtım isteğini kapıp `deploy.sh` yerine yanlış betiği çalıştırırdı
 * (ya da tersi). Bu yüzden her runner YALNIZ kendi hedeflerini claim eder.
 */
export const DEPLOY_RUNNER_TARGETS: readonly DeployTarget[] = [
  'api',
  'admin',
  'api admin',
  'plugin',
];
export const BACKUP_RUNNER_TARGETS: readonly DeployTarget[] = ['backup', 'backup-drill'];

/**
 * Yedek tazelik eşikleri (§16 DR). Tek kaynak API'de: /deployments ekranı bu bayrakları
 * gösterir, ekranla API çelişmez.
 *
 * • Yedek 26 saat: gecelik yedek beklenir; 24s + 2s tolerans (cron gecikmesi / saat kayması).
 * • Tatbikat 35 gün: RUNBOOK-DR.md §6 AYLIK tatbikat kuralı + birkaç günlük tolerans.
 */
export const BACKUP_MAX_AGE_HOURS = 26;
export const DRILL_MAX_AGE_DAYS = 35;

/**
 * ZOMBİ 'running' ZAMAN AŞIMI — HEDEFE GÖRE (dakika).
 *
 * KUSUR (denetim O2): eskiden TEK bir 30 dakikalık eşik vardı ve `claimNext` her çağrıda
 * (iki runner × dakikada bir) uyguluyordu. Bu, işin GERÇEK süresiyle çelişiyordu:
 * `backup-drill.sh` bir TATBİKATTIR ve §16 hedefi RTO ≤ 2 SAAT'tir (betiğin kendi özet
 * satırı bunu yazar). Yani 40 dakikalık MEŞRU bir tatbikat 30. dakikada "failed" damgalanıp
 * tek-aktif-iş kilidi AÇILIYORDU. Sonuç zinciri:
 *   1) kilit açılır → panelden/cron'dan gelen bir `deploy.sh` isteği claim edilir,
 *   2) `docker compose build/up` ile `pg_restore` AYNI host'ta aynı anda koşar,
 *   3) yük altında deploy'un 60 sn'lik sağlık penceresi düşer → SAĞLIKLI bir dağıtım
 *      otomatik rollback yer (yani sağlam kod geri alınır),
 *   4) tatbikat bitince runner `finish` yazar ve 'failed' satır 'success'e döner →
 *      olayın hiçbir izi kalmaz (bkz. `finish` CAS'i).
 *
 * Bu yüzden eşik İŞİN DOĞASINA bağlandı. Değerler cömert seçildi: zombi temizliğinin amacı
 * "kilidi sonsuza dek tutma"yı önlemektir, işi hızlı öldürmek değil. Erken öldürmenin bedeli
 * (yukarıdaki 1-4) geç öldürmenin bedelinden (kilidin biraz daha uzun tutulması) çok daha ağır.
 *
 * • api/admin/api admin/plugin → 30 dk : `deploy.sh` sahada 1-2 dk sürer (rollback dahil).
 * • backup                    → 120 dk: `pg_dump` + arşiv kontrolü + OFFSITE yükleme
 *                                        (offsite komutunun kendi tavanı 900 sn, ama yavaş
 *                                        hatta üst üste binebilir).
 * • backup-drill              → 240 dk: RTO hedefi 2 SAAT; tatbikat "hedefi aşıyor mu"yu
 *                                        ÖLÇMEK için vardır → eşik hedefin en az 2 katı
 *                                        olmalı, yoksa ölçmek istediğimiz durumu ölçemeden
 *                                        işi öldürürüz.
 */
export const RUNNING_TIMEOUT_MINUTES: Record<DeployTarget, number> = {
  api: 30,
  admin: 30,
  'api admin': 30,
  plugin: 30,
  backup: 120,
  'backup-drill': 240,
};

/**
 * ÖKSÜZ 'pending' zaman aşımı (dakika) — hedeften BAĞIMSIZ ve bilinçli olarak 30.
 * 'pending' süresi işin ne kadar sürdüğüyle değil, runner'ın DEVRALMA gecikmesiyle ilgilidir;
 * her iki runner da cron'da dakikada bir yoklar. 30 dakikadır alınmamış bir istek "runner
 * çalışmıyor" demektir (hedefi ne olursa olsun).
 */
const PENDING_TIMEOUT_MINUTES = 30;

/** Log gövdesi DB'de sınırlı tutulur (runner deploy.sh çıktısının kuyruğunu gönderir). */
const MAX_LOG_CHARS = 20000;

/**
 * Serbest not üst sınırı. 'plugin' hedefinde changelog metni buradan taşınır; controller'ın
 * Zod `.max(2000)` cap'iyle HİZALI (servis doğrudan çağrıldığında da kırpılır → tutarsız
 * sınır yüzünden sürpriz 400/DB hatası olmaz).
 */
const MAX_NOTE_CHARS = 2000;

/**
 * DeploymentsService — panelden tetiklenen prod dağıtımlarının kaydı (§16). Panel YALNIZ
 * "istek" yazar; VPS host'undaki runner (cron) bunu görür, `deploy.sh`'ı çalıştırır ve
 * sonucu geri yazar. API konteynerine Docker soketi verilmez — bu ayrım güvenlik gereği.
 */
@Injectable()
export class DeploymentsService {
  private readonly logger = new Logger(DeploymentsService.name);

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Yeni dağıtım isteği kaydet (status='pending'). Aynı anda YALNIZ bir aktif (pending/running)
   * dağıtım olabilir → aksi halde 409 (kuyruk yığılması + eşzamanlı deploy engellenir).
   *
   * @param note Hedefe özel serbest not; 'plugin' hedefinde sürüm changelog metni (runner
   *   claim yanıtından okur). MAX_NOTE_CHARS'a kırpılır; boş/whitespace → null.
   */
  async request(target: string, requestedBy: string, note?: string): Promise<Deployment> {
    if (!DEPLOY_TARGETS.includes(target as DeployTarget)) {
      throw new BadRequestException(`Geçersiz hedef. İzinli: ${DEPLOY_TARGETS.join(', ')}`);
    }
    // Zombi 'running' temizliği İSTEK yolunda da koşar: temizlik yalnız `claimNext` içinde
    // olsaydı, HER İKİ runner da ölü olduğunda (host yeniden kurulmuş, cron silinmiş) kilidi
    // hiç kimse açamazdı — 'pending' için aynı gerekçeyle eklenen ikizin karşılığı.
    await this.expireZombieRunning();

    // SELECT-sonra-INSERT arası yarış (form çift-tık / eşzamanlı iki POST) iki 'pending' üretip
    // aynı kodun ardışık iki redeploy'una yol açardı. Tüm istek yolunu tek transaction'da
    // pg_advisory_xact_lock ile serileştir → "aynı anda tek aktif dağıtım" gerçekten garanti
    // (migration YOK; global tek-kaynak kilidi yeterli, dağıtım nadir bir owner işlemi).
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('deployments_request'))`);

      // ÖKSÜZ 'pending' temizliği — `claimNext`'teki zombi-'running' temizliğinin İKİZİ.
      // O temizlik runner'ın İÇİNDE koştuğu için, tıkanıklığın asıl sebebi runner'ın kendisi
      // olduğunda (cron kaldırılmış / host yeniden kurulmuş / betik bozulmuş) HİÇ çalışmaz:
      // istek sonsuza dek 'pending' kalır, guard 409 verir ve panelden BİR DAHA dağıtım
      // yapılamaz — panelin varlık sebebi olan "SSH'siz dağıtım" tam da o anda kaybolur.
      // Bu yüzden temizlik istek yoluna da konur (runner'dan bağımsız). Runner dakikada bir
      // yoklar, deploy.sh 1-2 dk sürer → 30dk'lık 'pending' kesin tıkanmıştır.
      await tx
        .update(deployments)
        .set({
          status: 'failed',
          error:
            `Runner isteği ${PENDING_TIMEOUT_MINUTES}dk içinde almadı — host üzerindeki servis ` +
            '(cron) çalışmıyor olabilir. Dağıtım/eklenti için docs/RUNBOOK-RELEASE.md §A2, ' +
            'yedek için docs/RUNBOOK-DR.md §4.3.',
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.status, 'pending'),
            lt(deployments.createdAt, sql`now() - make_interval(mins => ${PENDING_TIMEOUT_MINUTES})`),
          ),
        );

      const active = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(inArray(deployments.status, ['pending', 'running']))
        .limit(1);
      if (active.length > 0) {
        // Guard hedeften BAĞIMSIZ: yedek işi de dağıtımla aynı kuyruğu paylaşır. Nedeni yalnız
        // "yığılma önleme" değil — yedek alırken deploy.sh'ın servisleri yeniden başlatması
        // dump'ı yarıda bırakabilir. Bu yüzden yeni hedefler için AYRI kuyruk açılmadı.
        throw new ConflictException(
          'Zaten bekleyen veya çalışan bir iş var (dağıtım/yedek). Bitmesini bekleyin.',
        );
      }
      const [row] = await tx
        .insert(deployments)
        .values({
          target,
          requestedBy: requestedBy || 'panel:admin',
          note: note?.slice(0, MAX_NOTE_CHARS).trim() || null,
        })
        .returning();
      return row!;
    });
  }

  /**
   * ZOMBİ 'running' TEMİZLİĞİ — hedefe göre zaman aşımı (bkz. RUNNING_TIMEOUT_MINUTES).
   *
   * Runner çöküp `finish` yazamazsa satır kalıcı 'running' kalır ve tek-aktif-iş guard'ı yeni
   * işi SONSUZA DEK engeller; bu yüzden self-heal ŞART. Ama eşik işin doğasına göre değişir:
   * 30 dakikalık tek eşik meşru bir yedek tatbikatını (RTO hedefi 2 saat) öldürüyor ve
   * `deploy.sh` ile `pg_restore`'un aynı anda koşmasına kapı açıyordu.
   *
   * `coalesce(started_at, created_at)`: teoride 'running' bir satırın `started_at`'i NULL
   * kalırsa (elle müdahale / kısmi yazım) karşılaştırma NULL döner ve satır SONSUZA DEK
   * temizlenmezdi — tam da önlemek istediğimiz kilitlenme. Yedek zaman kaynağı bunu kapatır.
   *
   * @returns zombi olarak kapatılan satır sayısı (log/teşhis için).
   */
  private async expireZombieRunning(): Promise<number> {
    // CASE dalları whitelist'ten üretilir (serbest metin yok → enjeksiyon yolu yok).
    const cases = sql.join(
      (Object.entries(RUNNING_TIMEOUT_MINUTES) as [string, number][]).map(
        // `::int` HER dalda AÇIKÇA yazılır: tüm CASE dalları bağlı parametre olduğunda
        // Postgres ortak tipi 'unknown' üzerinden çözer ve "could not determine data type of
        // parameter" riski doğar; açık cast bunu kesin kapatır.
        ([t, mins]) => sql`when ${t} then ${mins}::int`,
      ),
      sql` `,
    );
    // Bilinmeyen bir hedef (eski satır / ileride eklenip buraya yazılmayan hedef) sessizce
    // "sonsuz" olmasın diye ELSE dalı en muhafazakâr değere (en uzun eşik) düşer: erken
    // öldürmenin bedeli geç öldürmeninkinden ağır (bkz. RUNNING_TIMEOUT_MINUTES gerekçesi).
    const fallback = Math.max(...Object.values(RUNNING_TIMEOUT_MINUTES));
    const killed = await rawRows<{ id: string; target: string }>(this.db, sql`
      with t as (
        select id, (case target ${cases} else ${fallback}::int end)::int as tmo
        from deployments
        where status = 'running'
      )
      update deployments d
         set status = 'failed',
             error = 'Zaman aşımı — runner sonucu ' || t.tmo ||
                     ' dakika içinde bildirmedi (hedef: ' || d.target ||
                     '). Host runner çökmüş olabilir; kilit açıldı.',
             finished_at = now()
        from t
       where d.id = t.id
         and coalesce(d.started_at, d.created_at) < now() - make_interval(mins => t.tmo)
      returning d.id, d.target
    `);
    for (const r of killed) {
      // Sessiz ölüm yok: kilit açmak bir ONARIM değil, bir ARIZA işaretidir.
      this.logger.error(
        `Zombi iş kapatıldı: id=${r.id} target=${r.target} ` +
          `(eşik ${RUNNING_TIMEOUT_MINUTES[r.target as DeployTarget] ?? fallback} dk). ` +
          'Host runner çökmüş/öldürülmüş olabilir — docs/RUNBOOK-DR.md §4.3.',
      );
    }
    return killed.length;
  }

  /** Dağıtım geçmişi (en yeni önce). */
  async list(limit = 50): Promise<Deployment[]> {
    return this.db
      .select()
      .from(deployments)
      .orderBy(desc(deployments.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Runner: en eski PENDING isteği ATOMİK olarak claim eder (pending→running). `FOR UPDATE
   * SKIP LOCKED` ile iki runner örneği aynı isteği çalıştıramaz. Bekleyen yoksa null.
   *
   * Argümansız `.returning()` TÜM kolonları döndürür → runner yanıttan hem `target`
   * (hangi dala gideceği: deploy.sh vs eklenti yayınlama) hem de `note`'u (plugin
   * changelog metni) okuyabilir. Yeni kolon eklendiğinde ayrıca listelemek gerekmez.
   *
   * @param targets Verilirse YALNIZ bu hedeflerdeki istek claim edilir. Aynı kuyruğu iki
   *   farklı cron runner yokladığı için ŞART: `backup-runner.sh` bir `api admin` isteğini
   *   kapsaydı yanlış betiği çalıştırır ve claim geri alınamadığı için istek "çalıştı ama
   *   dağıtım olmadı" diye kaybolurdu. Whitelist dışı değerler süzülür (enjeksiyon yok);
   *   filtre verilip hiçbiri geçerli değilse null döner (yanlışlıkla "hepsini claim et"e
   *   düşmemek için — sessizce yanlış işi almaktansa hiç iş almamak doğrudur).
   *   Argümansız çağrı ESKİ davranış (tüm hedefler) → eski runner sürümü kırılmaz.
   */
  async claimNext(targets?: readonly string[]): Promise<Deployment | null> {
    await this.expireZombieRunning();

    let allowed: string[] | null = null;
    if (targets) {
      allowed = targets.filter((t) => DEPLOY_TARGETS.includes(t as DeployTarget));
      if (allowed.length === 0) return null;
    }

    // Alt sorgu iki varyantta AYRI yazıldı: boş `sql``` parçası gömmek yerine tam ifadeyi
    // seçmek okunur ve drizzle'ın boş-chunk kenar durumlarına hiç girmez.
    const pick = allowed
      ? sql`(select id from deployments
             where status = 'pending'
               and target in (${sql.join(
                 allowed.map((t) => sql`${t}`),
                 sql`, `,
               )})
             order by created_at asc limit 1 for update skip locked)`
      : sql`(select id from deployments where status = 'pending' order by created_at asc limit 1 for update skip locked)`;

    const [row] = await this.db
      .update(deployments)
      .set({ status: 'running', startedAt: new Date() })
      .where(eq(deployments.id, pick))
      .returning();
    return row ?? null;
  }

  /**
   * Runner: dağıtım sonucunu yaz (success|failed) + log/sha/hata.
   *
   * CAS (compare-and-set): güncelleme YALNIZ satır hâlâ 'running' iken uygulanır.
   *
   * KUSUR (denetim O2, ikinci yarısı): eskiden koşul yalnız `id` idi. Zombi temizliği bir işi
   * 'failed' yaptıktan SONRA gerçek runner işini bitirip `finish success` yazdığında satır
   * sessizce 'success'e dönüyordu → zaman aşımının, açılan kilidin ve (muhtemelen) o sırada
   * eşzamanlı koşan başka bir işin HİÇBİR İZİ kalmıyordu. Yani sistemin kendini onardığı ama
   * bunu unuttuğu bir yol vardı; olay tekrarlansa bile geçmişte görünmezdi.
   *
   * Artık geç gelen bildirim satırın SONUCUNU DEĞİŞTİRMEZ; bunun yerine GÖRÜNÜR bir çakışma
   * olarak işaretlenir (error alanına eklenir + logger.error) ve runner'ın gönderdiği log
   * kaybolmasın diye (satırda log yoksa) saklanır — kök-neden analizi tam da bu logla yapılır.
   */
  async finish(
    id: string,
    status: 'success' | 'failed',
    opts: { gitSha?: string; log?: string; error?: string },
  ): Promise<Deployment | null> {
    if (status !== 'success' && status !== 'failed') {
      throw new BadRequestException("status yalnız 'success' veya 'failed' olabilir.");
    }
    const log = opts.log ? opts.log.slice(-MAX_LOG_CHARS) : null;
    const [row] = await this.db
      .update(deployments)
      .set({
        status,
        gitSha: opts.gitSha?.slice(0, 80) ?? null,
        log,
        error: opts.error?.slice(0, 4000) ?? null,
        finishedAt: new Date(),
      })
      .where(and(eq(deployments.id, id), eq(deployments.status, 'running')))
      .returning();
    if (row) return row;

    // CAS tuttu ↛ satır ya yok ya da artık 'running' değil.
    const [existing] = await this.db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id))
      .limit(1);
    if (!existing) return null;

    return this.markLateFinish(existing, status, log, opts.gitSha);
  }

  /**
   * GEÇ BİLDİRİM işaretleme: zombi olarak kapatılmış (ya da başka biçimde terminal olmuş) bir
   * işin sonucu sonradan gelirse durumu EZMEDEN görünür kılar. Best-effort — işaretleme
   * başarısız olsa bile runner'a sağlıklı yanıt döner (log zaten `logger.error` ile düştü).
   */
  private async markLateFinish(
    existing: Deployment,
    status: 'success' | 'failed',
    log: string | null,
    gitSha?: string,
  ): Promise<Deployment> {
    const note =
      `[GEÇ BİLDİRİM] Runner bu işi '${status}' olarak bildirdi ama kayıt o sırada ` +
      `'${existing.status}' durumundaydı (büyük olasılıkla zombi zaman aşımıyla kapatılmış). ` +
      'Sonuç EZİLMEDİ. İş eşikten uzun sürmüş ve bu sırada tek-aktif-iş kilidi açılmış ' +
      'olabilir — docs/RUNBOOK-DR.md §4.3.';
    this.logger.error(`Geç finish çakışması: id=${existing.id} target=${existing.target} ${note}`);

    try {
      const [updated] = await this.db
        .update(deployments)
        .set({
          error: `${existing.error ? `${existing.error} | ` : ''}${note}`.slice(0, 4000),
          // Runner'ın logu kaybolmasın: satırda log YOKSA (zombi kapanışında olmaz) yazılır.
          // Varsa DOKUNULMAZ — terminal durumun kendi kanıtını üzerine yazmayız.
          ...(existing.log ? {} : log ? { log } : {}),
          ...(existing.gitSha ? {} : gitSha ? { gitSha: gitSha.slice(0, 80) } : {}),
        })
        .where(eq(deployments.id, existing.id))
        .returning();
      return updated ?? existing;
    } catch (err) {
      this.logger.warn(
        `Geç finish işaretlemesi yazılamadı (best-effort): ${err instanceof Error ? err.message : String(err)}`,
      );
      return existing;
    }
  }

  /**
   * Yedek / tatbikat özeti (§16 DR) — "en son ne zaman yedek alındı, tatbikat geçti mi?"
   * sorusunun panel yanıtı. YENİ TABLO AÇILMADI: bilgi zaten `deployments` kayıtlarından
   * türetilebiliyor (istek→claim→finish kuyruğu tüm alanları taşıyor). Boyut/dosya/offsite
   * gibi ayrıntılar `log`'un sonundaki makine-okunur işaretlerden ayrıştırılır
   * (`scripts/backup-drill.sh` "PANEL ÖZETİ" bloğu) — bu yüzden migration gerekmez.
   */
  async backupSummary(): Promise<BackupSummary> {
    /*
     * HEDEF BAŞINA AYRI PENCERE — ortak `limit(30)` DR alarmına YALAN söyletiyordu.
     *
     * RUNBOOK kurulumunda `backup` GECELİK, `backup-drill` AYLIK koşar. Tek 30 satırlık ortak
     * pencere pratikte ~30 gecelik yedek demektir → ~29 günden eski BAŞARILI tatbikat pencereden
     * düşer, `lastDrillSuccess` null olur ve `BackupAlarmService` "HİÇ başarılı tatbikat kaydı
     * yok" metniyle `drill_stale` uyarısı üretir — oysa eşik 35 gün ve 30 gün önce başarılı bir
     * tatbikat VARDIR. Aynı yalan `/deployments` ekranında da görünürdü. Alarmın erken ve YANLIŞ
     * GEREKÇEYLE çalması, alarma olan güveni bitirir (bu panelde alarm tasarımının ilk kuralı).
     *
     * Her hedef kendi penceresinden okunur; `recent` listesi ikisinin birleşiminden en yeni 10.
     */
    const perTarget = await Promise.all(
      [...BACKUP_RUNNER_TARGETS].map((target) =>
        this.db
          .select()
          .from(deployments)
          .where(eq(deployments.target, target))
          .orderBy(desc(deployments.createdAt), desc(deployments.id))
          .limit(30),
      ),
    );

    const jobs = perTarget
      .flat()
      .map(toBackupJob)
      .sort((a, b) => (finishedOrCreated(b)?.getTime() ?? 0) - (finishedOrCreated(a)?.getTime() ?? 0));
    const pick = (target: string, onlySuccess: boolean): BackupJobInfo | null =>
      jobs.find((j) => j.target === target && (!onlySuccess || j.status === 'success')) ?? null;

    const lastBackupSuccess = pick('backup', true);
    const lastDrillSuccess = pick('backup-drill', true);

    // YEDEK YAŞI: tatbikat da yedek ALIR (backup-drill dump'la başlar) → başarılı bir tatbikat
    // "yedek yok" uyarısını da söndürmeli, aksi halde ekran yanlış alarm verirdi.
    const backupAt = newest(lastBackupSuccess, lastDrillSuccess);
    const drillAt = lastDrillSuccess ? finishedOrCreated(lastDrillSuccess) : null;

    const now = Date.now();
    const backupAgeHours = backupAt ? (now - backupAt.getTime()) / 3_600_000 : null;
    const drillAgeDays = drillAt ? (now - drillAt.getTime()) / 86_400_000 : null;

    return {
      lastBackupSuccess,
      lastBackupAttempt: pick('backup', false),
      lastDrillSuccess,
      lastDrillAttempt: pick('backup-drill', false),
      backupAgeHours: backupAgeHours === null ? null : round1(backupAgeHours),
      drillAgeDays: drillAgeDays === null ? null : round1(drillAgeDays),
      // Hiç yedek yoksa da "bayat" sayılır: eksik yedek, eski yedekten DAHA kötüdür.
      backupStale: backupAgeHours === null || backupAgeHours > BACKUP_MAX_AGE_HOURS,
      drillStale: drillAgeDays === null || drillAgeDays > DRILL_MAX_AGE_DAYS,
      activeJob: jobs.find((j) => j.status === 'pending' || j.status === 'running') ?? null,
      thresholds: {
        backupMaxAgeHours: BACKUP_MAX_AGE_HOURS,
        drillMaxAgeDays: DRILL_MAX_AGE_DAYS,
      },
      recent: jobs.slice(0, 10),
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Yedek özeti — yardımcılar (log'daki makine-okunur işaretlerin ayrıştırılması)
// ─────────────────────────────────────────────────────────────────────────────

/** `backup-drill.sh` "PANEL ÖZETİ" bloğundan okunan alanlar. */
export interface BackupMeta {
  /** Dump dosyasının host'taki tam yolu (yalnız bilgi; panel dosyaya ERİŞMEZ). */
  file: string | null;
  sizeBytes: number | null;
  /** Offsite kancasının sonucu: kanca tanımsızsa 'skipped'. */
  offsite: 'ok' | 'failed' | 'skipped' | null;
  /** Tatbikatta ölçülen geri-yükleme süresi (RTO gözlemi). */
  restoreSecs: number | null;
}

export interface BackupJobInfo extends BackupMeta {
  id: string;
  target: string;
  status: string;
  requestedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  /** İşin toplam süresi (started→finished); ölçülemiyorsa null. */
  durationSecs: number | null;
  error: string | null;
}

export interface BackupSummary {
  lastBackupSuccess: BackupJobInfo | null;
  lastBackupAttempt: BackupJobInfo | null;
  lastDrillSuccess: BackupJobInfo | null;
  lastDrillAttempt: BackupJobInfo | null;
  backupAgeHours: number | null;
  drillAgeDays: number | null;
  backupStale: boolean;
  drillStale: boolean;
  activeJob: BackupJobInfo | null;
  thresholds: { backupMaxAgeHours: number; drillMaxAgeDays: number };
  recent: BackupJobInfo[];
}

/**
 * Log'un SONUNDAKİ `ANAHTAR=değer` işaretlerini okur. `log` yalnız çıktının KUYRUĞUDUR
 * (runner son 20000 karakteri gönderir) → işaretler betiğin en sonunda basılır. Aynı anahtar
 * birden çok geçerse SONUNCUSU alınır (kırpılmış yarım satır başta kalmış olabilir).
 */
export function parseBackupMeta(log: string | null | undefined): BackupMeta {
  const empty: BackupMeta = { file: null, sizeBytes: null, offsite: null, restoreSecs: null };
  if (!log) return empty;

  const last = (key: string): string | null => {
    const re = new RegExp(`^${key}=(.*)$`, 'gm');
    let m: RegExpExecArray | null;
    let val: string | null = null;
    while ((m = re.exec(log)) !== null) val = (m[1] ?? '').trim();
    return val && val.length > 0 ? val : null;
  };
  const num = (key: string): number | null => {
    const raw = last(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  const offsiteRaw = last('BACKUP_OFFSITE');
  return {
    // Yol uzunluğu sınırlandı: bozuk/uzun bir log satırı UI'ı taşırmasın.
    file: last('BACKUP_FILE')?.slice(0, 300) ?? null,
    sizeBytes: num('BACKUP_BYTES'),
    offsite:
      offsiteRaw === 'ok' || offsiteRaw === 'failed' || offsiteRaw === 'skipped'
        ? offsiteRaw
        : null,
    restoreSecs: num('BACKUP_RESTORE_SECS'),
  };
}

function toBackupJob(row: Deployment): BackupJobInfo {
  const meta = parseBackupMeta(row.log);
  const started = row.startedAt ? new Date(row.startedAt) : null;
  const finished = row.finishedAt ? new Date(row.finishedAt) : null;
  return {
    id: row.id,
    target: row.target,
    status: row.status,
    requestedBy: row.requestedBy,
    createdAt: new Date(row.createdAt),
    startedAt: started,
    finishedAt: finished,
    durationSecs:
      started && finished
        ? Math.max(0, Math.round((finished.getTime() - started.getTime()) / 1000))
        : null,
    error: row.error,
    ...meta,
  };
}

const finishedOrCreated = (j: BackupJobInfo): Date => j.finishedAt ?? j.createdAt;

function newest(a: BackupJobInfo | null, b: BackupJobInfo | null): Date | null {
  const da = a ? finishedOrCreated(a) : null;
  const db = b ? finishedOrCreated(b) : null;
  if (!da) return db;
  if (!db) return da;
  return da.getTime() >= db.getTime() ? da : db;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
