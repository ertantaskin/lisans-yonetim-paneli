'use server';
import { revalidatePath } from 'next/cache';
import { apiSend, isUuid } from '../../lib/api';
import { getActor } from '../../lib/session';
import { resolvePendingLinesAction } from '../stock/actions';

/**
 * SEC-1 — YOL ENJEKSİYONU: `encodeURIComponent` tek başına YETMEZ. `..` ve `/` kodlanır ama
 * uç, kimliği yine de yola gömer; ayrıca sunucu aksiyonları TS tiplerini ÇALIŞMA ANINDA
 * zorlamaz (uç dışarıdan serileştirilmiş argümanla çağrılabilir). Kimlik UUID kalıbına
 * bağlanır → şekli belli olmayan hiçbir değer yola girmez; `lib/api` merkezî kapısı ikinci
 * savunma hattıdır.
 */
const INVALID_MAPPING_ID = 'Geçersiz eşleme kimliği — liste yenilenip tekrar denenmeli.';

/**
 * Eşleme kaldırma — SONUÇ DÖNDÜREN sürüm (§3, dürüstlük kuralı).
 *
 * NEDEN AYRI: paylaşılan `app/stock/actions.removeMappingAction` basit bir form action'dır
 * (`void`) ve hatayı bilinçli olarak YUTAR — o desen ürün detayındaki kutu için yazılmıştı.
 * Katalog ekranında bunun bedeli şuydu: DELETE 500/ağ hatası alsa bile operatör "Kaldır"
 * dedikten sonra hiçbir şey görmüyor, satır listede duruyor ve bunu "sayfa tazelenmedi"
 * sanıyordu. Burada sonuç açıkça döner; çağıran başarı/başarısızlığı ekranda gösterir.
 *
 * Uç idempotenttir (404 → zaten yok): bu durum başarı sayılır, "kaldırıldı" denir.
 */
export async function removeMappingWithResult(
  mappingId: string,
): Promise<{ ok: boolean; error?: string }> {
  const id = String(mappingId ?? '').trim();
  if (!isUuid(id)) return { ok: false, error: INVALID_MAPPING_ID };
  try {
    await apiSend('DELETE', `/v1/admin/mappings/${encodeURIComponent(id)}`, undefined, await getActor());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Eşleme kaldırılamadı' };
  }
  revalidatePath('/mappings');
  return { ok: true };
}

/**
 * PASİF eşlemeyi ETKİNLEŞTİR (§3) — "pasifleştirilmiş eşleme çıkmaz sokağı"nın çıkışı.
 *
 * SORUN: okuma yolları (`listCatalog`/`listUnmapped`/`resolveMapping`) eşlemeyi yalnız `active`
 * iken sayar; `createMapping`'in mükerrer ön-kontrolü ise `active` koşulu TAŞIMAZ (aynı anahtara
 * ikinci satır açmak sessiz mükerrer üretirdi). Sonuç: operatör pasifleştirdiği eşlemeyi ekranda
 * "eşlenmemiş" görüyor, "Eşle" deyince 409 alıyor ve hiçbir çıkış yolu bulamıyordu. Doğru eylem
 * yeni eşleme kurmak DEĞİL, mevcut olanı geri açmaktır — bu action tam olarak onu yapar.
 *
 * Etkinleştirmenin ARDINDAN (best-effort) bekleyen satırlar geriye dönük çözülür: eşleme pasifken
 * gelen siparişlerin `product_id`'si NULL kalmıştır ve teslimat motoru onları hiç taramaz
 * (`createMappingAction` ile BİREBİR aynı desen). OTOMATİK EŞLEŞTİRME DEĞİL: yalnız operatörün
 * AZ ÖNCE geri açtığı eşleme eski satırlara uygulanır.
 *
 * Server action ASLA fırlatmaz; sonuç dürüstçe döner (sessiz "başarılı" yok).
 */
export async function activateMappingWithResult(
  mappingId: string,
  /** Geriye dönük çözüm kapsamı — verilmezse yalnız etkinleştirme yapılır (çözüm denenmez). */
  scope?: { siteId?: string; remoteProductId?: string; remoteVariationId?: string | null },
): Promise<{
  ok: boolean;
  error?: string;
  resolved?: { linked: number; delivered: number; stillPending: number };
}> {
  const id = String(mappingId ?? '').trim();
  if (!isUuid(id)) return { ok: false, error: INVALID_MAPPING_ID };
  try {
    await apiSend(
      'PATCH',
      `/v1/admin/mappings/${encodeURIComponent(id)}`,
      { active: true },
      await getActor(),
    );
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Eşleme etkinleştirilemedi' };
  }

  // Eşleme artık aktif — eski bekleyen satırları çözmeyi dene. Buradaki hata etkinleştirmeyi
  // BAŞARISIZ GÖSTERMEZ (kayıt zaten güncellendi); operatör /mappings'ten tekrar tetikleyebilir.
  let resolved: { linked: number; delivered: number; stillPending: number } | undefined;
  if (scope?.siteId && scope.remoteProductId) {
    const r = await resolvePendingLinesAction({
      siteId: scope.siteId,
      remoteProductId: scope.remoteProductId,
      ...(scope.remoteVariationId !== undefined
        ? { remoteVariationId: scope.remoteVariationId }
        : {}),
    });
    if (r.ok && r.result && (r.result.linked > 0 || r.result.delivered > 0)) {
      resolved = {
        linked: r.result.linked,
        delivered: r.result.delivered,
        stillPending: r.result.stillPending,
      };
    }
  }

  revalidatePath('/mappings');
  revalidatePath('/orders');
  revalidatePath('/pending');
  return { ok: true, ...(resolved ? { resolved } : {}) };
}
