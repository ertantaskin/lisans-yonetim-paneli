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

/** Tedarikçi karnesi (§12) — PO/parti agregaları + lead süresi + geri-çekilme oranı. */
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
}

/** GET /v1/admin/suppliers/:id/scorecard — tek tedarikçi performans karnesi. */
export async function getSupplierScorecard(id: string): Promise<SupplierScorecard> {
  return apiGet<SupplierScorecard>(`/v1/admin/suppliers/${encodeURIComponent(id)}/scorecard`);
}
