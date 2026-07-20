import Link from 'next/link';
import { apiGet, type OrderDetail } from '../../../lib/api';
import { Card, PageHeader, StatusPill, Empty } from '../../../components/ui';
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
      <div>
        <PageHeader title="Sipariş" />
        <Card>
          <p className="text-sm text-destructive">Sipariş yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { order, lines, assignments, events, emails } = data;

  return (
    <div className="max-w-4xl">
      <Link href="/orders" className="text-sm text-primary hover:underline">
        ← Siparişler
      </Link>
      <div className="mt-2">
        <PageHeader title={`Sipariş ${order.remoteOrderId}`} desc={order.customerEmail} />
      </div>
      <div className="mb-4">
        <StatusPill status={order.status} />
      </div>

      <div className="grid gap-5">
        {/* Satırlar + Kalanları Ata */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Satırlar</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Satır</th>
                  <th className="px-3 py-2 font-medium">Adet</th>
                  <th className="px-3 py-2 font-medium">Teslim</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {lines.map((l) => (
                  <tr key={l.id} className="border-b border-border">
                    <td className="px-3 py-2.5 font-medium text-foreground">{l.remoteLineId}</td>
                    <td className="px-3 py-2.5 tabular-nums">{l.qty}</td>
                    <td className="px-3 py-2.5 tabular-nums">
                      {l.fulfilledQty}/{l.qty}
                    </td>
                    <td className="px-3 py-2.5">
                      <StatusPill status={l.status} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {l.status !== 'fulfilled' && (
                        <form action={completeLineAction}>
                          <input type="hidden" name="lineId" value={l.id} />
                          <input type="hidden" name="orderId" value={order.id} />
                          <button
                            type="submit"
                            className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
                          >
                            Kalanları Ata
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        {/* Atamalar (maskeli) + revoke */}
        <Card>
          <h2 className="mb-3 text-sm font-semibold text-foreground">Atamalar (lisanslar)</h2>
          {assignments.length === 0 ? (
            <Empty>Henüz atama yok.</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                    <th className="px-3 py-2 font-medium">Lisans (maskeli)</th>
                    <th className="px-3 py-2 font-medium">Adet</th>
                    <th className="px-3 py-2 font-medium">Kullanım</th>
                    <th className="px-3 py-2 font-medium">Geçerlilik</th>
                    <th className="px-3 py-2 font-medium">Durum</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {assignments.map((a) => {
                    const vu = fmtValidUntil(a.validUntil);
                    const isMulti = a.maxUses > 1;
                    return (
                      <tr key={a.id} className="border-b border-border align-top">
                        <td className="px-3 py-2.5">
                          <AssignmentLicenseCell
                            assignmentId={a.id}
                            kind={a.kind}
                            maskedPayload={a.maskedPayload}
                            maskedFields={a.maskedFields}
                          />
                        </td>
                        <td className="px-3 py-2.5 tabular-nums">{a.units}</td>
                        <td className="px-3 py-2.5 tabular-nums text-foreground/70">
                          {isMulti ? `${a.useCount}/${a.maxUses} (kalan ${a.maxUses - a.useCount})` : '—'}
                        </td>
                        <td className={`px-3 py-2.5 text-xs ${vu.expired ? 'text-warning' : 'text-foreground/70'}`}>
                          {vu.text}
                          {vu.expired && a.validUntil ? ' (doldu)' : ''}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusPill status={a.status} />
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          {a.status === 'active' && (
                            <form action={revokeAction}>
                              <input type="hidden" name="assignmentId" value={a.id} />
                              <input type="hidden" name="orderId" value={order.id} />
                              <input type="hidden" name="reason" value="iade/iptal" />
                              <button
                                type="submit"
                                className="rounded-md border border-destructive/40 px-3 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                              >
                                İptal
                              </button>
                            </form>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="grid gap-5 md:grid-cols-2">
          {/* Timeline */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Timeline</h2>
            <ul className="space-y-2 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex gap-2">
                  <span className="mt-1 size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="text-foreground/70">
                    <span className="font-medium text-foreground">{e.type}</span>
                    {e.message ? ` — ${e.message}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </Card>

          {/* Mailler */}
          <Card>
            <h2 className="mb-3 text-sm font-semibold text-foreground">Teslimat Mailleri</h2>
            {emails.length === 0 ? (
              <Empty>Mail yok.</Empty>
            ) : (
              <ul className="space-y-2 text-sm">
                {emails.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span className="truncate text-foreground/70">{m.subject}</span>
                    <StatusPill status={m.status} />
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
