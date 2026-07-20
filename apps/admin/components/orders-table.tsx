import Link from 'next/link';
import type { OrderRow } from '../lib/api';
import { StatusPill, Empty } from './ui';

export function OrdersTable({ orders }: { orders: OrderRow[] }) {
  if (orders.length === 0) return <Empty>Kayıt yok.</Empty>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-ink/10 text-left text-xs uppercase tracking-wide text-ink/50">
            <th className="px-3 py-2 font-medium">Sipariş No</th>
            <th className="px-3 py-2 font-medium">Müşteri</th>
            <th className="px-3 py-2 font-medium">Durum</th>
            <th className="px-3 py-2 font-medium">Tarih</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id} className="border-b border-ink/5 hover:bg-accent-soft/30">
              <td className="px-3 py-2.5 font-medium text-ink">{o.remoteOrderId}</td>
              <td className="px-3 py-2.5 text-ink/70">{o.customerEmail}</td>
              <td className="px-3 py-2.5">
                <StatusPill status={o.status} />
              </td>
              <td className="px-3 py-2.5 tabular-nums text-ink/50">
                {new Date(o.createdAt).toLocaleString('tr-TR')}
              </td>
              <td className="px-3 py-2.5 text-right">
                <Link href={`/orders/${o.id}`} className="text-accent hover:underline">
                  detay →
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
