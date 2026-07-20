import { apiGet, type ProductRow, type SiteRow } from '../../lib/api';

/** Şablon satırı — API zenginleştirilmiş yanıtı (ürün adı + site domain). */
export interface TemplateRow {
  id: string;
  subject: string;
  body: string;
  productId: string | null;
  siteId: string | null;
  productName: string | null;
  siteDomain: string | null;
  createdAt: string;
}

export function listTemplates(): Promise<TemplateRow[]> {
  return apiGet<TemplateRow[]>('/v1/admin/templates');
}

export function getTemplate(id: string): Promise<TemplateRow> {
  return apiGet<TemplateRow>(`/v1/admin/templates/${id}`);
}

/** Editör dropdown'ları için ürün + site listesi (kapsam: site override > ürün). */
export function listProducts(): Promise<ProductRow[]> {
  return apiGet<ProductRow[]>('/v1/admin/products');
}

export function listSites(): Promise<SiteRow[]> {
  return apiGet<SiteRow[]>('/v1/admin/sites');
}
