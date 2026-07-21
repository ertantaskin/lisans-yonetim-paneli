import { eq } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { orderLines, orders } from '../db/schema';

/**
 * Satır durumlarından sipariş genel durumunu yeniden hesaplar (complete + revoke ortak).
 * Saf: yalnız status günceller, event yazmaz — çağıran taraf event kararını verir.
 */
export async function recomputeOrderStatus(tx: Database, orderId: string): Promise<string> {
  const lines = await tx
    .select({ status: orderLines.status, canceled: orderLines.canceled })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));

  // İade/iptal (canceled) satırlar aktif iş sayılmaz — otomatik yeniden teslime uygun
  // değildir (§2). Sipariş durumu yalnız aktif satırlardan hesaplanır; tüm satırlar iade
  // edilmişse sipariş terminal 'revoked' olur (bekleyen işmiş gibi 'pending'e düşmez).
  const active = lines.filter((l) => !l.canceled);
  let status: 'pending' | 'partial' | 'fulfilled' | 'revoked';
  if (lines.length > 0 && active.length === 0) {
    status = 'revoked';
  } else {
    const allFulfilled = active.length > 0 && active.every((l) => l.status === 'fulfilled');
    const anyFulfilled = active.some((l) => l.status === 'fulfilled' || l.status === 'partial');
    status = allFulfilled ? 'fulfilled' : anyFulfilled ? 'partial' : 'pending';
  }

  await tx.update(orders).set({ status }).where(eq(orders.id, orderId));
  return status;
}
