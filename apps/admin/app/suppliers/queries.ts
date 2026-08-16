import 'server-only';
import { apiGet } from '@/lib/api';

/** Tedarikçi (§12). Pasifleştirme active=false ile (silinmez — geçmiş referanslar korunur). */
export interface SupplierRow {
  id: string;
  name: string;
  contact: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** GET /v1/admin/suppliers — tüm tedarikçiler (aktif + pasif). */
export async function getSuppliers(): Promise<SupplierRow[]> {
  return apiGet<SupplierRow[]>('/v1/admin/suppliers');
}

/** Karne parti satırı (§12). */
export interface ScorecardBatch {
  id: string;
  label: string;
  status: string;
  qtyReceived: number;
  createdAt: string;
}

/** Tedarikçi teslim-maliyeti (para birimi başına AYRI; karışım tek toplama birleştirilmez). */
export interface SupplierCostByCurrency {
  currency: string;
  cents: number;
}

/**
 * Tedarikçi KUSUR karnesi (`SupplierDefects`, apps/api/src/procurement/suppliers.service.ts).
 *
 * NEDEN AYRI: `recallRate` PARTİ düzeyindedir ("kaç parti geri çekildi"); "hangi tedarikçi
 * bozuk ANAHTAR gönderiyor" sorusunun cevabı panelde HİÇ yoktu. Uç bu bloğu zaten hesaplıyor,
 * tip bilmediği için ekrana çıkmıyordu.
 */
export interface SupplierDefects {
  /** Bu tedarikçiden gelen TOPLAM lisans kalemi (parti üzerinden). */
  totalItems: number;
  /** Ölü (quarantined|voided) kalem sayısı. */
  deadItems: number;
  /** deadItems / totalItems (0..1); kalem yoksa 0. */
  defectRate: number;
  /** Henüz hiçbir değişim fişine girmemiş kusurlu kalem — "bildirilmeyi bekliyor". */
  unclaimedItems: number;
  /** Açık (taslak|gönderildi) fiş sayısı. */
  openClaims: number;
  /** Kapanmış fişlerde ort. çözülme süresi (gün); VERİ YOKSA null — 0 ile karıştırılmamalı. */
  avgResolutionDays: number | null;
  /** Fiş kalemlerinin tedarikçi yanıtı kırılımı. */
  replacedItems: number;
  rejectedItems: number;
}

/** Tedarikçi karnesi (§12) — PO/parti agregaları + lead süresi + geri-çekilme + kusur oranı. */
export interface SupplierScorecard {
  supplier: SupplierRow;
  poCount: number;
  totalOrdered: number;
  totalReceived: number;
  avgLeadDays: number | null;
  openPoCount: number;
  batches: ScorecardBatch[];
  recallRate: number;
  totalCostCents: SupplierCostByCurrency[];
  /**
   * Tedarikçinin GERÇEK parti sayısı — `batches.length` DEĞİL (liste sunucuda kırpılabilir;
   * kırpılmış listeden sayaç türetmek uyarının yanına YANLIŞ bir toplam koyardı).
   *
   * OPSİYONEL (dağıtım sapması): admin, API'den ÖNCE dağıtılırsa alan gelmez → ekran liste
   * uzunluğuna düşer ve kırpma varsa "N+" ile dürüst belirsizlik yazar.
   */
  batchCount?: number;
  /** Parti listesi sunucu penceresine dayandı mı — true ise EKRANDAKİ LİSTE EKSİKTİR. */
  batchesTruncated?: boolean;
  /** Kusur/iade karnesi. OPSİYONEL: eski API imajında blok hiç gelmez → bölüm gizlenir. */
  defects?: SupplierDefects;
}

/** GET /v1/admin/suppliers/:id/scorecard — tek tedarikçi performans karnesi. */
export async function getSupplierScorecard(id: string): Promise<SupplierScorecard> {
  return apiGet<SupplierScorecard>(`/v1/admin/suppliers/${encodeURIComponent(id)}/scorecard`);
}
