'use server';
import { revalidatePath } from 'next/cache';
import { apiGet, apiPost, apiSend } from '../../lib/api';
import { getActor } from '../../lib/session';
import type { QuarantineItem } from './queries';

/**
 * Tedarikçi değişim fişi sunucu aksiyonları (§12).
 *
 * KRİTİK (Next 15): bu dosya YALNIZ async fonksiyon export edebilir. Başlangıç-durumu
 * objesi/sabit KOYULMAZ — `scripts/check-use-server.js` bunu yakalar ve bu hata bu projede
 * iki kez üretime çıktı (`next build` YAKALAMAZ, ekran çalışma anında patlar).
 *
 * Aksiyonlar THROW ETMEZ; `{ ok, error }` döndürür (panel deseni).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Fiş oluşturma/güncelleme sonrası tazelenen ekranlar. */
function revalidateClaims(claimId?: string): void {
  revalidatePath('/quarantine');
  revalidatePath('/quarantine/claims/[id]', 'page');
  revalidatePath('/suppliers/[id]', 'page');
  if (claimId) revalidatePath(`/quarantine/claims/${claimId}`);
}

/**
 * Z RAPORU ÖNİZLEMESİ: seçilen tedarikçi + tarih penceresinde biriken, HENÜZ BİLDİRİLMEMİŞ
 * kusurlu anahtarlar. Fiş kesilmeden önce operatör bu listeden istemediğini çıkarır.
 */
export async function fetchClaimCandidatesAction(input: {
  supplierId: string;
  from?: string;
  to?: string;
}): Promise<
  { ok: true; rows: QuarantineItem[]; truncated: boolean } | { ok: false; error: string }
> {
  const supplierId = String(input?.supplierId ?? '').trim();
  if (!UUID_RE.test(supplierId)) return { ok: false, error: 'Tedarikçi seçin.' };

  const qs = new URLSearchParams({ supplierId });
  if (input.from) qs.set('from', input.from);
  if (input.to) qs.set('to', input.to);

  try {
    const res = await apiGet<{ rows?: QuarantineItem[]; truncated?: boolean }>(
      `/v1/admin/supplier-claims/candidates?${qs.toString()}`,
    );
    return {
      ok: true,
      rows: Array.isArray(res?.rows) ? res.rows : [],
      truncated: res?.truncated === true,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Adaylar alınamadı.' };
  }
}

/** Fiş kes (Z raporu). Sunucu adayları KİLİT ALTINDA tazeden okur — önizleme bayat olabilir. */
export async function createClaimAction(input: {
  supplierId: string;
  from?: string;
  to?: string;
  excludeLicenseItemIds?: string[];
  note?: string;
}): Promise<{ ok: true; id: string; code: string; itemCount: number } | { ok: false; error: string }> {
  const supplierId = String(input?.supplierId ?? '').trim();
  if (!UUID_RE.test(supplierId)) return { ok: false, error: 'Tedarikçi seçin.' };

  const exclude = Array.from(new Set((input.excludeLicenseItemIds ?? []).map(String))).filter((v) =>
    UUID_RE.test(v),
  );

  try {
    const res = await apiPost<{ id: string; code: string; itemCount: number }>(
      '/v1/admin/supplier-claims',
      {
        supplierId,
        from: input.from || undefined,
        to: input.to || undefined,
        excludeLicenseItemIds: exclude.length ? exclude : undefined,
        note: input.note?.trim() ? input.note.trim().slice(0, 2000) : undefined,
      },
      await getActor(),
    );
    revalidateClaims(res.id);
    return { ok: true, id: res.id, code: res.code, itemCount: Number(res.itemCount ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Fiş oluşturulamadı.' };
  }
}

/** Durum geçişi: Gönderildi / Kapat / İptal (+ tedarikçi referansı, not). */
export async function updateClaimAction(input: {
  id: string;
  status?: 'sent' | 'closed' | 'canceled';
  reference?: string;
  note?: string;
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const id = String(input?.id ?? '').trim();
  if (!UUID_RE.test(id)) return { ok: false, error: 'Geçersiz fiş.' };
  try {
    const res = await apiSend<{ status: string }>(
      'PATCH',
      `/v1/admin/supplier-claims/${id}`,
      {
        status: input.status,
        reference: input.reference,
        note: input.note,
      },
      await getActor(),
    );
    revalidateClaims(id);
    return { ok: true, status: String(res?.status ?? '') };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Fiş güncellenemedi.' };
  }
}

/**
 * Kalem sonucu işaretle (tedarikçinin yanıtı).
 * `rejected` → anahtar HAVUZA GERİ DÖNER ve yeniden fişlenebilir.
 */
export async function updateClaimItemsAction(input: {
  claimId: string;
  itemIds: string[];
  outcome: 'pending' | 'replaced' | 'credited' | 'rejected';
  note?: string;
}): Promise<{ ok: true; affected: number } | { ok: false; error: string }> {
  const claimId = String(input?.claimId ?? '').trim();
  if (!UUID_RE.test(claimId)) return { ok: false, error: 'Geçersiz fiş.' };
  const itemIds = Array.from(new Set((input.itemIds ?? []).map(String))).filter((v) =>
    UUID_RE.test(v),
  );
  if (itemIds.length === 0) return { ok: false, error: 'Hiç kalem seçilmedi.' };

  try {
    const res = await apiSend<{ affected: number }>(
      'PATCH',
      `/v1/admin/supplier-claims/${claimId}/items`,
      { itemIds, outcome: input.outcome, note: input.note?.trim() || undefined },
      await getActor(),
    );
    revalidateClaims(claimId);
    return { ok: true, affected: Number(res?.affected ?? 0) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Sonuç işaretlenemedi.' };
  }
}
