'use server';
import { revalidatePath } from 'next/cache';
import { ApiError, apiPost } from '../../lib/api';
import { getActor } from '../../lib/session';

/**
 * KRİTİK (Next 15): bu dosya 'use server' taşır ve YALNIZ async fonksiyon EXPORT edebilir.
 * Aşağıdaki sabitler bilinçli olarak dosya-içi (export edilmez) — `scripts/check-use-server.js`
 * bunu denetler.
 */
/** Yeniden kuyruğa alınabilecek kayıt türleri (API yolunun ilk parçası). */
const REPLAY_KINDS: readonly string[] = ['outbox', 'email'];
/** Kayıt kimliği kalıbı — panelin ortak deseni (bkz. app/quarantine/claims-actions.ts). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ReplayState {
  ok: boolean;
  error?: string;
  /**
   * true → istek teknik olarak başarısız DEĞİL, KURALEN reddedildi (API 400): kayıt
   * teslimat maili değil / siparişe bağlı değil. UI bunu "hata" yerine "yapılamaz"
   * dili ile gösterebilir. Sessiz 400 bırakılmaz — gerekçe `error` alanındadır.
   */
  blocked?: boolean;
}

/**
 * Dead-letter kaydını yeniden kuyruğa alır (POST /v1/admin/ops/replay/:kind/:id).
 * Başarılıysa liste tazelenir (durum pending/queued'e döner).
 *
 * GÜVENLİK (§16): yalnız TESLİMAT maili ve webhook olayı replay edilebilir. Bir durum/
 * bildirim maili teslimat işi olarak yeniden kuyruğa alınsaydı worker siparişin TÜM aktif
 * atamalarını çözüp müşteriye anahtarları gönderirdi. Kural API'de uygulanır (tek kaynak);
 * burada 400 yanıtı AÇIK gerekçeyle yüzeye çıkarılır — `replayable=false` satırlarda ekran
 * aksiyonu zaten kapatır, bu dal ikinci savunma hattıdır (bayat sayfa/eş zamanlı değişim).
 */
export async function replayAction(kind: 'outbox' | 'email', id: string): Promise<ReplayState> {
  // GİRDİ DOĞRULAMASI — ÇALIŞMA ANINDA (denetim bulgusu, orta/güvenlik).
  // TS tipleri sunucu aksiyonlarında ZORLANMAZ: action uç noktası dışarıdan da çağrılabilir
  // ve parametreler serileştirilmiş gövdeden gelir. Değerler doğrudan API YOLUNA gömüldüğü
  // için `replayAction('..', '../deployments/claim')` gibi bir çağrı WHATWG URL
  // normalizasyonuyla BAŞKA bir admin ucuna düşebilirdi (yol enjeksiyonu). Bu yüzden `kind`
  // beyaz listeye, `id` UUID kalıbına bağlanır (kayıt kimlikleri şemada uuid) ve iki parça
  // ayrıca `encodeURIComponent` ile kodlanır — ikinci savunma hattı.
  // Aksiyonlar THROW ETMEZ; ekranın beklediği `{ ok, error }` sözleşmesine uyulur.
  if (!REPLAY_KINDS.includes(kind)) {
    return { ok: false, error: 'Geçersiz kayıt türü — yalnız teslimat maili veya webhook olayı yeniden gönderilebilir.' };
  }
  if (!UUID_RE.test(String(id ?? '').trim())) {
    return { ok: false, error: 'Geçersiz kayıt kimliği — liste yenilenip tekrar denenmeli.' };
  }

  try {
    await apiPost(
      `/v1/admin/ops/replay/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`,
      undefined,
      await getActor(),
    );
    revalidatePath('/ops');
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 404)) {
      // API'nin insan-okur gerekçesi (ops.service.replayBlockReason) doğrudan gösterilir.
      return { ok: false, blocked: true, error: e.message };
    }
    return { ok: false, error: e instanceof Error ? e.message : 'Yeniden gönderilemedi' };
  }
}

// ── Bakım tetikleyicileri (elle) ─────────────────────────────────────────────
// Periyodik işler (süre-bitişi taraması · mutabakat denetimi) zaten arka planda
// çalışır; bu action'lar aynı uçları elle tetikler. useActionState imzası
// (prevState, formData) — formData kullanılmaz.

export interface MaintenanceState {
  ok: boolean;
  error?: string;
  /** Başarılı sonucun insan-okur özeti. */
  message?: string;
  /** ok ama dikkat gerektiren sonuç (ör: mutabakat ihlali bulundu). */
  warn?: boolean;
}

/**
 * Süre-bitişi taramasını elle çalıştırır (POST /v1/admin/maintenance/expire).
 * Süresi geçmiş 'hide' atamalarını `expired` yapar (payload artık teslim edilmez).
 */
export async function expireMaintenanceAction(
  _prev: MaintenanceState,
  _formData: FormData,
): Promise<MaintenanceState> {
  try {
    const res = await apiPost<{ expired: number }>(
      '/v1/admin/maintenance/expire',
      undefined,
      await getActor(),
    );
    return { ok: true, message: `${res.expired} süresi geçmiş atama gizlendi (expired).` };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Süre-bitişi taraması çalıştırılamadı',
    };
  }
}

/**
 * Mutabakat/tutarlılık denetimini elle çalıştırır (POST /v1/admin/maintenance/reconcile).
 * DÜZELTME YAPMAZ (§16) — denetlenen kayıt + ihlal sayısını raporlar.
 */
export async function reconcileMaintenanceAction(
  _prev: MaintenanceState,
  _formData: FormData,
): Promise<MaintenanceState> {
  try {
    const res = await apiPost<{ checked: number; violations: unknown[] }>(
      '/v1/admin/maintenance/reconcile',
      undefined,
      await getActor(),
    );
    const count = res.violations.length;
    return {
      ok: true,
      warn: count > 0,
      message:
        count === 0
          ? `${res.checked} kayıt denetlendi — ihlal yok.`
          : `${res.checked} kayıt denetlendi — ${count} ihlal bulundu (kritik loglandı, düzeltme yapılmadı).`,
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Mutabakat denetimi çalıştırılamadı',
    };
  }
}
