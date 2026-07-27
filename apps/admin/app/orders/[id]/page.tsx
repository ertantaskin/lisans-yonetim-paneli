import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ShoppingCart, ListChecks, KeyRound, PackageCheck, CalendarClock, Mail, History, RefreshCw, LifeBuoy, Archive, ShieldAlert, Store } from 'lucide-react';
import { apiGet, ApiError, type OrderDetail } from '../../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatTile } from '../../../components/ui/stat-tile';
import { StatusBadge, Badge } from '../../../components/ui/badge';
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
import { eventTypeLabel } from '../../../lib/labels';
import { CompleteLineButton, AssignmentActions, ResendButton } from './order-actions';
import { OrderReplacements } from './order-replacements';

type Assignment = OrderDetail['assignments'][number];

/** Atama tablosu — aktif (aksiyonlu) ve geçmiş (aksiyonsuz, sönük) listelerde paylaşılır. */
function AssignmentTable({
  rows,
  orderId,
  showActions,
}: {
  rows: Assignment[];
  orderId: string;
  showActions: boolean;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>Ürün</TableHead>
          <TableHead>Lisans (maskeli)</TableHead>
          <TableHead>Adet</TableHead>
          <TableHead>Kullanım</TableHead>
          <TableHead>Geçerlilik</TableHead>
          <TableHead>Durum</TableHead>
          {showActions && <TableHead className="text-right">Aksiyon</TableHead>}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((a) => {
          const vu = fmtValidUntil(a.validUntil);
          const isMulti = a.maxUses > 1;
          return (
            <TableRow key={a.id} className="align-top">
              <TableCell className="font-medium text-foreground">
                {a.productName ?? '—'}
              </TableCell>
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
              <TableCell className={`text-xs ${vu.expired ? 'text-warning' : 'text-muted-foreground'}`}>
                {vu.text}
                {vu.expired && a.validUntil ? ' (doldu)' : ''}
              </TableCell>
              <TableCell>
                <StatusBadge status={a.status} />
              </TableCell>
              {showActions && (
                <TableCell className="text-right">
                  <AssignmentActions assignmentId={a.id} orderId={orderId} status={a.status} />
                </TableCell>
              )}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

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
    if (e instanceof ApiError && e.status === 404) notFound();
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

  const { order, lines, assignments, events, emails, history, replacements } = data;
  // Aktif/askıdaki lisanslar operatörün asıl ilgilendiği liste; iptal/değiştirilen/süresi-geçmiş
  // olanlar karmaşa yaratmasın diye ayrı, sönük ve katlanır bir bölüme alınır (kullanıcı isteği).
  const activeAsg = assignments.filter((a) => a.status === 'active' || a.status === 'suspended');
  const terminalAsg = assignments.filter((a) => a.status !== 'active' && a.status !== 'suspended');
  const openReplacements = replacements.filter(
    (r) => r.status === 'open' || r.status === 'info_requested',
  ).length;
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
          <div className="flex items-start gap-3">
            <span
              className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm sm:flex"
              aria-hidden
            >
              <ShoppingCart className="size-5" />
            </span>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Sipariş {order.remoteOrderId}
              </h1>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span>{order.customerEmail}</span>
                {order.siteDomain && (
                  <span className="inline-flex items-center gap-1 text-foreground">
                    <Store className="size-3.5 text-muted-foreground" />
                    {order.siteDomain}
                  </span>
                )}
              </p>
            </div>
          </div>
          <StatusBadge status={order.status} className="mt-1" />
        </div>
      </div>

      {/* İnceleme kuyruğu uyarısı — held sipariş normal 'bekliyor' gibi görünmesin, operatör
          neden teslim edilmediğini anlasın + doğru ekrana yönlensin (denetim bulgusu). */}
      {order.heldForReview && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-foreground">
            Bu sipariş <strong>güvenlik incelemesinde</strong> — teslimat manuel onay bekliyor.{' '}
            <Link href="/review" className="font-medium text-primary underline-offset-2 hover:underline">
              İnceleme Kuyruğu
            </Link>
            'ndan onaylayın veya reddedin. (Onaya kadar "Kalanları Ata" çalışmaz.)
          </div>
        </div>
      )}

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
          <CardTitle icon={ListChecks}>Satırlar</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Ürün</TableHead>
                <TableHead>Adet</TableHead>
                <TableHead>Teslim</TableHead>
                <TableHead>Durum</TableHead>
                <TableHead className="text-right">Aksiyon</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>
                    <div className="font-medium text-foreground">
                      {l.productName ?? (l.productId ? '—' : 'Ürün eşlenmemiş')}
                    </div>
                    <div className="text-xs text-muted-foreground">kalem #{l.remoteLineId}</div>
                  </TableCell>
                  <TableCell className="tabular-nums">{l.qty}</TableCell>
                  <TableCell className="tabular-nums">
                    {l.fulfilledQty}/{l.qty}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <StatusBadge status={l.status} />
                      {l.canceled && <Badge variant="danger">İade/İptal</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    {/* Held/canceled satırda 'Kalanları Ata' no-op olurdu → butonu gösterme. */}
                    {l.status !== 'fulfilled' && !l.canceled && !order.heldForReview && (
                      <CompleteLineButton lineId={l.id} orderId={order.id} />
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Değişim / Destek Talepleri (§13) — müşteri "Sorun Bildir" yaptıysa burada görünür +
          bağlamında onaylanır (değiştir) / reddedilir. Açık talep varsa vurgulu. */}
      {replacements.length > 0 && (
        <Card className={openReplacements > 0 ? 'border-warning/50' : undefined}>
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle icon={LifeBuoy}>
              Değişim / Destek Talepleri
              {openReplacements > 0 && (
                <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                  {openReplacements} açık
                </span>
              )}
            </CardTitle>
            <Button asChild variant="ghost" size="sm">
              <Link href="/support">Destek ekranı</Link>
            </Button>
          </CardHeader>
          <CardContent className="p-0">
            <OrderReplacements replacements={replacements} orderId={order.id} />
          </CardContent>
        </Card>
      )}

      {/* Aktif lisanslar (aksiyonlu) */}
      <Card>
        <CardHeader>
          <CardTitle icon={KeyRound}>Aktif Lisanslar</CardTitle>
        </CardHeader>
        <CardContent className={activeAsg.length === 0 ? '' : 'p-0'}>
          {activeAsg.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="Aktif lisans yok"
              description={
                assignments.length > 0
                  ? 'Tüm atamalar iptal/değiştirilmiş — aşağıdaki geçmişe bakın.'
                  : 'Stok geldiğinde burada görünür.'
              }
            />
          ) : (
            <AssignmentTable rows={activeAsg} orderId={order.id} showActions />
          )}
        </CardContent>
      </Card>

      {/* Geçmiş / iptal edilen lisanslar — katlanır, sönük (karmaşa yaratmasın). */}
      {terminalAsg.length > 0 && (
        <details className="group rounded-xl border border-border bg-card">
          <summary className="flex cursor-pointer items-center gap-2 px-5 py-3 text-sm font-medium text-muted-foreground marker:content-none">
            <Archive className="size-4" />
            Geçmiş / iptal edilen lisanslar ({terminalAsg.length})
            <span className="ml-auto text-xs text-muted-foreground group-open:hidden">göster</span>
            <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">gizle</span>
          </summary>
          <div className="border-t border-border opacity-75">
            <AssignmentTable rows={terminalAsg} orderId={order.id} showActions={false} />
          </div>
        </details>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        {/* Timeline */}
        <Card>
          <CardHeader>
            <CardTitle icon={History}>Zaman Çizelgesi</CardTitle>
          </CardHeader>
          <CardContent>
            {events.length === 0 ? (
              <EmptyState icon={History} title="Kayıt yok" description="Sipariş olayları burada listelenir." />
            ) : (
              <ol className="relative space-y-4 border-l border-border pl-5">
                {events.map((e) => (
                  <li key={e.id} className="relative">
                    <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
                    <div className="text-sm font-medium text-foreground">{eventTypeLabel(e.type)}</div>
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
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle icon={Mail}>Teslimat Mailleri</CardTitle>
            <ResendButton orderId={order.id} />
          </CardHeader>
          <CardContent>
            {emails.length === 0 ? (
              <EmptyState icon={Mail} title="Mail yok" description="Teslimat mailleri burada görünür." />
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

      {/* Değişim geçmişi (§3/§7 "eski anahtarlar") — yalnız değişim olduysa görünür. */}
      {history.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle icon={RefreshCw}>Değişim Geçmişi (eski anahtarlar)</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Eski key</TableHead>
                  <TableHead>Sebep</TableHead>
                  <TableHead>Yapan</TableHead>
                  <TableHead className="text-right">Tarih</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((h) => (
                  <TableRow key={h.id}>
                    <TableCell className="font-mono text-xs text-foreground">
                      {/* key-tipi ölü anahtar TAM (karantina, satışa dönmez); account maskeli. */}
                      {h.oldValue ?? h.oldMasked}
                    </TableCell>
                    <TableCell className="text-sm text-foreground">{h.reason}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{h.actor}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                      {new Date(h.createdAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
