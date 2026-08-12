'use server';
import { revalidatePath } from 'next/cache';
import { apiSend } from '../../lib/api';
import { getActor } from '../../lib/session';

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
  const id = mappingId.trim();
  if (!id) return { ok: false, error: 'Eşleme kimliği eksik' };
  try {
    await apiSend('DELETE', `/v1/admin/mappings/${encodeURIComponent(id)}`, undefined, await getActor());
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Eşleme kaldırılamadı' };
  }
  revalidatePath('/mappings');
  return { ok: true };
}
