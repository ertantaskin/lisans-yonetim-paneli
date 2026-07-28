'use server';
import { revalidatePath } from 'next/cache';
import { apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

// NOT: 'use server' dosyası YALNIZ async fonksiyon export edebilir (Next 15). Sabit/obje
// export EDİLEMEZ — aksi halde tüm action chunk'ı "can only export async functions" ile patlar
// ve sayfadaki HER server action bozulur. Başlangıç durumları istemci bileşeninde tanımlıdır.
// (Tip/interface export'u derlemede silinir → sorun değil.)

export interface ActionState {
  ok: boolean;
  error?: string;
  /** Başarıda operatöre gösterilecek tek cümlelik sonuç (ekran-okuyucuya da duyurulur). */
  message?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOTE_MAX = 4000;

/**
 * Durum değişikliğinden sonra tazelenecek yollar. Destek talebi İKİ ekranda görünür
 * (/support kuyruğu + /orders/[id] destek kartı) → ikisi de tazelenmezse operatör
 * bayat durum görür ("onayladım ama siparişte hâlâ açık" şikâyeti).
 */
function revalidateSupport(orderId?: string) {
  revalidatePath('/support');
  if (orderId && UUID_RE.test(orderId)) revalidatePath(`/orders/${orderId}`);
}

/**
 * Talebi onayla → DEĞİŞİM: eskiyi geri al + aynı üründen TAZE lisans ata (API atomik
 * makineyi kullanır: advisory-lock + revoke + completeLine).
 * Stok yoksa API 409 döner → burada hata olarak yüzeye çıkar, talep 'approved' OLMAZ
 * ve ESKİ lisans korunur.
 */
export async function approveReplacementAction(
  id: string,
  orderId?: string,
): Promise<ActionState> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz talep' };
  try {
    await apiPost(`/v1/admin/replacements/${id}/approve`, {}, await getActor());
    revalidateSupport(orderId);
    return { ok: true, message: 'Değişim onaylandı, yeni lisans atandı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/** Talebi reddet — gerekçe zorunlu (müşteriye görünür `resolutionNote`). */
export async function rejectReplacementAction(
  id: string,
  note: string,
  orderId?: string,
): Promise<ActionState> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz talep' };
  const body = note.trim();
  if (!body) return { ok: false, error: 'Red gerekçesi zorunlu' };
  if (body.length > NOTE_MAX) return { ok: false, error: 'Gerekçe çok uzun (en fazla 4000 karakter)' };
  try {
    await apiPost(`/v1/admin/replacements/${id}/reject`, { note: body }, await getActor());
    revalidateSupport(orderId);
    return { ok: true, message: 'Talep reddedildi, müşteriye bildirildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}

/** Talep için müşteriden bilgi iste — not zorunlu (müşteriye görünür `resolutionNote`). */
export async function requestInfoReplacementAction(
  id: string,
  note: string,
  orderId?: string,
): Promise<ActionState> {
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz talep' };
  const body = note.trim();
  if (!body) return { ok: false, error: 'İstenen bilgi zorunlu' };
  if (body.length > NOTE_MAX) return { ok: false, error: 'Not çok uzun (en fazla 4000 karakter)' };
  try {
    await apiPost(`/v1/admin/replacements/${id}/request-info`, { note: body }, await getActor());
    revalidateSupport(orderId);
    return { ok: true, message: 'Bilgi talebi müşteriye iletildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlenemedi' };
  }
}
