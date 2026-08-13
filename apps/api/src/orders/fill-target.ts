/**
 * Bir sipariş satırının DOLDURMA HEDEFİ — kaç birim teslim edilmeli.
 *
 * TEK TANIM (bu projede "aynı kavramın iki yüklemi = sessiz yalan" sınıfı defalarca yaşandı):
 * hedef = `qty − canceled_units`.
 *
 *  - `qty`            : MAĞAZA GERÇEĞİ. Müşterinin ödediği adet; mağazadan gelen her re-push
 *                       (`reconcileOrder`) bunu yeniden yazar. Panel bunu kendi kararıyla
 *                       DEĞİŞTİRMEZ — değiştirirse bir sonraki senkron zaten geri alır.
 *  - `canceled_units` : Operatörün panelden KALICI iptal ettiği birimler (per-atama "İptal").
 *                       Mağazada karşılığı yoktur, bu yüzden re-push onu silemez → iptal edilen
 *                       birim taze anahtarla YENİDEN DOLDURULMAZ (§2 / H1 bedava-lisans sınıfı).
 *
 * Satırın TAMAMI iptal edildiyse `canceled=true` ayrıca terminal işaret olarak kalır (mevcut
 * davranış); bu yardımcı o durumda da doğru sonucu verir ama çağıranlar `canceled` kapısını
 * kendi guard'larında korumaya devam eder (savunma derinliği).
 */
export interface FillTargetLine {
  qty: number;
  canceledUnits?: number | null;
}

/** Teslim edilmesi gereken toplam birim (asla negatif değil). */
export function fillTarget(line: FillTargetLine): number {
  return Math.max(0, line.qty - (line.canceledUnits ?? 0));
}

/** Hedefe göre kalan birim (asla negatif değil). */
export function remainingUnits(line: FillTargetLine & { fulfilledQty: number }): number {
  return Math.max(0, fillTarget(line) - line.fulfilledQty);
}

/** Satır durumu — hedef ile teslim edilenden türer (recompute + revoke ortak). */
export function lineStatusFor(
  line: FillTargetLine & { fulfilledQty: number },
): 'pending' | 'partial' | 'fulfilled' {
  const target = fillTarget(line);
  if (line.fulfilledQty >= target) return 'fulfilled';
  return line.fulfilledQty > 0 ? 'partial' : 'pending';
}
