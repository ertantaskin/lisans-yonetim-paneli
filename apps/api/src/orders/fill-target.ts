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
import { sql, type SQL } from 'drizzle-orm';

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

/**
 * SQL KARŞILIKLARI — aynı yüklemin okuma yollarındaki TEK kaynağı (`notExpiredCond` deseni).
 *
 * NEDEN VAR (denetim R1): "kaç birim eksik" sorusunun İKİ tanımı vardı. Yazma yolları
 * (completeLine / recompute / revoke) `remainingUnits` ile `qty − canceled_units − fulfilled_qty`
 * hesaplarken; stok önizlemesi, bekleyen kuyruğu ve satır tanısı SQL'de `qty − fulfilled_qty`
 * yazıyordu. qty=5, 3 teslim, 1 atama iptal (canceled_units=1, fulfilled=2) örneğinde gerçek
 * kalan 2 iken üç ekran da 3 diyordu → stok girişi onay modali "bu giriş 3 bekleyen birimi
 * teslim eder" gibi TUTULAMAYACAK bir söz veriyordu.
 *
 * `alias` sorgudaki tablo adı/takma adıdır: raw SQL'de `ol`, drizzle sorgu kurucusunda
 * tablo adı (`order_lines`). `coalesce` savunmacıdır — kolon NOT NULL DEFAULT 0'dır
 * (migration 0036), ama LEFT JOIN'li bir çağıran satırsız kalırsa NULL aritmetiği sessizce
 * tüm ifadeyi NULL yapardı.
 */
export function fillTargetSql(alias = 'order_lines'): SQL {
  const qty = sql.raw(`"${alias}"."qty"`);
  const canceled = sql.raw(`coalesce("${alias}"."canceled_units", 0)`);
  return sql`greatest(${qty} - ${canceled}, 0)`;
}

/** `remainingUnits`'in SQL karşılığı: hedeften teslim edileni düş (asla negatif değil). */
export function remainingUnitsSql(alias = 'order_lines'): SQL {
  const fulfilled = sql.raw(`coalesce("${alias}"."fulfilled_qty", 0)`);
  return sql`greatest(${fillTargetSql(alias)} - ${fulfilled}, 0)`;
}

/** Satır durumu — hedef ile teslim edilenden türer (recompute + revoke ortak). */
export function lineStatusFor(
  line: FillTargetLine & { fulfilledQty: number },
): 'pending' | 'partial' | 'fulfilled' {
  const target = fillTarget(line);
  if (line.fulfilledQty >= target) return 'fulfilled';
  return line.fulfilledQty > 0 ? 'partial' : 'pending';
}
