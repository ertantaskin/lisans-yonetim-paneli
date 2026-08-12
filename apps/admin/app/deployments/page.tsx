import * as React from 'react';
import { Ship, History, CloudUpload, Info, Activity, Lock } from 'lucide-react';
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
import { getDeployments, getHealth, type DeploymentRow } from './queries';
import { DeployForm } from './deploy-form';
import { DeploymentsAutoRefresh } from './auto-refresh';

export const dynamic = 'force-dynamic';

const DEPLOY_STATUS: Record<string, { variant: NonNullable<BadgeProps['variant']>; label: string }> = {
  pending: { variant: 'warning', label: 'bekliyor' },
  running: { variant: 'accent', label: 'çalışıyor' },
  success: { variant: 'success', label: 'başarılı' },
  failed: { variant: 'danger', label: 'başarısız' },
};

const TARGET_LABEL: Record<string, string> = {
  api: 'API',
  admin: 'Admin',
  'api admin': 'API + Admin',
  // Aynı kuyruğu WP eklentisi yayınları da kullanır (runner publish-plugin.sh'a dallanır);
  // etiketsiz kalırsa geçmişte 'bilinmiyor' görünürdü. Yayın akışının kendisi /releases'te.
  plugin: 'Eklenti yayını',
};

function fmt(ts: string | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
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
  const [owner, health] = await Promise.all([
    isOwner().catch(() => false),
    getHealth().catch(() => null),
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

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Ship}
        title="Dağıtımlar"
        description="Canlı sürüm ve sağlık durumu, dağıtım geçmişi ve panelden prod'a dağıtım tetikleme."
      />

      <Alert>
        <Info />
        <AlertTitle>Nasıl çalışır?</AlertTitle>
        <AlertDescription>
          "Prod'a dağıt" bir <strong>dağıtım isteği kaydeder</strong>; VPS host'undaki runner
          (cron) bunu görüp <code className="rounded bg-muted px-1 py-0.5 text-xs">deploy.sh</code>{' '}
          ile git pull + build + sağlık kontrolü + gerekirse otomatik geri alma yapar ve sonucu
          buraya yazar. Güvenlik gereği panel konteynerine Docker erişimi verilmez.
        </AlertDescription>
      </Alert>

      <div className="grid gap-6 md:grid-cols-2">
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
                    {healthOk ? 'sağlıklı' : 'sorunlu'}
                  </Badge>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Sürüm (API)</span>
                  <span className="font-medium tabular-nums text-foreground">v{health.version}</span>
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
              <DeployForm />
            ) : (
              <Alert>
                <Lock />
                <AlertTitle>Yetki gerekli</AlertTitle>
                <AlertDescription>
                  Prod'a dağıtımı yalnız "owner" rolündeki yöneticiler tetikleyebilir.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>

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
                  // Savunmalı: bilinmeyen enum/slug kullanıcıya ham sızmasın → nötr Türkçe fallback.
                  const s = DEPLOY_STATUS[r.status] ?? { variant: 'neutral' as const, label: 'bilinmiyor' };
                  // Runner'ın gönderdiği çıktı (deploy.sh logunun kuyruğu) — API zaten yolluyordu
                  // ama ekranda hiç gösterilmiyordu: başarısız dağıtımda operatör build hatasını
                  // görmek için VPS'e SSH atmak zorunda kalıyordu. Savunmalı okunur (alan yoksa
                  // satır hiç basılmaz), başarısız dağıtımda VARSAYILAN AÇIK gelir.
                  const log = typeof r.log === 'string' && r.log.trim() ? r.log : null;
                  return (
                    <React.Fragment key={r.id}>
                    <TableRow>
                      <TableCell className="whitespace-nowrap font-medium text-foreground">
                        {TARGET_LABEL[r.target] ?? 'bilinmiyor'}
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
                              Log runner tarafından kırpılmış olabilir (yalnız son bölüm saklanır);
                              tam çıktı VPS&apos;teki dağıtım kaydındadır.
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
