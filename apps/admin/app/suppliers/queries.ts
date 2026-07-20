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
