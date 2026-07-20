import { eq } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { orderLines, orders } from '../db/schema';

/**
 * Satır durumlarından sipariş genel durumunu yeniden hesaplar (complete + revoke ortak).
 * Saf: yalnız status günceller, event yazmaz — çağıran taraf event kararını verir.
 */
export async function recomputeOrderStatus(tx: Database, orderId: string): Promise<string> {
  const lines = await tx
    .select({ status: orderLines.status })
    .from(orderLines)
    .where(eq(orderLines.orderId, orderId));

  const allFulfilled = lines.length > 0 && lines.every((l) => l.status === 'fulfilled');
  const anyFulfilled = lines.some((l) => l.status === 'fulfilled' || l.status === 'partial');
  const status = allFulfilled ? 'fulfilled' : anyFulfilled ? 'partial' : 'pending';

  await tx.update(orders).set({ status }).where(eq(orders.id, orderId));
  return status;
}
