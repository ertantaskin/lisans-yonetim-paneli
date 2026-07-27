import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ShoppingCart,
  KeyRound,
  Mail,
  History,
  RefreshCw,
  LifeBuoy,
  Archive,
  ShieldAlert,
  Store,
  PackageCheck,
} from 'lucide-react';
import { apiGet, ApiError, type OrderDetail } from '../../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
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

/** ISO tarihi tr-TR biçimler; süresi geçmişse amber vurgu bilgisi döner. */
function fmtValidUntil(iso: string | null): { text: string; expired: boolean } {
  if (!iso) return { text: '', expired: false };
  const d = new Date(iso);
  return {
    text: d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }),
    expired: d.getTime() < Date.now(),
  };
}

/** Tek aktif lisans satırı — kompakt: anahtar + yanında Göster, sağda ikon aksiyonlar. */
function LicenseRow({ a, orderId }: { a: Assignment; orderId: string }) {
  const vu = fmtValidUntil(a.validUntil);
  const isMulti = a.maxUses > 1;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <AssignmentLicenseCell kind={a.kind} payload={a.payload} fields={a.fields} />
      </div>
      <StatusBadge status={a.status} />
      {isMulti && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {a.useCount}/{a.maxUses} kullanım
        </span>
      )}
      {vu.text && (
        <span className={`text-xs ${vu.expired ? 'text-warning' : 'text-muted-foreground'}`}>
          {vu.text}
          {vu.expired ? ' (doldu)' : ''}
        </span>
      )}
      <div className="ml-auto">
        <AssignmentActions assignmentId={a.id} orderId={orderId} status={a.status} />
      </div>
    </div>
  );
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

  // Atamaları satır (ürün kalemi) bazında grupla → ürün-merkezli tek görünüm (Satırlar + Aktif
  // Lisanslar birleşti; kullanıcı "ikisi çakışıyor, karışık" dedi). Aktif/askıda ürün kartında;
  // iptal/değiştirilen/expired olanlar en altta katlanır "Geçmiş" bölümünde (karmaşa yaratmasın).
  const asgByLine = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const arr = asgByLine.get(a.lineId);
    if (arr) arr.push(a);
    else asgByLine.set(a.lineId, [a]);
  }
  const isActive = (a: Assignment) => a.status === 'active' || a.status === 'suspended';
  const terminalAsg = assignments.filter((a) => !isActive(a));
  // Bonus (sentetik) satırlar en sona; asıl ürün kalemleri önce.
  const isBonusLine = (remoteLineId: string) => remoteLineId.startsWith('bonus:');
  const sortedLines = [...lines].sort(
    (x, y) => Number(isBonusLine(x.remoteLineId)) - Number(isBonusLine(y.remoteLineId)),
  );

  // Çok ürün kalemli siparişte kartları ayırt edilebilir kılmak için ürün kalemi başına ince bir
  // sol kenar aksan rengi (chart paleti — monokrom UI'da nötr kalır; kullanıcı isteği). Yalnız
  // birden çok GERÇEK ürün kalemi (bonus hariç) varsa uygulanır; tek üründe gereksiz.
  const CARD_ACCENTS = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ];
  const productLineCount = sortedLines.filter((l) => !isBonusLine(l.remoteLineId)).length;
  const lineAccent = new Map<string, string | null>();
  {
    let pIdx = 0;
    for (const l of sortedLines) {
      lineAccent.set(
        l.id,
        productLineCount > 1 && !isBonusLine(l.remoteLineId)
          ? CARD_ACCENTS[pIdx++ % CARD_ACCENTS.length]
          : null,
      );
    }
  }

  const openReplacements = replacements.filter(
    (r) => r.status === 'open' || r.status === 'info_requested',
  ).length;
  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const totalFulfilled = lines.reduce((s, l) => s + l.fulfilledQty, 0);
  const activeCount = assignments.filter(isActive).length;
  const fullyDelivered = totalFulfilled >= totalQty && totalQty > 0;
  const createdAt = new Date(order.createdAt).toLocaleString('tr-TR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return (
    <div className="space-y-4">
      {/* ── Başlık: Woo sipariş no (h1) + belirgin Site & WooCommerce çipleri ── */}
      <div className="space-y-2.5">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/orders">
            <ArrowLeft /> Siparişler
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm sm:flex"
              aria-hidden
            >
              <ShoppingCart className="size-5" />
            </span>
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Sipariş #{order.remoteOrderId}
              </h1>
              {/* Site + WooCommerce sipariş no belirgin çipler (kullanıcı isteği) */}
              <div className="flex flex-wrap items-center gap-2">
                {order.siteDomain && (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground">
                    <Store className="size-3.5 text-muted-foreground" />
                    {order.siteDomain}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground">
                  <ShoppingCart className="size-3.5 text-muted-foreground" />
                  WooCommerce #{order.remoteOrderId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {order.customerEmail} · {createdAt}
                </span>
              </div>
            </div>
          </div>
          <StatusBadge status={order.status} className="mt-1" />
        </div>

        {/* Tek satırlık ince özet şeridi */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-lg border border-border bg-card px-4 py-2 text-sm">
          <span className="inline-flex items-center gap-1.5">
            <PackageCheck className={`size-4 ${fullyDelivered ? 'text-success' : 'text-warning'}`} />
            <span className="text-muted-foreground">Teslim</span>
            <strong className="tabular-nums text-foreground">
              {totalFulfilled}/{totalQty}
            </strong>
            <span className="text-xs text-muted-foreground">
              {fullyDelivered ? 'tamamlandı' : 'kısmi/bekliyor'}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="size-4 text-muted-foreground" />
            <strong className="tabular-nums text-foreground">{activeCount}</strong>
            <span className="text-muted-foreground">aktif lisans</span>
            {terminalAsg.length > 0 && (
              <span className="text-xs text-muted-foreground">· {terminalAsg.length} geçmiş</span>
            )}
          </span>
          {openReplacements > 0 && (
            <Link href="#destek" className="inline-flex items-center gap-1.5 text-warning hover:underline">
              <LifeBuoy className="size-4" />
              <strong>{openReplacements}</strong> açık destek talebi
            </Link>
          )}
        </div>
      </div>

      {/* İnceleme (held) uyarısı — teslimat neden durdu + doğru ekran. */}
      {order.heldForReview && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-foreground">
            Bu sipariş <strong>güvenlik incelemesinde</strong> — teslimat manuel onay bekliyor.{' '}
            <Link href="/review" className="font-medium text-primary underline-offset-2 hover:underline">
              İnceleme Kuyruğu
            </Link>
            'ndan onaylayın veya reddedin. (Onaya kadar teslimat yapılmaz.)
          </div>
        </div>
      )}

      {/* ── İki kolon: sol (geniş) ürünler+lisanslar; sağ (dar) destek + referans ── */}
      <div className="grid gap-4 lg:grid-cols-3">
        {/* SOL (geniş) — ana çalışma alanı */}
        <div className="space-y-4 lg:col-span-2">
          <section className="space-y-3">
            <div className="flex items-center gap-2 px-0.5">
              <KeyRound className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Ürünler ve Lisanslar
              </h2>
            </div>

            {sortedLines.map((l) => {
              const lineAsg = asgByLine.get(l.id) ?? [];
              const activeLine = lineAsg.filter(isActive);
              const bonus = isBonusLine(l.remoteLineId);
              const accent = lineAccent.get(l.id);
              // "Kalanları Ata" yalnız gerçekten eksik + işlenebilir satırda (held/canceled/bonus hariç).
              const incomplete = l.status !== 'fulfilled' && !l.canceled && !order.heldForReview && !bonus;
              return (
                <Card
                  key={l.id}
                  className="overflow-hidden"
                  style={accent ? { borderLeftWidth: '4px', borderLeftColor: accent } : undefined}
                >
                  {/* Ürün başlığı: ad + teslim durumu + (eksikse) Kalanları Ata */}
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-4 py-2.5">
                    <div className="min-w-0">
                      <div className="font-semibold text-foreground">
                        {l.productName ?? (l.productId ? '—' : 'Ürün eşlenmemiş')}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {bonus ? 'Bonus lisans (ek teslimat)' : `kalem #${l.remoteLineId} · ${l.qty} adet`}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm tabular-nums text-muted-foreground">
                        <strong className="text-foreground">
                          {l.fulfilledQty}/{l.qty}
                        </strong>{' '}
                        teslim
                      </span>
                      {l.canceled ? (
                        <Badge variant="danger">İade/İptal</Badge>
                      ) : (
                        <StatusBadge status={l.status} />
                      )}
                      {incomplete && <CompleteLineButton lineId={l.id} orderId={order.id} />}
                    </div>
                  </div>
                  {/* Bu ürünün aktif anahtarları */}
                  <div>
                    {activeLine.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-muted-foreground">
                        {lineAsg.length > 0
                          ? 'Aktif lisans yok — anahtarlar iptal/değiştirilmiş (aşağıdaki geçmişe bakın).'
                          : l.canceled
                            ? 'İade/iptal edildi.'
                            : 'Henüz lisans atanmadı.'}
                      </p>
                    ) : (
                      activeLine.map((a) => <LicenseRow key={a.id} a={a} orderId={order.id} />)
                    )}
                  </div>
                </Card>
              );
            })}
          </section>

          {/* Geçmiş / iptal edilen lisanslar — katlanır, sönük. */}
          {terminalAsg.length > 0 && (
            <details className="group rounded-xl border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground">
                <Archive className="size-4" />
                Geçmiş / iptal edilen lisanslar ({terminalAsg.length})
                <span className="ml-auto text-xs text-muted-foreground group-open:hidden">göster</span>
                <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">gizle</span>
              </summary>
              <div className="border-t border-border">
                {terminalAsg.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 opacity-90 first:border-t-0"
                  >
                    <span className="text-sm text-foreground">{a.productName ?? '—'}</span>
                    <code className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                      {a.kind === 'account'
                        ? (a.fields?.map((f) => `${f.label}: ${f.value}`).join(' / ') ?? '—')
                        : a.payload || '—'}
                    </code>
                    <StatusBadge status={a.status} />
                    {a.revokeReason && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Sebep: <span className="text-foreground/80">{a.revokeReason}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Değişim geçmişi (eski anahtarlar) — katlanır referans. */}
          {history.length > 0 && (
            <details className="group rounded-xl border border-border bg-card">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground">
                <RefreshCw className="size-4" />
                Değişim geçmişi — eski anahtarlar ({history.length})
                <span className="ml-auto text-xs text-muted-foreground group-open:hidden">göster</span>
                <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">gizle</span>
              </summary>
              <div className="overflow-x-auto border-t border-border">
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
                          {new Date(h.createdAt).toLocaleString('tr-TR', {
                            dateStyle: 'short',
                            timeStyle: 'short',
                          })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          )}
        </div>

        {/* SAĞ (dar) rail — destek + teslimat mailleri + zaman çizelgesi */}
        <div className="space-y-4">
          {replacements.length > 0 && (
            <Card
              id="destek"
              className={openReplacements > 0 ? 'scroll-mt-4 border-warning/50' : 'scroll-mt-4'}
            >
              <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
                <CardTitle icon={LifeBuoy} className="text-sm">
                  Destek Talepleri
                  {openReplacements > 0 && (
                    <span className="ml-2 rounded-full bg-warning/15 px-2 py-0.5 text-xs font-medium text-warning">
                      {openReplacements} açık
                    </span>
                  )}
                </CardTitle>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Link href="/support">Tümü</Link>
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <OrderReplacements replacements={replacements} orderId={order.id} />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-3">
              <CardTitle icon={Mail} className="text-sm">
                Teslimat Mailleri
              </CardTitle>
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

          <Card>
            <CardHeader className="pb-3">
              <CardTitle icon={History} className="text-sm">
                Zaman Çizelgesi
              </CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <EmptyState icon={History} title="Kayıt yok" description="Sipariş olayları burada listelenir." />
              ) : (
                <ol className="relative max-h-96 space-y-4 overflow-y-auto border-l border-border pl-5">
                  {events.map((e) => (
                    <li key={e.id} className="relative">
                      <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
                      <div className="text-sm font-medium text-foreground">{eventTypeLabel(e.type)}</div>
                      {e.message && <div className="text-sm text-muted-foreground">{e.message}</div>}
                      <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                        {new Date(e.createdAt).toLocaleString('tr-TR', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        })}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
