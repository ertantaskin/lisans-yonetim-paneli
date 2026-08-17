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
    // Döngü BİRİM değil ANAHTAR başına döner: her tur uygun anahtardan kalanı kadarını
    // (LEAST(kalan talep, anahtarın kalanı)) alır. 500 kapasiteli anahtarlarda 200 birim
    // TEK gidiş-dönüşte karşılanır; eskiden 200 ayrı UPDATE round-trip'iydi (hepsi tek
    // transaction, kilitler tutulurken).
    //
    // DAĞILIM (bkz. consumeMultiUseCapacity): önce talebi TEK BAŞINA karşılayan anahtar
    // aranır → tipik sipariş TEK anahtar + TEK atama alır. Hiçbiri karşılamıyorsa eski
    // davranış: FEFO/FIFO ilk anahtar doldurulur, artan talep sonrakine taşar. Döngü her
    // turda KALAN talebe göre yeniden sorduğu için taşma turlarında da "kalanı tek başına
    // karşılayan" bir anahtar varsa o seçilir (gereksiz üçüncü anahtar açılmaz).
    const byKey = new Map<string, number>();
    let remaining = units;
    while (remaining > 0) {
      const take = await consumeMultiUseCapacity(tx, product.id, remaining);
      // `taken <= 0` normalde imkânsız (sorgu `use_count < max_uses` süzer) ama
      // olası bir gelecekteki şema/veri bozukluğunda sonsuz döngüye girmemek için
      // burada da duruyoruz — stok tükenmesiyle aynı dal.
      if (!take || take.taken <= 0) break;
      byKey.set(take.licenseItemId, (byKey.get(take.licenseItemId) ?? 0) + take.taken);
      remaining -= take.taken;
    }
    return [...byKey.entries()].map(([licenseItemId, u]) => ({ licenseItemId, units: u }));
  }

  const ids = await assignAvailableSingleUse(tx, product.id, units);
  return ids.map((id) => ({ licenseItemId: id, units: 1 }));
}
