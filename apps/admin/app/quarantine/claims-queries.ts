import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Tedarikçi değişim fişlerinin veri katmanı (salt-okunur).
 *
 * SAVUNMACI TİPLER: api/admin dağıtımları arasında sapma olabilir (yeni alan önce backend'e
 * düşer) → tüm alanlar opsiyonel okunur, ekran `?? null` ile çalışır. Aynı gerekçe
 * `quarantine/queries.ts`'te de yazılı.
 */

export interface ClaimRow {
  id: string;
  code: string;
  /** 'draft' | 'sent' | 'closed' | 'canceled' */
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  itemCount: number;
  note: string | null;
  reference: string | null;
  createdBy: string;
  createdAt: string;
  sentAt: string | null;
  closedAt: string | null;
  pendingCount: number;
  replacedCount: number;
  creditedCount: number;
  rejectedCount: number;
  /**
   * Kalem anlık görüntülerinin EN AZ BİRİ maskeli mi (`••••••1234`).
   *
   * İki yoldan olabilir: (a) fişi KESEN kişi owner değildi → snapshot maskeli DONDU ve
   * sonradan owner açsa da maskeli kalır; (b) fişi OKUYAN owner değil → yanıt maskeli döner.
   * Her iki durumda indirilen rapor tedarikçiye işe yaramaz bir liste olarak gider →
   * ekranda uyarılır. Eski API sürümü bu alanı döndürmez (savunmacı: `=== true` kontrolü).
   *
   * DİKKAT — KAYNAK: bu alan API'nin SATIRINDA GELMEZ. `supplier-claims.service.detail()`
   * onu ZARFIN ÜST DÜZEYİNDE döndürür (`{ claim, items, masked }`) ve `list()` hiç
   * döndürmez. Alanı satırda okumak (`claim.masked`) bayrağı KALICI `undefined` bırakıyor,
   * yani maskeli rapor uyarısı HİÇ çıkmıyordu → owner-olmayanın kestiği `••••••1234`
   * listesi tedarikçiye sessizce gidiyordu. `fetchClaim` zarftaki değeri satıra TAŞIR;
   * `fetchClaims` (liste) bu alanı DOLDURMAZ ve dolduramaz — liste ekranında maske uyarısı
   * verilecekse önce API'nin listesi bu bayrağı döndürmelidir.
   */
  masked?: boolean;
}

export interface ClaimItemRow {
  id: string;
  licenseItemId: string;
  productId: string | null;
  batchId: string | null;
  batchLabel: string | null;
  productName: string | null;
  sku: string | null;
  /**
   * Fiş anındaki ürün tipi ('key' | 'account' | 'code' | 'custom'). 0034 öncesi kesilen
   * fişlerde ürün silinmişse null kalabilir → ekran nötr "kalem" diline düşer.
   */
  productKind: string | null;
  keySnapshot: string | null;
  reason: string | null;
  defectKind: string | null;
  quarantinedAt: string | null;
  /** 'pending' | 'replaced' | 'credited' | 'rejected' */
  outcome: string;
  outcomeNote: string | null;
  resolvedAt: string | null;
}

/**
 * Backend fiş listesi üst sınırı (`supplier-claims.service`: sabit `LIMIT 500`, `truncated`
 * bayrağı DÖNDÜRMEZ). API'yi değiştirmek bu işin kapsamı dışında — dürüstlük için tavana
 * DAYANILDIĞI istemcide tespit edilip ekranda söylenir (sessiz kırpma YOK; panelin kuralı).
 * Yanlış-pozitif riski: tam 500 fiş varsa uyarı boşuna çıkar — eksik liste göstermekten iyidir.
 */
export const CLAIM_LIST_LIMIT = 500;

export interface ClaimsData {
  rows: ClaimRow[];
  error: string | null;
  /** Satır sayısı sunucu tavanına dayandı → daha eski fişler listede olmayabilir. */
  truncated: boolean;
}

/** Fiş listesi (en yeni önce). Hata ekranı çökertmez — banner olarak gösterilir. */
export async function fetchClaims(): Promise<ClaimsData> {
  try {
    const raw = await apiGet<ClaimRow[] | { rows?: unknown }>('/v1/admin/supplier-claims');
    const list = Array.isArray(raw) ? raw : Array.isArray(raw?.rows) ? raw.rows : [];
    const rows = list as ClaimRow[];
    return { rows, error: null, truncated: rows.length >= CLAIM_LIST_LIMIT };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : 'Bağlantı hatası', truncated: false };
  }
}

export interface ClaimDetailData {
  claim: ClaimRow;
  items: ClaimItemRow[];
}

/**
 * Tek fiş + kalemleri (detay ekranı).
 *
 * HATA YUTULMAZ (denetim): eskiden `catch { return null }` ile HER hata `notFound()`'a
 * dönüşüyordu → API askıda (504), token bozuk (401) ya da 500 verdiğinde operatöre "fiş
 * bulunamadı" deniyordu; yani var olan bir fiş SİLİNMİŞ gibi okunuyordu. Kardeş detay
 * sayfalarının deseni (products / suppliers / purchase-orders / templates): sorgu FIRLATIR,
 * sayfa `ApiError.status === 404` dalında `notFound()` der, diğer hataları banner'a basar.
 *
 * `masked` bayrağı ZARFTAN satıra taşınır — gerekçe `ClaimRow.masked` jsdoc'unda.
 * Beklenmedik gövde (claim yok) `null` döner → sayfa `notFound()` (uydurma satır render edilmez).
 */
export async function fetchClaim(id: string): Promise<ClaimDetailData | null> {
  const raw = await apiGet<{ claim?: ClaimRow; items?: ClaimItemRow[]; masked?: boolean }>(
    `/v1/admin/supplier-claims/${id}`,
  );
  if (!raw?.claim) return null;
  return {
    claim: { ...raw.claim, masked: raw.masked },
    // Savunmacı: eski/kısmi yanıtta alan gelmezse tablo boş listeyle çizilir, sayfa çökmez.
    items: Array.isArray(raw.items) ? raw.items : [],
  };
}

export interface SuppliersLiteData {
  rows: Array<{ id: string; name: string }>;
  error: string | null;
}

/**
 * Tedarikçi seçici için (fiş kesme sihirbazı). Pasif tedarikçiler de listelenir (geçmiş fiş).
 *
 * HATA GÖRÜNÜR (denetim): eskiden `catch → []` idi. Sonuç sessizdi ama zararsız değildi —
 * panelden "Fiş oluştur" denince tedarikçi ÖN-SEÇİLİ gelir; liste boş olduğunda combobox
 * hâlâ "Tedarikçi seçin…" yazar ve operatör seçimin kaybolduğunu sanıp yanlış tedarikçi
 * arar. "Veri yok" ile "veri alınamadı" AYRI gösterilmeli (bkz. `api/saved-views/route.ts`).
 */
export async function fetchSuppliersLite(): Promise<SuppliersLiteData> {
  try {
    const raw = await apiGet<Array<{ id: string; name: string; active?: boolean }>>(
      '/v1/admin/suppliers',
    );
    const rows = (Array.isArray(raw) ? raw : []).map((s) => ({ id: s.id, name: s.name }));
    return { rows, error: null };
  } catch (e) {
    // `ApiError` de Error'dan türer → `.message` (API'nin Türkçe gövdesi ya da 504 metni) korunur.
    return { rows: [], error: e instanceof Error ? e.message : 'Bağlantı hatası' };
  }
}
