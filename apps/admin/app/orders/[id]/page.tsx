import Link from 'next/link';
import { ArrowLeft, ListChecks, KeyRound, PackageCheck, CalendarClock, Mail, History } from 'lucide-react';
import { apiGet, type OrderDetail } from '../../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatTile } from '../../../components/ui/stat-tile';
import { StatusBadge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { AssignmentLicenseCell } from '../../../components/assignment-license-cell';
import { completeLineAction, revokeAction } from './actions';

/** ISO tarihi tr-TR biçimler; süresi geçmişse amber vurgu bilgisi döner. */
function fmtValidUntil(iso: string | null): { text: string; expired: boolean } {
  if (!iso) return { text: '—', expired: false };
  const d = new Date(iso);
  return {
    text: d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }),
    expired: d.getTime() < Date.now(),
  };
}

export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data: OrderDetail | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<OrderDetail>(`/v1/admin/orders/${id}`);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/orders">
            <ArrowLeft /> Siparişler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Sipariş yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { order, lines, assignments, events, emails } = data;
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const totalFulfilled = lines.reduce((s, l) => s + l.fulfilledQty, 0);
  const createdAt = new Date(order.createdAt).toLocaleString('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <div className="space-y-6">
      {/* Başlık */}
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/orders">
            <ArrowLeft /> Siparişler
          </Link>
        </Button>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Sipariş {order.remoteOrderId}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">{order.customerEmail}</p>
          </div>
          <StatusBadge status={order.status} className="mt-1" />
        </div>
      </div>

      {/* Özet */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Satır" value={lines.length} icon={ListChecks} tone="neutral" />
        <StatTile
          label="Teslim"
          value={`${totalFulfilled}/${totalQty}`}
          icon={PackageCheck}
          tone={totalFulfilled >= totalQty && totalQty > 0 ? 'success' : 'warning'}
          hint={totalFulfilled >= totalQty ? 'tamamlandı' : 'kısmi/bekliyor'}
        />
        <StatTile label="Atama" value={assignments.length} icon={KeyRound} tone="accent" />
        <StatTile label="Oluşturma" value={createdAt} icon={CalendarClock} tone="neutral" />
      </div>

      {/* Satırlar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="size-4 text-muted-foreground" /> Satırlar
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Satır</TableHead>
                <TableHead>Adet</TableHead>
                <TableHead>Teslim</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead className="text-right">Aksiyon</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-medium text-foreground">{l.remoteLineId}</TableCell>
                  <TableCell className="tabular-nums">{l.qty}</TableCell>
                  <TableCell className="tabular-nums">
                    {l.fulfilledQty}/{l.qty}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={l.status} />
                  </TableCell>
                  <TableCell className="text-right">
                    {l.status !== 'fulfilled' && (
                      <form action={completeLineAction}>
                        <input type="hidden" name="lineId" value={l.id} />
                        <input type="hidden" name="orderId" value={order.id} />
                        <Button type="submit" size="sm">
                          Kalanları Ata
                        </Button>
                      </form>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Atamalar */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" /> Atamalar (lisanslar)
          </CardTitle>
        </CardHeader>
        <CardContent className={assignments.length === 0 ? '' : 'p-0'}>
          {assignments.length === 0 ? (
            <EmptyState icon={KeyRound} title="Henüz atama yok" description="Stok geldiğinde burada görünür." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Lisans (maskeli)</TableHead>
                  <TableHead>Adet</TableHead>
                  <TableHead>Kullanım</TableHead>
                  <TableHead>Geçerlilik</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Aksiyon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {assignments.map((a) => {
                  const vu = fmtValidUntil(a.validUntil);
                  const isMulti = a.maxUses > 1;
                  return (
                    <TableRow key={a.id} className="align-top">
                      <TableCell>
                        <AssignmentLicenseCell
                          assignmentId={a.id}
                          kind={a.kind}
                          maskedPayload={a.maskedPayload}
                          maskedFields={a.maskedFields}
                        />
                      </TableCell>
                      <TableCell className="tabular-nums">{a.units}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {isMulti ? `${a.useCount}/${a.maxUses} (kalan ${a.maxUses - a.useCount})` : '—'}
                      </TableCell>
                      <TableCell
                        className={`text-xs ${vu.expired ? 'text-warning' : 'text-muted-foreground'}`}
                      >
                        {vu.text}
                        {vu.expired && a.validUntil ? ' (doldu)' : ''}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={a.status} />
                      </TableCell>
                      <TableCell className="text-right">
                        {a.status === 'active' && (
                          <form action={revokeAction}>
                            <input type="hidden" name="assignmentId" value={a.id} />
                            <input type="hidden" name="orderId" value={order.id} />
                            <input type="hidden" name="reason" value="iade/iptal" />
                            <Button type="submit" variant="danger-outline" size="sm">
                              İptal
                            </Button>
                          </form>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Timeline */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" /> Zaman Çizelgesi
            </CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <p className="text-sm text-muted-foreground">Kayıt yok.</p>
            ) : (
              <ol className="relative space-y-4 border-l border-border pl-5">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
                    <div className="text-sm font-medium text-foreground">{e.type}</div>
                    {e.message && <div className="text-sm text-muted-foreground">{e.message}</div>}
                    <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                      {new Date(e.createdAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        {/* Mailler */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Mail className="size-4 text-muted-foreground" /> Teslimat Mailleri
            </CardTitle>
          </CardHeader>
          <CardContent>
            {emails.length === 0 ? (
              <p className="text-sm text-muted-foreground">Mail yok.</p>
            ) : (
              <ul className="space-y-2.5 text-sm">
                {emails.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-foreground">{m.subject}</span>
                    <StatusBadge status={m.status} />
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
