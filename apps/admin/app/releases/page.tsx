import { Rocket, History, UploadCloud, Info } from 'lucide-react';
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
import { getReleases, type ReleaseRow } from './queries';
import { PublishForm } from './publish-form';

export const dynamic = 'force-dynamic';

/**
 * Sürümler (§16) — WP eklentisi sürüm yönetimi. Yayınlanmış sürümlerin geçmişini gösterir
 * ve yeni sürüm yayınlar. Müşteri siteleri bunu kendi güncelleyicisiyle otomatik çeker.
 */
export default async function ReleasesPage() {
  let releases: ReleaseRow[] = [];
  let error: string | null = null;
  try {
    releases = await getReleases();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Rocket}
        title="Sürümler"
        description="WP eklentisi sürüm geçmişi ve yeni sürüm yayınlama. Yayınlanan sürümü müşteri siteleri otomatik güncelleyebilir."
      />

      <Alert>
        <Info />
        <AlertTitle>Nasıl çalışır?</AlertTitle>
        <AlertDescription>
          Yeni sürüm yayınlandığında, eklentinin kurulu olduğu müşteri WordPress siteleri
          güncellemeyi panelden çeker (WordPress → Güncellemeler). CLI ile yayın:{' '}
          <code className="rounded bg-muted px-1 py-0.5 text-xs">scripts/release-plugin.sh 0.2.0</code>.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle icon={UploadCloud}>Yeni sürüm yayınla</CardTitle>
        </CardHeader>
        <CardContent>
          <PublishForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle icon={History}>Sürüm geçmişi</CardTitle>
        </CardHeader>
        <CardContent className={releases.length === 0 ? '' : 'p-0'}>
          {error ? (
            <p className="p-2 text-sm text-destructive">Sürümler yüklenemedi: {error}</p>
          ) : releases.length === 0 ? (
            <EmptyState icon={Rocket} title="Henüz sürüm yok" description="İlk sürümü yukarıdan yayınlayın." />
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
                {releases.map((r, i) => (
                  <TableRow key={r.id}>
                    <TableCell className="whitespace-nowrap font-medium tabular-nums text-foreground">
                      <span className="inline-flex items-center gap-2">
                        v{r.version}
                        {i === 0 && <Badge variant="success">en yeni</Badge>}
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
    </div>
  );
}
