import type { Product } from '../db/schema';
import { assignAvailableSingleUse, consumeMultiUseCapacity, type Executor } from './assign';

export interface Allocation {
  licenseItemId: string;
  units: number;
}

/**
 * Ürün tipine göre atama (tek/çok kullanımlık). Hem sipariş oluşturma hem
 * tamamlama motoru bunu kullanır — tek kaynak.
 */
export async function allocate(
  tx: Executor,
  product: Pick<Product, 'id' | 'usageMode'>,
  units: number,
): Promise<Allocation[]> {
  if (units <= 0) return [];

  if (product.usageMode === 'multi') {
    const byKey = new Map<string, number>();
    for (let i = 0; i < units; i++) {
      const id = await consumeMultiUseCapacity(tx, product.id, 1);
      if (!id) break;
      byKey.set(id, (byKey.get(id) ?? 0) + 1);
    }
    return [...byKey.entries()].map(([licenseItemId, u]) => ({ licenseItemId, units: u }));
  }

  const ids = await assignAvailableSingleUse(tx, product.id, units);
  return ids.map((id) => ({ licenseItemId: id, units: 1 }));
}
