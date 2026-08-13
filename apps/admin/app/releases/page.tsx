import { Rocket, History, UploadCloud, Info, ListChecks, Globe, Lock } from 'lucide-react';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge, type BadgeProps } from '../../components/ui/badge';
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
import {
  getReleases,
  getPluginJobs,
  getSitePluginVersions,
  type ReleaseRow,
  type PluginJobRow,
  type SitePluginRow,
} from './queries';
import { PublishForm } from './publish-form';
import { PublishFromSourceForm } from './publish-from-source-form';

export const dynamic = 'force-dynamic';

const JOB_STATUS: Record<string, { variant: NonNullable<BadgeProps['variant']>; label: string }> = {
  pending: { variant: 'warning', label: 'sırada' },
  running: { variant: 'accent', label: 'çalışıyor' },
  success: { variant: 'success', label: 'yayınlandı' },
  failed: { variant: 'danger', label: 'başarısız' },
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
}

/**
 * SemVer karşılaştırma (a<b → -1). Sayısal olmayan/eksik parça 0 sayılır; bilinmeyen biçimde
 * yanlış "eski" damgası basmamak için çağıran taraf null sürümü ayrıca ele alır.
 */
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Sürümler (§16) — WP eklentisi sürüm yönetimi.
 *
 * Üç şey bir arada: (1) sitelerdeki KURULU sürüm ("güncelleme çalışıyor mu" sorusunun cevabı),
 * (2) kaynaktan tek tuşla yayınlama (owner) + yayın işi durumu, (3) yayın geçmişi.
 */
export default async function ReleasesPage() {
  const [owner, releases, jobs, sites] = await Promise.all([
    isOwner().catch(() => false),
    getReleases().catch((e: unknown) => (e instanceof Error ? e : new Error('Bağlantı hatası'))),
    // Yardımcı bölümler ANA içeriği düşürmemeli: hata → boş liste.
    getPluginJobs().catch(() => [] as PluginJobRow[]),
    getSitePluginVersions().catch(() => [] as SitePluginRow[]),
  ]);

  const error = releases instanceof Error ? releases.message : null;
  const rows: ReleaseRow[] = releases instanceof Error ? [] : releases;
  const latest = rows[0]?.version ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Rocket}
        title="Sürümler"
        description="WP eklentisi sürüm geçmişi, yayınlama ve müşteri sitelerindeki kurulu sürümler."
      />

      <Alert>
        <Info />
        <AlertTitle>Nasıl çalışır?</AlertTitle>
        <AlertDescription>
          Yayınlanan sürümü müşteri siteleri kendi güncelleyicisiyle panelden çeker (WordPress →
          Güncellemeler; önbellek nedeniyle 12 saate kadar gecikebilir, "Tekrar denetle" anında
          tazeler). <strong>Kaynaktan yayınla</strong> bir istek kaydeder; VPS host'undaki runner
          depodaki (push edilmiş) eklenti kodundan paketi üretip yayınlar — panel konteynerine
          Docker/git yazma yetkisi verilmez.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
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
                <AlertTitle>Yetki gerekli</AlertTitle>
                <AlertDescription>
                  Sürüm yayınlamayı yalnız "owner" rolündeki yöneticiler tetikleyebilir.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle icon={ListChecks}>Yayın işleri</CardTitle>
          </CardHeader>
          <CardContent className={jobs.length === 0 ? '' : 'p-0'}>
            {jobs.length === 0 ? (
              <EmptyState
                icon={ListChecks}
                title="Henüz yayın işi yok"
                description="Kaynaktan yayınladığınızda işin durumu burada görünür."
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
                    const s = JOB_STATUS[j.status] ?? {
                      variant: 'neutral' as const,
                      label: 'bilinmiyor',
                    };
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
                      : cmpVersion(v, latest) < 0
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
                {rows.map((r, i) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums text-foreground">
                      <span className="inline-flex items-center gap-2">
                        v{r.version}
                        {i === 0 && <Badge variant="success">En yeni</Badge>}
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
              <AlertTitle>Yetki gerekli</AlertTitle>
              <AlertDescription>
                Elle paket yüklemeyi yalnız "owner" rolündeki yöneticiler yapabilir.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
