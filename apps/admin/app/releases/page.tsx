import { Rocket, History, UploadCloud, Info, ListChecks, Globe, Lock } from 'lucide-react';
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
  getReleases,
  getPluginJobs,
  getSitePluginVersions,
  PLUGIN_JOB_TAKE,
  type ReleaseRow,
  type PluginJobRow,
  type SitePluginRow,
} from './queries';
import { DEPLOYMENTS_WINDOW, type TargetJobs } from '../../lib/deployment-jobs';
import { PublishForm } from './publish-form';
import { PublishFromSourceForm } from './publish-from-source-form';
// Sürüm sıralaması TEK KAYNAKTAN (./semver) — API'nin `updates.service.compareVersions`
// kuralıyla birebir. Bu dosyada yerel bir `cmpVersion` vardı ve `parseInt(...)||0` ile
// GEÇERSİZ biçimi 0.0.0 sayıyordu; artık geçersiz sürüm "en düşük" olarak ele alınır.
import { compareVersions, highestVersion } from './semver';

export const dynamic = 'force-dynamic';

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}


/**
 * Sürümler (§16) — WP eklentisi sürüm yönetimi.
 *
 * Üç şey bir arada: (1) sitelerdeki KURULU sürüm ("güncelleme çalışıyor mu" sorusunun cevabı),
 * (2) kaynaktan tek tuşla yayınlama (owner) + yayın işi durumu, (3) yayın geçmişi.
 */
export default async function ReleasesPage() {
  const [owner, releases, jobResult, sites] = await Promise.all([
    isOwner().catch(() => false),
    getReleases().catch((e: unknown) => (e instanceof Error ? e : new Error('Bağlantı hatası'))),
    // Yardımcı bölümler ANA içeriği düşürmemeli: hata → boş liste (kırpma bayrağı da false;
    // hatayı "liste kırpıldı" diye göstermek yanlış teşhis olurdu).
    getPluginJobs().catch(
      () => ({ jobs: [], windowSaturated: false }) as TargetJobs<PluginJobRow>,
    ),
    getSitePluginVersions().catch(() => [] as SitePluginRow[]),
  ]);
  const jobs = jobResult.jobs;

  const error = releases instanceof Error ? releases.message : null;
  const rows: ReleaseRow[] = releases instanceof Error ? [] : releases;
  /*
   * SİTELERE FİİLEN SUNULAN SÜRÜM = EN YÜKSEK SEMVER (`updates.service.latest()`), yayın
   * SIRASI değil. Burada `rows[0]` kullanılıyordu; liste ise `created_at DESC` gelir ve
   * yeniden yayınlama `created_at`i TAZELER → panel eski bir sürüme "En yeni" damgası basıp
   * mağazalara "eski — vX mevcut" diyebiliyordu (aynı ekranda birbiriyle çelişen iki cevap).
   */
  const latest = highestVersion(rows.map((r) => r.version));

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Rocket}
        title="Sürümler"
        description="WP eklentisi sürüm geçmişi, yayınlama ve müşteri sitelerindeki kurulu sürümler."
      />

      <Alert>
        <Info />
        {/* Alert kökü satır yönünde flex; sarmalayıcı olmadan başlık ve açıklama yan yana iki
            sütuna düşer ve min-width:auto ile küçülmez (ör. "güncelleyicisiyle" kabı şişirir).
            İkon doğrudan çocuk KALMALI — [&>svg] seçicileri ona bağlı. */}
        <div className="min-w-0 flex-1">
          <AlertTitle>Nasıl çalışır?</AlertTitle>
          <AlertDescription>
            Yayınlanan sürümü müşteri siteleri kendi güncelleyicisiyle panelden çeker (WordPress →
            Güncellemeler; önbellek nedeniyle 12 saate kadar gecikebilir, "Tekrar denetle" anında
            tazeler). <strong>Kaynaktan yayınla</strong> bir istek kaydeder; VPS host'undaki runner
            depodaki (push edilmiş) eklenti kodundan paketi üretip yayınlar — panel konteynerine
            Docker/git yazma yetkisi verilmez.
          </AlertDescription>
        </div>
      </Alert>

      {/* min-w-0: grid çocuğu varsayılan olarak içerik-tabanlı minimum alır; içindeki
          (nowrap kolonlu) tablo kartı ve grid'i viewport'tan geniş yapar. min-w-0 ile kaydırma
          Table primitifinin İŞARETLENMİŞ overflow-x-auto kabına devreder. */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <Card className="min-w-0">
          <CardHeader>
            <CardTitle icon={Rocket}>Kaynaktan yayınla</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {owner ? (
              <>
                <p className="text-sm text-muted-foreground">
                  Depodaki eklenti kaynağının sürümü yayınlanır (sürüm numarası kodda tanımlıdır,
                  burada girilmez). Dosya hazırlamanız gerekmez.
                </p>
                <PublishFromSourceForm />
              </>
            ) : (
              <Alert>
                <Lock />
                {/* min-w-0 flex-1 sarmalayıcı: başlık/açıklama tekrar dikey yığılır (yerleşik desen). */}
                <div className="min-w-0 flex-1">
                  <AlertTitle>Yetki gerekli</AlertTitle>
                  <AlertDescription>
                    Sürüm yayınlamayı yalnız "owner" rolündeki yöneticiler tetikleyebilir.
                  </AlertDescription>
                </div>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle icon={ListChecks}>Yayın işleri</CardTitle>
          </CardHeader>
          <CardContent className={jobs.length === 0 ? '' : 'p-0'}>
            {jobs.length === 0 ? (
              /*
                "Hiç yayın yapılmadı" ile "yayın işi bu pencerede kalmadı" AYRI şeylerdir.
                Kuyruk tek tablodur ve gecelik yedek işleri 50 satırlık pencereyi tek başına
                doldurabilir → eski yayın işleri pencerenin dışına düşer. Sessizce "yok"
                demek, bu kod tabanının tekrar tekrar yakaladığı sessiz-kırpma hatasıdır.
              */
              <EmptyState
                icon={ListChecks}
                title={
                  jobResult.windowSaturated
                    ? 'Bu pencerede yayın işi görünmüyor'
                    : 'Henüz yayın işi yok'
                }
                description={
                  jobResult.windowSaturated
                    ? `Dağıtım kuyruğunun son ${DEPLOYMENTS_WINDOW} kaydı tarandı ve hepsi başka işlere (dağıtım/yedek) ait. Daha eski yayın işleri bu listede GÖRÜNMEZ — yayınlanmış sürümlerin tam listesi aşağıdaki “Sürüm geçmişi” tablosundadır.`
                    : 'Kaynaktan yayınladığınızda işin durumu burada görünür.'
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Durum</TableHead>
                    <TableHead>İsteyen</TableHead>
                    <TableHead>Commit</TableHead>
                    <TableHead>İstek</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {jobs.map((j) => {
                    // Yayın işi ile panel dağıtımı AYNI kuyruktur → durum sözlüğü de tek
                    // (`lib/labels.ts`); burada ayrı harita tutulunca /deployments ile
                    // renk ve etiket çelişiyordu ('çalışıyor' gri vs 'Çalışıyor' mavi).
                    const s = deployStatusMeta(j.status);
                    return (
                      <TableRow key={j.id}>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                          {j.status === 'failed' && j.error ? (
                            <span className="ml-2 text-xs text-destructive">{j.error}</span>
                          ) : null}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {j.requestedBy || '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
                          {j.gitSha ? j.gitSha.slice(0, 10) : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                          {fmt(j.createdAt)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
            {/* Liste EKSİK olabilir: en çok 5 satır gösterilir ve kaynak pencere (tek kuyruk,
                son 50 kayıt) yedek/dağıtım işleriyle dolmuş olabilir. Sınır GÖRÜNÜR olmalı. */}
            {jobs.length > 0 && (
              <p className="px-5 pb-4 pt-3 text-xs text-muted-foreground">
                Son {PLUGIN_JOB_TAKE} yayın işi gösteriliyor
                {jobResult.windowSaturated
                  ? `; kaynak liste dağıtım/yedek işleriyle ortak ve yalnız son ${DEPLOYMENTS_WINDOW} kaydı kapsıyor — daha eski yayın işleri burada olmayabilir.`
                  : '.'}{' '}
                Yayınlanmış sürümlerin tam listesi aşağıdaki “Sürüm geçmişi” tablosundadır.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle icon={Globe}>Sitelerdeki kurulu sürüm</CardTitle>
        </CardHeader>
        <CardContent className={sites.length === 0 ? '' : 'p-0'}>
          {sites.length === 0 ? (
            <EmptyState
              icon={Globe}
              title="Site yok"
              description="Panele bağlı bir mağaza olduğunda kurulu eklenti sürümü burada görünür."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Mağaza</TableHead>
                  <TableHead>Kurulu sürüm</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead>Son bildirim</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sites.map((s) => {
                  const v = s.pluginVersion;
                  // "Eski" damgası YALNIZ iki sürüm de bilindiğinde basılır; bilinmeyen sürüm
                  // "güncel değil" DEĞİLDİR (eklenti sürüm başlığını göndermiyor olabilir).
                  const state =
                    !v || !latest
                      ? { variant: 'neutral' as const, label: 'bilinmiyor' }
                      : compareVersions(v, latest) < 0
                        ? { variant: 'warning' as const, label: `eski — v${latest} mevcut` }
                        : { variant: 'success' as const, label: 'güncel' };
                  return (
                    <TableRow key={s.id}>
                      <TableCell className="whitespace-nowrap font-medium text-foreground">
                        {s.domain}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {v ? `v${v}` : '—'}
                      </TableCell>
                      <TableCell>
                        <Badge variant={state.variant}>{state.label}</Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                        {fmt(s.pluginVersionAt)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
          <p className="px-5 pb-4 pt-3 text-xs text-muted-foreground">
            Kurulu sürüm, mağazanın panele yaptığı imzalı isteklerden öğrenilir; bu yüzden yeni
            bağlanan ya da hiç sipariş iletmemiş mağazada "bilinmiyor" görünebilir. Sürüm bilgisini
            eklentinin v1.0.0 ve üstü gönderir.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle icon={History}>Sürüm geçmişi</CardTitle>
        </CardHeader>
        <CardContent className={rows.length === 0 ? '' : 'p-0'}>
          {error ? (
            <p className="p-2 text-sm text-destructive">Sürümler yüklenemedi: {error}</p>
          ) : rows.length === 0 ? (
            <EmptyState
              icon={Rocket}
              title="Henüz sürüm yok"
              description="İlk sürümü yukarıdan yayınlayın."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Sürüm</TableHead>
                  <TableHead>Yayın tarihi</TableHead>
                  <TableHead>Değişiklik notu</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums text-foreground">
                      <span className="inline-flex items-center gap-2">
                        v{r.version}
                        {/* Rozet, listenin İLK satırına değil sitelere SUNULAN sürüme basılır
                            (yukarıdaki `latest` = en yüksek semver) — "Sitelerdeki kurulu sürüm"
                            kartındaki "eski — vX mevcut" damgasıyla aynı kaynak. */}
                        {r.version === latest && <Badge variant="success">En yeni</Badge>}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums text-muted-foreground">
                      {new Date(r.createdAt).toLocaleString('tr-TR', {
                        dateStyle: 'medium',
                        timeStyle: 'short',
                      })}
                    </TableCell>
                    <TableCell className="max-w-md whitespace-pre-wrap text-muted-foreground">
                      {r.changelog?.trim() ? r.changelog : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/*
        Elle .zip yükleme GELİŞMİŞ yol olarak kaldı: paket üretmeyi gerektirir (panelde zip
        hazırlanamaz), bu yüzden birincil akış artık "Kaynaktan yayınla". Kurtarma senaryosu
        (runner çalışmıyor, elde hazır paket var) için silinmedi.
      */}
      <Card>
        <CardHeader>
          <CardTitle icon={UploadCloud}>Elle .zip yükle (gelişmiş)</CardTitle>
        </CardHeader>
        <CardContent>
          {owner ? (
            <details className="group">
              <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">
                Hazır bir eklenti paketiniz varsa doğrudan yükleyin — normalde gerekmez.
              </summary>
              <div className="mt-4">
                <PublishForm />
              </div>
            </details>
          ) : (
            <Alert>
              <Lock />
              {/* min-w-0 flex-1 sarmalayıcı: başlık/açıklama tekrar dikey yığılır (yerleşik desen). */}
              <div className="min-w-0 flex-1">
                <AlertTitle>Yetki gerekli</AlertTitle>
                <AlertDescription>
                  Elle paket yüklemeyi yalnız "owner" rolündeki yöneticiler yapabilir.
                </AlertDescription>
              </div>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
