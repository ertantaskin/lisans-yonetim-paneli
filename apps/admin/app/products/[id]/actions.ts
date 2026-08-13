'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../../lib/api';
import { getActor } from '../../../lib/session';

export interface StockAdjustState {
  ok: boolean;
  error?: string;
  saved?: boolean;
  /**
   * Düzeltme SATILABİLİR STOKU gerçekten değiştirdi mi (bir lisans kalemi 'voided' oldu mu)?
   * Dürüstlük kuralı: kalem seçilmeyen düzeltme yalnız DEFTER kaydıdır — stok aynı kalır ve
   * form bunu "Eklendi" yeşiliyle gizlememelidir (operatör bozuk anahtarları düşürdüğünü sanıyordu).
   */
  affectedStock?: boolean;
  /** Deftere yazılan gerçek adet (kalem-kapsamlı iptalde API kalemden türetir). */
  qty?: number;
}

// NOT: 'use server' dosyası YALNIZ async fonksiyon export edebilir (Next 15). Başlangıç durumu
// objesi ('const … = { ok:false }') buradan export EDİLEMEZ — aksi halde tüm action chunk'ı
// "can only export async functions, found object" ile patlar ve sayfadaki HER server action bozulur.
// Başlangıç durumu tüketici istemci bileşeninde (stock-adjust-form.tsx) tanımlıdır.

const ACTIONS = ['void', 'damage', 'correct', 'recall'] as const;
type AdjustAction = (typeof ACTIONS)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Manuel stok düzeltme (§12) — POST /v1/admin/stock-adjustments. Sebep ZORUNLU
 * (sebepsiz değişiklik imkânsız; audit'e düşer). Gövde şekli controller ile birebir:
 * productId + action(void|damage|correct|recall) + qty(≥0) + reason + (ops.) licenseItemId.
 * void/damage'de licenseItemId verilirse o available lisans satırı 'voided' yapılır.
 */
export async function createStockAdjustmentAction(
  _prev: StockAdjustState,
  formData: FormData,
): Promise<StockAdjustState> {
  const productId = String(formData.get('productId') || '').trim();
  if (!productId) return { ok: false, error: 'Ürün id zorunlu' };

  const action = String(formData.get('action') || '') as AdjustAction;
  if (!ACTIONS.includes(action)) return { ok: false, error: 'Geçersiz aksiyon' };

  const reason = String(formData.get('reason') || '').trim();
  if (!reason) return { ok: false, error: 'Sebep zorunlu (audit için)' };

  const qtyRaw = String(formData.get('qty') || '0').trim();
  const qty = Number(qtyRaw);
  if (!Number.isInteger(qty) || qty < 0) return { ok: false, error: 'Adet 0 veya pozitif tam sayı olmalı' };

  const licenseItemId = String(formData.get('licenseItemId') || '').trim();
  // void/damage = "bu anahtarı stoktan düş" demektir ve artık ENVANTER TABLOSUNDAN çoklu
  // seçimle yapılır (bkz. bulkAdjustLicenseItemsAction). Bu form yalnız kalem-kapsamsız
  // DEFTER kaydı yazar; kalem seçilmemiş yıkıcı istek gelirse stok sessizce değişmemiş
  // olurdu → açık hata ver, operatörü doğru ekrana yönlendir.
  const destructive = action === 'void' || action === 'damage';
  if (destructive && !UUID_RE.test(licenseItemId)) {
    return {
      ok: false,
      error:
        'Geçersiz kıl / Hasarlı işlemi Envanter listesinden yapılır: satırları işaretleyip toplu aksiyonu kullanın. Bu form yalnız defter kaydı yazar.',
    };
  }

  const body: {
    productId: string;
    action: AdjustAction;
    qty: number;
    reason: string;
    licenseItemId?: string;
  } = { productId, action, qty, reason };
  if (licenseItemId) body.licenseItemId = licenseItemId;

  try {
    // API artık TOPLU sonuç döndürür: { rows, requested, affected, skipped, qtyTotal }.
    // `affected` GERÇEKTEN stoktan düşen kalem sayısıdır — bu form için 0 olması normaldir.
    const res = await apiPost<{ affected?: number; qtyTotal?: number } | null>(
      '/v1/admin/stock-adjustments',
      body,
      await getActor(),
    );
    revalidatePath(`/products/${productId}`);
    revalidatePath('/stock');
    const affected = Number(res?.affected ?? 0);
    return {
      ok: true,
      saved: true,
      affectedStock: affected > 0,
      qty: affected > 0 ? Number(res?.qtyTotal ?? qty) : qty,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Düzeltme kaydedilemedi' };
  }
}
