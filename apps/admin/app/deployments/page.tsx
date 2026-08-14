import * as React from 'react';
import {
  Ship,
  History,
  CloudUpload,
  Info,
  Activity,
  Lock,
  TriangleAlert,
  DatabaseBackup,
  ShieldCheck,
} from 'lucide-react';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';
import { isOwner } from '../../lib/session';
import { deployStatusMeta } from '../../lib/labels';
import {
  getBackupSummary,
  getDeployments,
  getHealth,
  type BackupJobInfo,
  type BackupSummary,
  type DeploymentRow,
} from './queries';
import { DeployForm } from './deploy-form';
import { BackupForm } from './backup-form';
import { DeploymentsAutoRefresh } from './auto-refresh';

export const dynamic = 'force-dynamic';

const TARGET_LABEL: Record<string, string> = {
  api: 'API',
  admin: 'Admin',
  'api admin': 'API + Admin',
  // Aynı kuyruğu WP eklentisi yayınları da kullanır (runner publish-plugin.sh'a dallanır);
  // etiketsiz kalırsa geçmişte 'bilinmiyor' görünürdü. Yayın akışının kendisi /releases'te.
  plugin: 'Eklenti yayını',
  // §16 DR: aynı kuyruğu yedek işleri de kullanır (runner backup-drill.sh'a dallanır).
  backup: 'Yedek',
  'backup-drill': 'Yedek tatbikatı',
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}

/** Bayt → okunur boyut. Boyut yoksa '—' (log'da işaret yoksa uydurma yapılmaz). */
function fmtSize(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

/** Saniye → "12 sn" / "3 dk 05 sn". */
function fmtDuration(secs: number | null): string {
  if (secs === null || !Number.isFinite(secs)) return '—';
  if (secs < 60) return `${secs} sn`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m} dk ${String(s).padStart(2, '0')} sn`;
}

/** "3,2 saat önce" / "12 gün önce" — yaş yoksa dürüst "hiç". */
function ageText(hours: number | null, unit: 'hours' | 'days'): string {
  if (hours === null) return 'hiç alınmadı';
  if (unit === 'days') return `${hours.toLocaleString('tr-TR')} gün önce`;
  if (hours < 1) return 'az önce';
  if (hours < 48) return `${hours.toLocaleString('tr-TR')} saat önce`;
  return `${Math.round(hours / 24)} gün önce`;
}

const OFFSITE_LABEL: Record<string, string> = {
  ok: 'Dışarı kopyalandı',
  failed: 'Dış kopya BAŞARISIZ',
  skipped: 'Dış kopya yok',
};

/**
 * Tek yedek/tatbikat işinin özet satırı. Başarılı iş YOKSA (hiç alınmamış ya da hepsi
 * başarısız) dürüstçe söylenir — boş bir kart "her şey yolunda" gibi okunurdu.
 */
function BackupFacts({
  success,
  attempt,
  ageLabel,
  stale,
  showRestore,
}: {
  success: BackupJobInfo | null;
  attempt: BackupJobInfo | null;
  ageLabel: string;
  stale: boolean;
  showRestore?: boolean;
}) {
  const row = (label: string, value: React.ReactNode) => (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-right font-medium text-foreground">{value}</span>
    </div>
  );
  return (
    <div className="space-y-2 text-sm">
      {success ? (
        <>
          {row('Ne zaman', fmt(success.finishedAt ?? success.createdAt))}
          {row('Yaş', <Badge variant={stale ? 'danger' : 'success'}>{ageLabel}</Badge>)}
          {row('Süre', fmtDuration(success.durationSecs))}
          {row('Boyut', fmtSize(success.sizeBytes))}
          {showRestore && row('Geri yükleme (RTO)', fmtDuration(success.restoreSecs))}
          {row(
            'Dış kopya',
            success.offsite ? (
              <Badge
                variant={
                  success.offsite === 'ok'
                    ? 'success'
                    : success.offsite === 'failed'
                      ? 'danger'
                      : 'warning'
                }
              >
                {OFFSITE_LABEL[success.offsite]}
              </Badge>
            ) : (
              '—'
            ),
          )}
        </>
      ) : (
        <p className="text-destructive">Başarılı kayıt yok.</p>
      )}
      {/* Son DENEME başarısızsa, başarılı bir eski kayıt olsa bile görünür olmalı. */}
      {attempt && attempt.status === 'failed' && attempt.id !== success?.id && (
        <p className="text-xs text-destructive">
          Son deneme başarısız ({fmt(attempt.finishedAt ?? attempt.createdAt)}):{' '}
          {attempt.error ?? 'ayrıntı için aşağıdaki geçmiş logu'}
        </p>
      )}
      {attempt && (attempt.status === 'pending' || attempt.status === 'running') && (
        <p className="text-xs text-muted-foreground">
          Şu anda bir iş {attempt.status === 'running' ? 'çalışıyor' : 'kuyrukta'} — durum
          kendiliğinden güncellenecek.
        </p>
      )}
    </div>
  );
}

/**
 * Dağıtımlar (§16) — panelden prod dağıtım yönetimi. Canlı sürüm/sağlık + dağıtım geçmişi
 * (salt-okunur) + owner'a özel "Prod'a dağıt" tetikleyici. Panel bir istek kaydeder; VPS
 * host'undaki runner deploy.sh'ı çalıştırıp sonucu buraya yazar (Docker soketi konteynere
 * verilmez — güvenlik).
 */
export default async function DeploymentsPage() {
  // Savunmalı: sağlık/yetki çağrıları patlarsa sayfa çökmesin; getHealth null'a
  // düşünce mevcut "Sağlık bilgisi alınamadı" fallback'i devreye girer.
  const [owner, health, backup] = await Promise.all([
    isOwner().catch(() => false),
    getHealth().catch(() => null),
    // Eski API'de bu uç yoksa null döner (dağıtım sapması) → kart "bilgi alınamadı" der.
    getBackupSummary().catch(() => null),
  ]);
  let rows: DeploymentRow[] = [];
  let error: string | null = null;
  try {
    rows = await getDeployments();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const healthOk = health?.status === 'ok';
  // Kuyrukta bekleyen/çalışan iş varsa sayfa kendini tazeler (aksi halde poll YOK).
  const hasActiveDeployment = rows.some((r) => r.status === 'pending' || r.status === 'running');

  // TAKILI İSTEK TEŞHİSİ: runner (host cron) dakikada bir yoklar. Birkaç dakikadır
  // 'pending' duran bir istek "yavaş" değil, ALINMAMIŞ demektir — ve panelden yeni dağıtım
  // 409 yer. Eskiden ekran bunu söylemiyordu: operatör "kuyrukta" sanıp bekliyordu.
  // (Sunucu tarafı ayrıca 30dk'dan eski 'pending'i otomatik 'failed' yapar; bu bant o
  // eşikten ÖNCE nedeni gösterir.)
  const STALL_MS = 3 * 60 * 1000;
  const stalled = rows
    .filter((r) => r.status === 'pending' && r.createdAt)
    .map((r) => Date.now() - new Date(r.createdAt).getTime())
    .filter((age) => Number.isFinite(age) && age > STALL_MS)
    .sort((a, b) => b - a)[0];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Ship}
        title="Dağıtımlar"
        description="Canlı sürüm ve sağlık durumu, dağıtım geçmişi ve panelden prod'a dağıtım tetikleme."
      />

      <Alert>
        <Info />
        {/* Alert kökü satır yönünde flex; sarmalayıcı olmadan başlık ve açıklama yan yana iki
            sütun olur ve min-width:auto ile küçülmez. İkon doğrudan çocuk KALMALI ([&>svg]). */}
        <div className="min-w-0 flex-1">
          <AlertTitle>Nasıl çalışır?</AlertTitle>
          <AlertDescription>
            "Prod'a dağıt" bir <strong>dağıtım isteği kaydeder</strong>; VPS host'undaki runner
            (cron) bunu görüp{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">deploy.sh</code> ile git pull +
            build + sağlık kontrolü + gerekirse otomatik geri alma yapar ve sonucu buraya yazar.
            Güvenlik gereği panel konteynerine Docker erişimi verilmez.
          </AlertDescription>
        </div>
      </Alert>

      {stalled !== undefined && (
        <Alert variant="warning">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Bekleyen istek {Math.round(stalled / 60000)} dakikadır alınmadı</AlertTitle>
            <AlertDescription>
              Runner normalde dakikada bir yoklar ve dağıtım 1-2 dakika sürer. Bu kadar beklemesi,
              VPS host&apos;undaki dağıtım servisinin (cron) çalışmadığı anlamına gelir — kurulum
              adımları{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">
                docs/RUNBOOK-RELEASE.md §A2
              </code>
              . Bekleyen istek 30 dakika sonra otomatik olarak &quot;başarısız&quot;a düşer ve
              kuyruk açılır; acele ediyorsanız VPS&apos;te{' '}
              <code className="rounded bg-muted px-1 py-0.5 text-xs">./scripts/deploy.sh</code> ile
              elle dağıtabilirsiniz.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div className="grid gap-6 [&>*]:min-w-0 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle icon={Activity}>Sistem durumu</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {health ? (
              <>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Durum</span>
                  <Badge variant={healthOk ? 'success' : 'danger'}>
                    {healthOk ? 'Sağlıklı' : 'Sorunlu'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Sürüm (API)</span>
                  <span className="font-medium tabular-nums text-foreground">
                    v{health.version}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Veritabanı / Redis</span>
                  <span className="flex gap-2">
                    <Badge variant={health.checks?.db ? 'success' : 'danger'}>DB</Badge>
                    <Badge variant={health.checks?.redis ? 'success' : 'danger'}>Redis</Badge>
                  </span>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">Sağlık bilgisi alınamadı.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle icon={CloudUpload}>Prod'a dağıt</CardTitle>
          </CardHeader>
          <CardContent>
            {owner ? (
              /* `busy`: yedek/dağıtım AYNI kuyruğu paylaşır → aktif iş varken düğme baştan
                 kapanır (yedek formuyla tutarlı; eskiden tıklanıp 409 hatası dönüyordu). */
              <DeployForm busy={hasActiveDeployment} />
            ) : (
              <Alert>
                <Lock />
                {/* min-w-0 flex-1 sarmalayıcı: başlık/açıklama tekrar dikey yığılır (yerleşik desen). */}
                <div className="min-w-0 flex-1">
                  <AlertTitle>Yetki gerekli</AlertTitle>
                  <AlertDescription>
                    Prod'a dağıtımı yalnız "owner" rolündeki yöneticiler tetikleyebilir.
                  </AlertDescription>
                </div>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

      <BackupSection summary={backup} owner={owner} busy={hasActiveDeployment} />

      <Card>
        <CardHeader className="gap-1">
          <CardTitle icon={History}>Dağıtım geçmişi</CardTitle>
          <DeploymentsAutoRefresh active={hasActiveDeployment} />
        </CardHeader>
        <CardContent className={rows.length === 0 ? '' : 'p-0'}>
          {error ? (
            <p className="p-2 text-sm text-destructive">Dağıtımlar yüklenemedi: {error}</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Ship}
              title="Henüz dağıtım yok"
              description="İlk dağıtımı yukarıdan tetikleyin (owner) veya VPS'te deploy.sh ile yapın."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Hedef</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead>İsteyen</TableHead>
                  <TableHead>SHA</TableHead>
                  <TableHead>İstek</TableHead>
                  <TableHead>Bitiş</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => {
                  // Savunmalı: bilinmeyen enum/slug kullanıcıya ham sızmasın → nötr Türkçe fallback
                  // (sözlük + rozet varyantı `lib/labels.ts` — /releases ile TEK KAYNAK).
                  const s = deployStatusMeta(r.status);
                  // Runner'ın gönderdiği çıktı (deploy.sh logunun kuyruğu) — API zaten yolluyordu
                  // ama ekranda hiç gösterilmiyordu: başarısız dağıtımda operatör build hatasını
                  // görmek için VPS'e SSH atmak zorunda kalıyordu. Savunmalı okunur (alan yoksa
                  // satır hiç basılmaz), başarısız dağıtımda VARSAYILAN AÇIK gelir.
                  const log = typeof r.log === 'string' && r.log.trim() ? r.log : null;
                  return (
                    <React.Fragment key={r.id}>
                      <TableRow>
                        <TableCell className="whitespace-nowrap font-medium text-foreground">
                          {TARGET_LABEL[r.target] ?? 'Bilinmiyor'}
                        </TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                          {r.status === 'failed' && r.error ? (
                            <span className="ml-2 text-xs text-destructive">{r.error}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {r.requestedBy || '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {r.gitSha ? r.gitSha.slice(0, 10) : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {fmt(r.createdAt)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {fmt(r.finishedAt)}
                        </TableCell>
                      </TableRow>
                      {log && (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={6} className="pt-0">
                            <details open={r.status === 'failed'}>
                              <summary className="cursor-pointer text-xs text-muted-foreground">
                                Dağıtım logu {r.status === 'failed' ? '(hata ayrıntısı)' : ''}
                              </summary>
                              <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-3 text-xs leading-relaxed text-foreground/80">
                                {log}
                              </pre>
                              <p className="mt-1 text-[11px] text-muted-foreground">
                                Log runner tarafından kırpılmış olabilir (yalnız son bölüm
                                saklanır); tam çıktı VPS&apos;teki dağıtım kaydındadır.
                              </p>
                            </details>
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * YEDEKLER (§16 DR) — "en son ne zaman yedek alındı, tatbikat geçti mi?" sorusunun panel
 * yanıtı. Bilgi ayrı bir tablodan DEĞİL, dağıtımlarla aynı kuyruktaki `backup` /
 * `backup-drill` kayıtlarından türetilir (yeni tablo açılmadı).
 *
 * Tetikleme yalnız İSTEK kaydeder; `pg_dump` host'taki runner'da koşar — panel konteynerine
 * DB/Docker erişimi verilmez (dağıtımdaki istek/çalıştırma ayrımının aynısı).
 */
function BackupSection({
  summary,
  owner,
  busy,
}: {
  summary: BackupSummary | null;
  owner: boolean;
  busy: boolean;
}) {
  if (!summary) {
    return (
      <Card>
        <CardHeader>
          <CardTitle icon={DatabaseBackup}>Yedekler</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Sessiz boş kart YOK: "bilgi alınamadı" ile "yedek yok" farklı şeylerdir. */}
          <p className="text-sm text-muted-foreground">
            Yedek bilgisi alınamadı (API bu ucu sunmuyor olabilir — panel ile API sürümleri ayrı
            dağıtılır). VPS&apos;te{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              bash scripts/backup-drill.sh
            </code>{' '}
            ile elle doğrulayabilirsiniz.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { thresholds } = summary;
  return (
    <div className="space-y-4">
      {/* KRİTİK UYARI: yedek yoksa ya da bayatsa. Yedeksizlik sessiz kalmamalı — bu panelin
          verisi (lisans envanteri + siparişler) kaybı geri alınamaz olan tek şeydir. */}
      {summary.backupStale && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>
              {summary.backupAgeHours === null
                ? 'Hiç yedek kaydı yok'
                : `Son yedek ${ageText(summary.backupAgeHours, 'hours')} (eşik: ${thresholds.backupMaxAgeHours} saat)`}
            </AlertTitle>
            <AlertDescription>
              Yedeksiz geçen her saat, geri alınamaz veri kaybı riskidir. Aşağıdan hemen bir yedek
              tetikleyin ve gecelik otomatik yedeği kurun (
              <code className="rounded bg-muted px-1 py-0.5 text-xs">docs/RUNBOOK-DR.md §4.3</code>
              ). Yedeğin <strong>host dışına</strong> da kopyalandığından emin olun — host kaybında
              yalnız bu sunucuda duran yedek işe yaramaz.
            </AlertDescription>
          </div>
        </Alert>
      )}
      {!summary.backupStale && summary.drillStale && (
        <Alert variant="warning">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>
              {summary.drillAgeDays === null
                ? 'Yedek tatbikatı hiç yapılmadı'
                : `Son tatbikat ${ageText(summary.drillAgeDays, 'days')} (eşik: ${thresholds.drillMaxAgeDays} gün)`}
            </AlertTitle>
            <AlertDescription>
              Yedek alınıyor ama <strong>geri yüklenebilirliği</strong> doğrulanmamış. Aylık
              tatbikat (RUNBOOK-DR §6) yedeği ayrı bir doğrulama veritabanına geri yükler ve
              çifte-atama=0 kontrolünü koşar; prod veritabanına dokunmaz.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <div className="grid gap-6 [&>*]:min-w-0 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle icon={DatabaseBackup}>Son yedek</CardTitle>
          </CardHeader>
          <CardContent>
            <BackupFacts
              success={summary.lastBackupSuccess}
              attempt={summary.lastBackupAttempt}
              ageLabel={ageText(summary.backupAgeHours, 'hours')}
              stale={summary.backupStale}
            />
            {/* Dosya yolu bilgi amaçlı: panel dosyaya ERİŞMEZ (host'ta durur). */}
            {summary.lastBackupSuccess?.file && (
              <p className="mt-3 break-all font-mono text-[11px] text-muted-foreground">
                {summary.lastBackupSuccess.file}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle icon={ShieldCheck}>Son tatbikat</CardTitle>
          </CardHeader>
          <CardContent>
            <BackupFacts
              success={summary.lastDrillSuccess}
              attempt={summary.lastDrillAttempt}
              ageLabel={ageText(summary.drillAgeDays, 'days')}
              stale={summary.drillStale}
              showRestore
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle icon={DatabaseBackup}>Yedek al / tatbikat çalıştır</CardTitle>
        </CardHeader>
        <CardContent>
          {owner ? (
            <BackupForm busy={busy} />
          ) : (
            <Alert>
              <Lock />
              <div className="min-w-0 flex-1">
                <AlertTitle>Yetki gerekli</AlertTitle>
                <AlertDescription>
                  Yedek tetiklemeyi yalnız &quot;owner&quot; rolündeki yöneticiler yapabilir.
                </AlertDescription>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
