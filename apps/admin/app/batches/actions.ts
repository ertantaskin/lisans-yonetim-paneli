'use server';
import { revalidatePath } from 'next/cache';
import { apiPost, isUuid } from '../../lib/api';
import { getActor } from '../../lib/session';

/**
 * SEC-1 — YOL ENJEKSİYONU: parti kimliği doğrudan API YOLUNA gömülür ve sunucu aksiyonları
 * TS tiplerini ÇALIŞMA ANINDA zorlamaz (uç dışarıdan serileştirilmiş argümanla çağrılabilir).
 * `!id` kontrolü boşluğu kapatmıyordu: `'../sites/<id>/rotate-secret?x='` gibi bir değer boş
 * DEĞİL ama WHATWG URL normalizasyonuyla BAŞKA (owner-only) bir uca düşerdi. Kimlik artık
 * UUID kalıbına bağlanır; `lib/api` merkezî kapısı ikinci savunma hattıdır.
 */

export interface ActionState {
  ok: boolean;
  error?: string;
}

/** Recall sonucu — void edilen satılmamış adet + değişim gerektiren satılmış adet. */
export interface RecallResult extends ActionState {
  voided?: number;
  soldNeedingReplacement?: number;
  /** Aktif + ASKIDA — parti detayındaki "Müşterilerdeki lisanslar" listesiyle aynı küme. */
  customerHeld?: number;
}

/**
 * Partiyi geri çek (recall) — sebep zorunlu (sebepsiz değişiklik imkânsız, §12).
 * API: batch.status='recalled'; satılmamış (available) license_items iptal statüsüne çekilir
 * + stock_adjustments('recall') + audit_log. Satılmış adet değişim gerektirir (uyarı döner).
 */
export async function recallBatchAction(id: string, reason: string): Promise<RecallResult> {
  if (!isUuid(id)) return { ok: false, error: 'Geçersiz parti kimliği — liste yenilenmeli.' };
  if (!reason.trim()) return { ok: false, error: 'Sebep zorunlu' };
  try {
    const res = await apiPost<{
      voided: number;
      soldNeedingReplacement: number;
      customerHeld?: number;
    }>(
      `/v1/admin/batches/${id}/recall`,
      { reason: reason.trim() },
      await getActor(),
    );
    revalidatePath('/batches');
    return {
      ok: true,
      voided: res.voided,
      soldNeedingReplacement: res.soldNeedingReplacement,
      customerHeld: res.customerHeld,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Geri çekilemedi' };
  }
}

/** Toplu değiştirme sonucu — değiştirilen + stok yok atlanan + sistem hatası alan kalem sayısı. */
export interface BulkReplaceResult extends ActionState {
  total?: number;
  replaced?: number;
  skippedNoStock?: number;
  /**
   * ALTYAPI ARIZASI (deadlock / statement_timeout / havuz tükenmesi) yüzünden işlenemeyen kalem.
   * "Stok yok"tan AYRI: eskiden ikisi tek sayaçta toplanıyor ve ekran altyapı arızasını "uygun
   * stok yoktu" diye yazıyordu — stok DOLUYKEN (operatör yanlış işe yönlendiriliyordu).
   */
  failed?: number;
}

/**
 * Partiye ait satılmış kalemleri toplu değiştir (§13). API: her satılmış + aktif atamalı
 * kalem için MEVCUT değişim makinesi (revoke + yeni atama); stok bitince o kalem atlanır.
 * Dön: { total, replaced, skippedNoStock }.
 */
export async function bulkReplaceBatchAction(id: string): Promise<BulkReplaceResult> {
  if (!isUuid(id)) return { ok: false, error: 'Geçersiz parti kimliği — liste yenilenmeli.' };
  try {
    const res = await apiPost<{
      total: number;
      replaced: number;
      skippedNoStock: number;
      failed?: number;
    }>(`/v1/admin/batches/${id}/bulk-replace`, {}, await getActor());
    revalidatePath('/batches');
    return {
      ok: true,
      total: res.total,
      replaced: res.replaced,
      skippedNoStock: res.skippedNoStock,
      // Eski API imajı bu alanı döndürmeyebilir (admin ve api ayrı dağıtılır) → `?? 0`.
      failed: res.failed ?? 0,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Toplu değiştirme başarısız' };
  }
}
