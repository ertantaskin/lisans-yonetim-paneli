/**
 * Müşteri risk skoru sözleşmesi (§8/§9) — TEK doğruluk kaynağı (API + admin paylaşır).
 *
 * Advisory (tavsiye) skor: OKUMA-ANINDA türetilir, KALICI DEĞİLDİR (hiçbir tabloya
 * yazılmaz) ve OTOMATİK EYLEM tetiklemez — "panel önerir, insan karar verir" (§15).
 * Skor 0-100 arası; band eşiklerle sınıflandırılır. Her faktör şeffaf gerekçe
 * (contribution + detail) taşır → "neden bu skor" izlenebilir; sır ASLA girmez.
 *
 * Not: Yalnız tip/kontrat — runtime bağımlılığı YOK (zod vb. içermez).
 */

/** Risk bandı — skor eşiklerinden türetilir (low < medium < high). */
export type RiskBand = 'low' | 'medium' | 'high';

/** Skora katkı veren tek bir faktör (şeffaf gerekçe). */
export interface RiskFactor {
  /** Makine anahtarı (ör. 'replacement_rate', 'security_events', 'tags', 'recency'). */
  key: string;
  /** İnsan-okur etiket. */
  label: string;
  /** Bu faktörün skora katkısı — pozitif artırır, negatif azaltır, nötr 0. */
  contribution: number;
  /** "Neden bu katkı" — sayısal/bağlamsal açıklama (sır İÇERMEZ). */
  detail: string;
}

/** Bir müşterinin advisory risk değerlendirmesi (okuma-anında türetilir). */
export interface CustomerRisk {
  /** Kanonik (lowercase) müşteri e-postası. */
  email: string;
  /** 0-100 arası advisory skor (yüksek = daha riskli). */
  score: number;
  /** Skor bandı. */
  band: RiskBand;
  /** Skoru oluşturan faktörler — HER ZAMAN dolu (şeffaf döküm). */
  factors: RiskFactor[];
  /** Hesaplama zaman damgası (ISO-8601). */
  generatedAt: string;
}
