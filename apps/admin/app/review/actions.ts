'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, isUuid } from '../../lib/api';
import { getActor } from '../../lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: sipariş kimliği doğrudan API YOLUNA gömülür ve sunucu aksiyonları
 * TS tiplerini ÇALIŞMA ANINDA zorlamaz (uç dışarıdan serileştirilmiş argümanla çağrılabilir).
 * `!orderId` kontrolü yetmiyordu: `'../sites/<id>/rotate-secret?x='` boş DEĞİL ama WHATWG URL
 * normalizasyonuyla owner-only bir uca düşerdi. `lib/api` merkezî kapısı ikinci savunma hattı.
 */
const INVALID_ORDER_ID = 'Geçersiz sipariş kimliği — kuyruk yenilenip tekrar denenmeli.';

/**
 * Aksiyon sonucu. `message` YALNIZ gerçekleşeni anlatır: onay sonrası hiçbir lisans
 * atanmadıysa (stok yok / all-or-nothing karşılanmadı) sonuç YEŞİL gösterilmez —
 * `tone: 'warning'` ile uyarılır (panelin "added=0'ı başarı sayma" dersi).
 */
export interface ActionState {
  ok: boolean;
  error?: string;
  /** Onay sonrası siparişin GERÇEK durumu (API `releaseHeld` yanıtı); alınamadıysa null. */
  status?: string | null;
  /** Operatöre gösterilecek sonuç cümlesi. */
  message?: string;
  /** Sonuç kutusunun tonu — 'warning' = işlem yapıldı ama İŞ BİTMEDİ. */
  tone?: 'success' | 'warning' | 'info';
}

/**
 * Onayla → hold kaldırılır ve teslimat çalışır (API fulfillment). Body YOK.
 * POST /v1/admin/orders/:id/release — audit'e düşer (actor).
 *
 * API'nin döndürdüğü GERÇEK sipariş durumu yukarı taşınır: eskiden yanıt yutuluyor ve satır
 * sessizce listeden düşüyordu → stok yetersizken hiçbir lisans atanmamış olmasına rağmen
 * operatör "onayladım, gitti" sanıp ekrandan ayrılıyordu (sipariş sessizce /pending'e düşüyor,
 * müşteri bekliyordu).
 */
export async function releaseAction(orderId: string): Promise<ActionState> {
  if (!isUuid(orderId)) return { ok: false, error: INVALID_ORDER_ID };
  try {
    const res = await apiPost<{ orderId?: string; released?: boolean; status?: string }>(
      `/v1/admin/orders/${orderId}/release`,
      undefined,
      await getActor(),
    );
    revalidatePath('/review');
    // Onaylanan sipariş kuyruktan düşer ama teslim edilemediyse Bekleyen Teslimatlar'a girer.
    revalidatePath('/pending');

    // SAVUNMACI: alan gelmemişse (sürüm sapması) durum UYDURULMAZ → sonuç "doğrula" der.
    const status = typeof res?.status === 'string' ? res.status : null;
    if (status === 'fulfilled') {
      return { ok: true, status, tone: 'success', message: 'Onaylandı — sipariş teslim edildi.' };
    }
    if (status === 'partial') {
      return {
        ok: true,
        status,
        tone: 'warning',
        message:
          'Onaylandı ama stok yetmedi: sipariş KISMEN teslim edildi, kalanı Bekleyen Teslimatlar’da. Ürüne stok girin — kalan otomatik tamamlanır.',
      };
    }
    if (status === 'pending') {
      return {
        ok: true,
        status,
        tone: 'warning',
        message:
          'Onaylandı ama HİÇBİR lisans atanmadı (stok yok ya da “ya hep ya hiç” politikası karşılanmadı). Sipariş Bekleyen Teslimatlar’a düştü; ürüne stok girin.',
      };
    }
    if (status === 'revoked' || status === 'canceled') {
      return {
        ok: true,
        status,
        tone: 'warning',
        message:
          'Sipariş bu arada iade/iptal edilmiş — teslimat yapılmadı, açılan atamalar geri alındı.',
      };
    }
    return {
      ok: true,
      status,
      tone: 'info',
      message:
        'Onaylandı. Teslimat sonucu okunamadı — siparişi açıp gerçekten teslim edildiğini doğrulayın.',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/**
 * Reddet → sipariş kapatılır, müşteriye key GİTMEZ. Sebep zorunlu (min 1).
 * POST /v1/admin/orders/:id/reject body { reason } — audit'e düşer (actor).
 */
export async function rejectAction(orderId: string, reason: string): Promise<ActionState> {
  if (!isUuid(orderId)) return { ok: false, error: INVALID_ORDER_ID };
  if (!reason.trim()) return { ok: false, error: 'Sebep zorunlu' };
  try {
    await apiPost(`/v1/admin/orders/${orderId}/reject`, { reason: reason.trim() }, await getActor());
    revalidatePath('/review');
    revalidatePath('/pending');
    return {
      ok: true,
      tone: 'info',
      message: 'Sipariş reddedildi — satırlar iptal edildi, müşteriye lisans gitmedi.',
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}
