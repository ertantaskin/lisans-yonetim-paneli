import { Logger } from '@nestjs/common';
import type { Product } from '../db/schema';
import { assignAvailableSingleUse, consumeMultiUseCapacity, type Executor } from './assign';

/** Modül düzeyi: `allocate` bir Nest servisi değil, saf fonksiyon (DI yok). */
const logger = new Logger('allocate');

export interface Allocation {
  licenseItemId: string;
  units: number;
}

/**
 * AYRI ANAHTAR (`one-per-key`) fazının azami tur sayısı — SESSİZ DEĞİL, aşılınca loglanır.
 *
 * NEDEN ŞART: spread fazı BİRİM başına bir UPDATE atar. `qty` üst sınırı 100.000 ve bundle
 * çarpanı var; korumasız bir spread, `consumeMultiUseCapacity`'nin tam olarak çözdüğü
 * performans arızasını ("200 birim = 200 sıralı UPDATE, kilitler tutulurken") bu politika
 * altında geri getirirdi — üstelik `idle_in_transaction_session_timeout` (60 sn) ve Fastify
 * `requestTimeout` (30 sn) duvarları var.
 *
 * 100 seçimi: ~100 gidiş-dönüş birkaç yüz ms; dışlama listesi ≤100 uuid parametresi; 100
 * anahtarlık bir teslimat maili zaten müşteri tarafında okunabilir sınırın üstünde.
 * `allocate()` SATIR BAŞINA çağrılır → çok satırlı siparişte toplam = Σ satır.
 */
export const MAX_SPREAD_KEYS = 100;

/**
 * Ürün tipine göre atama (tek/çok kullanımlık). Hem sipariş oluşturma hem
 * tamamlama motoru bunu kullanır — tek kaynak.
 *
 * MAK DAĞITIMI ÜRÜN AYARINA BAĞLIDIR (`multiUseDistribution`):
 *   · `fewest-keys` (varsayılan): sipariş başına EN AZ anahtar (aşağıdaki tek faz).
 *   · `one-per-key`: önce her birim AYRI anahtardan (Faz 1), ayrı anahtar bitince kalan
 *     talep AYNEN eski doldurma davranışıyla tamamlanır (Faz 2).
 */
export async function allocate(
  tx: Executor,
  product: Pick<Product, 'id' | 'usageMode' | 'multiUseDistribution'>,
  units: number,
  opts?: {
    /**
     * Bu SATIRIN müşteride ZATEN duran anahtarları — `one-per-key` politikasında dışlanır.
     *
     * NEDEN ŞART: politika "her birimi ayrı anahtardan ver" der ama `allocate` satır başına
     * BİRDEN ÇOK kez çağrılabilir (kısmi teslim → stok gelince tamamlama, "Kalanları Ata",
     * inceleme onayı, otomatik doldurma). Her çağrı KENDİ boş defteriyle başladığı için ikinci
     * tur FEFO/FIFO ilk anahtarı seçer — bu, müşterinin ilk turda ZATEN aldığı anahtar olabilir
     * ve politika SESSİZCE "en az anahtar" gibi davranır. Kapasite muhasebesi doğru kalır,
     * ama verilen söz tutulmaz; sessiz olduğu için de fark edilmezdi.
     */
    excludeItemIds?: readonly string[];
  },
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

    // ── FAZ 1 — AYRI ANAHTAR (yalnız one-per-key) ────────────────────────────────
    // Her tur BİR birim alır ve o anahtarı dışlar → bir sonraki tur FEFO/FIFO sırasındaki
    // BAŞKA anahtara gider. Ayrı anahtar kalmadığında sorgu null döner (dışlama listesi
    // sayesinde ayrım NET: "tur bitti" ile "hiç kapasite yok" aynı dala düşer ve ikisinde de
    // doğru hamle Faz 2'ye geçmektir — kapasite gerçekten bittiyse Faz 2 de null döner).
    if (product.multiUseDistribution === 'one-per-key') {
      // Dışlama = bu turda kullanılanlar + müşterinin bu satırda ZATEN sahip olduğu anahtarlar.
      const held = new Set(opts?.excludeItemIds ?? []);
      while (remaining > 0 && byKey.size < MAX_SPREAD_KEYS) {
        const take = await consumeMultiUseCapacity(tx, product.id, 1, {
          mode: 'spread',
          exclude: [...new Set([...held, ...byKey.keys()])],
        });
        if (!take || take.taken <= 0) break;
        byKey.set(take.licenseItemId, (byKey.get(take.licenseItemId) ?? 0) + take.taken);
        remaining -= take.taken;
      }
      if (remaining > 0 && byKey.size >= MAX_SPREAD_KEYS) {
        // SESSİZ KIRPMA YOK: politika bu satırda tam uygulanamadı, kalan doldurmayla gidiyor.
        logger.warn(
          `MAK "ayrı anahtar" fazı üst sınıra takıldı (ürün ${product.id}): ${MAX_SPREAD_KEYS} ` +
            `anahtar kullanıldı, ${remaining} birim doldurma moduyla tamamlanacak. Bu ürün ` +
            'yüksek adetli siparişler için "En az anahtar" politikasına daha uygun olabilir.',
        );
      }
    }

    // ── FAZ 2 — DOLDURMA (her iki politikada da AYNEN eski davranış) ─────────────
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
