import 'server-only';
import { apiGet } from '../../lib/api';

/**
 * Parti satırı (GET /v1/admin/batches yanıtı).
 * supplierName + product (sku/name) API tarafında JOIN ile getirilir.
 *
 * SAYAÇLAR (bkz. api/supply-ops.service.ts `listBatches`): kalemin envanter DURUMU ile
 * müşteride olup olmadığı AYRI eksenlerdir. Eski tek `soldCount` (= status<>'available')
 * elle geçersiz kılınmış/iade edilmiş/değiştirilmiş kalemleri de "satılmış" sayıyordu.
 * MAK anahtarı kısmen satılmışken hâlâ 'available' olduğu için kovalar TOPLANMAZ —
 * `totalCount` ayrı gelir, ekran "toplam = stokta + müşteride + düşmüş" DEMEMELİ.
 */
export interface BatchRow {
  id: string;
  label: string;
  supplierId: string | null;
  supplierName: string | null;
  productId: string;
  productSku: string;
  productName: string;
  /**
   * 'key' | 'account' | 'code' | 'custom' — parti tek ürüne bağlı olduğu için tipi bellidir.
   * Ekran metinleri buna göre "anahtar"/"hesap"/"kod" der (`lib/labels.itemCount`).
   * API sapmasında eksik gelebilir → çağıran `?? undefined` ile nötr "kalem" diline düşer.
   */
  productKind?: string;
  /** 'active' | 'recalled' | 'voided' */
  status: string;
  qtyReceived: number;
  /** Partiye kayıtlı toplam lisans kalemi. */
  totalCount: number;
  /** status='available' — geri çekmenin GEÇERSİZ KILACAĞI küme. */
  unsoldCount: number;
  /** Canlı ataması olan (active|suspended) — gerçekten müşterinin elinde. */
  customerCount: number;
  /** Aktif atamalı — otomatik toplu değiştirmeye aday (askıdakiler elle işlenir). */
  replaceableCount: number;
  /** Ne stokta ne müşteride: geçersiz/karantina/iade/değiştirilmiş/süresi geçmiş. */
  deadCount: number;
  receivedAt: string;
  notes: string | null;
  createdAt: string;
}

/**
 * Partileri getirir (receivedAt DESC), sunucu üst sınırıyla (500).
 *
 * `truncated`: liste tavana dayandı → EKRANDA SÖYLENİR. Sessizce kırpılan liste, operatöre
 * "o parti yok" dedirtir (bu projede yaşanmış sınıf: müşteri listesi LIMIT'i bu yüzden
 * kaldırılmıştı). API dizi VEYA {items} döndürebilir → ikisini de karşıla (deploy sapması).
 */
export async function getBatches(): Promise<{ items: BatchRow[]; truncated: boolean }> {
  const data = await apiGet<BatchRow[] | { items: BatchRow[]; truncated?: boolean }>(
    '/v1/admin/batches',
  );
  if (Array.isArray(data)) return { items: data, truncated: false };
  return { items: data?.items ?? [], truncated: data?.truncated === true };
}
