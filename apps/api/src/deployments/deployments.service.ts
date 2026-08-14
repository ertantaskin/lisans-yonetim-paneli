import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
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
            'Runner isteği 30dk içinde almadı — host üzerindeki servis (cron) çalışmıyor ' +
            'olabilir. Dağıtım/eklenti için docs/RUNBOOK-RELEASE.md §A2, yedek için ' +
            'docs/RUNBOOK-DR.md §4.3.',
          finishedAt: new Date(),
        })
        .where(
          and(
            eq(deployments.status, 'pending'),
            lt(deployments.createdAt, sql`now() - interval '30 minutes'`),
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
    // Zombi 'running' temizliği: runner çöküp finish yazamazsa satır kalıcı 'running' kalır
    // ve request() guard'ı yeni işi SONSUZA DEK engeller. 30dk'dan eski 'running' → 'failed'
    // (self-heal, runner'dan bağımsız). Hedeften BAĞIMSIZ, yedek işlerini de kapsar.
    // SINIR: 30dk'yı aşan bir yedek TATBİKATI panelde "başarısız" görünür (koşum host'ta
    // sürer). DB büyürse tatbikatı cron'dan/elle koş — bkz. docs/RUNBOOK-DR.md §4.3.
    await this.db
      .update(deployments)
      .set({
        status: 'failed',
        error: 'Zaman aşımı — runner sonucu 30dk içinde bildirmedi (dağıtım/yedek).',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(deployments.status, 'running'),
          lt(deployments.startedAt, sql`now() - interval '30 minutes'`),
        ),
      );

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

  /** Runner: dağıtım sonucunu yaz (success|failed) + log/sha/hata. */
  async finish(
    id: string,
    status: 'success' | 'failed',
    opts: { gitSha?: string; log?: string; error?: string },
  ): Promise<Deployment | null> {
    if (status !== 'success' && status !== 'failed') {
      throw new BadRequestException("status yalnız 'success' veya 'failed' olabilir.");
    }
    const [row] = await this.db
      .update(deployments)
      .set({
        status,
        gitSha: opts.gitSha?.slice(0, 80) ?? null,
        log: opts.log ? opts.log.slice(-MAX_LOG_CHARS) : null,
        error: opts.error?.slice(0, 4000) ?? null,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, id))
      .returning();
    return row ?? null;
  }

  /**
   * Yedek / tatbikat özeti (§16 DR) — "en son ne zaman yedek alındı, tatbikat geçti mi?"
   * sorusunun panel yanıtı. YENİ TABLO AÇILMADI: bilgi zaten `deployments` kayıtlarından
   * türetilebiliyor (istek→claim→finish kuyruğu tüm alanları taşıyor). Boyut/dosya/offsite
   * gibi ayrıntılar `log`'un sonundaki makine-okunur işaretlerden ayrıştırılır
   * (`scripts/backup-drill.sh` "PANEL ÖZETİ" bloğu) — bu yüzden migration gerekmez.
   */
  async backupSummary(): Promise<BackupSummary> {
    const rows = await this.db
      .select()
      .from(deployments)
      .where(inArray(deployments.target, [...BACKUP_RUNNER_TARGETS]))
      .orderBy(desc(deployments.createdAt))
      .limit(30);

    const jobs = rows.map(toBackupJob);
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
