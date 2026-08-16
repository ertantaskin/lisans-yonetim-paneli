'use server';
import { revalidatePath } from 'next/cache';
import { ApiError, apiGet, apiPost, isUuid } from '../../../lib/api';
import { getActor } from '../../../lib/session';
// TİP-ONLY (çalışma anında import EDİLMEZ, tsc siler): 'use server' dosyası tip export edemez,
// bu yüzden sözleşme önizleme bileşeninde tanımlıdır ve buradan yalnız okunur → iki yerde iki
// ayrı şekil tanımı (ve sessiz ayrışma) olmaz.
import type { DeliveryMailPreview } from './mail-preview';

/**
 * SEC-1 — YOL ENJEKSİYONU (bu dosya bulgunun ÖRNEĞİYDİ):
 * `completeLineAction(lineId, orderId)` gibi aksiyonlar kimliği doğrudan API YOLUNA gömüyordu
 * ve yalnız "boş mu" diye bakıyordu. Sunucu aksiyonları TS tiplerini ÇALIŞMA ANINDA ZORLAMAZ:
 * action uç noktası dışarıdan, serileştirilmiş argümanlarla çağrılabilir. WHATWG URL
 * normalizasyonu `..` segmentlerini çözdüğü için
 * `completeLineAction('../sites/<id>/rotate-secret?x=', '1')` çağrısı BAŞKA bir admin ucuna
 * düşüyordu; Next sunucusu isteği kendi ADMIN_TOKEN'ı ile yaptığından owner-only kapılar
 * (rotate-secret, deployments, admin CRUD) sıradan bir 'admin' hesabınca ATLANABİLİRDİ.
 *
 * Bu yüzden yola gömülen HER kimlik `isUuid()` ile çalışma anında doğrulanır (şemadaki tüm
 * kayıt kimlikleri uuid). `lib/api` içindeki merkezî `assertSafePath` kapısı ikinci savunma
 * hattıdır — biri atlanırsa diğeri isteği yaptırmaz.
 *
 * Aksiyonlar FIRLATMAZ: mevcut `{ ok, error }` (`MutationState`) sözleşmesi korunur.
 */
const INVALID_ID = 'Geçersiz kayıt kimliği — sayfa yenilenip tekrar denenmeli.';

/**
 * Tanı ucunun ('GET /v1/admin/pending-lines/diagnose/:orderId') yanıt şekli — YEREL (export
 * edilmez: 'use server' dosyası yalnız async fonksiyon export eder; tip export'u da bilinçli
 * olarak minimum tutulur). Alan adları backend ile birebir aynıdır.
 */
interface DiagnosisLine {
  lineId: string;
  reason: string;
  action: string;
  message: string;
}
interface DiagnosisResponse {
  resolvableCount: number;
  lines: DiagnosisLine[];
}

/** POST /v1/admin/pending-lines/resolve yanıtı (ResolvePendingResult) — yerel. */
interface ResolveResponse {
  scanned: number;
  linked: number;
  delivered: number;
  stillPending: number;
  noMapping: number;
  skipped: number;
  truncated: boolean;
  details: Array<{ outcome: string; message: string }>;
}

/*
 * KALDIRILDI — `revealAction` + `RevealState`.
 *
 * NEDEN: sipariş detayı artık rol-farkında olarak SUNUCUDA render ediliyor (owner düz metin
 * görür, owner-olmayan maskeli) — ekranda "Göster" düğmesi YOK ve aksiyonun kod tabanında
 * hiçbir çağıranı kalmamıştı. Ama `'use server'` modülünden export edildiği için Next
 * ÇAĞRILABİLİR bir uç üretmeye devam ediyordu ve her çağrı bir `reveal` audit satırı yazıyordu
 * → denetim izine, hiç yaşanmamış bir "lisans görüntülendi" olayı düşebiliyordu.
 * Yetki kapısı (isOwner) doğruydu; sorun ucun VARLIĞIYDI.
 */

/**
 * Mutasyon aksiyonlarının ortak dönüş tipi. Server action ASLA fırlatmaz (fırlatırsa
 * kök error boundary tüm sayfayı siler + geri-dönüşsüz revoke sessizce çöker, §5/§18);
 * hata ok=false + Türkçe mesaj olarak istemciye döner, inline yüzeye çıkar.
 */
export interface MutationState {
  ok: boolean;
  error?: string;
  message?: string;
}

/**
 * "Kalanları Ata" — satırın kalan adedini atar (§13). Backend added=0 ile SESSİZ no-op dönebilir
 * (stok yok / satır iptal-iade / sipariş incelemede / all-or-nothing eksik / ön-sipariş) — bu
 * durumları yeşil "başarılı" gibi göstermeyip operatöre dürüst bir uyarı veririz (denetim bulgusu).
 *
 * added=0 olduğunda GERÇEK sebebi tanı ucundan okuruz (kullanıcı geri bildirimi: "atanacak bir şey
 * yok diyor ama neden olduğunu anlamıyorum"). Tanı erişilemezse eski genel mesaja düşülür.
 */
export async function completeLineAction(lineId: string, orderId: string): Promise<MutationState> {
  if (!isUuid(lineId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    const res = await apiPost<{ added?: number }>(
      `/v1/admin/fulfillments/${lineId}/complete`,
      undefined,
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    const added = typeof res?.added === 'number' ? res.added : null;
    if (added === 0) {
      return { ok: false, error: await diagnoseLineMessage(orderId, lineId) };
    }
    return { ok: true, message: added != null ? `${added} lisans atandı.` : 'Kalanlar atandı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Atama başarısız' };
  }
}

/**
 * Satırın NEDEN atanamadığını tanı ucundan tek cümleyle getirir (best-effort).
 * Tanı opsiyonel katmandır: uç hata verirse genel (eski) mesaj döner, akış bozulmaz.
 */
async function diagnoseLineMessage(orderId: string, lineId: string): Promise<string> {
  const generic =
    'Atanacak bir şey yok — stok tükenmiş, satır iptal/iade edilmiş ya da sipariş incelemede olabilir.';
  try {
    const diag = await apiGet<DiagnosisResponse>(`/v1/admin/pending-lines/diagnose/${orderId}`);
    const line = diag.lines?.find((l) => l.lineId === lineId);
    if (!line?.message) return generic;
    return line.reason === 'mapping-available'
      ? `${line.message} (Bu satır için “Eşlemeyi Uygula” düğmesini kullanın.)`
      : line.message;
  } catch {
    return generic;
  }
}

/**
 * "Eşlemeyi Uygula" (§3/§13): operatörün SONRADAN tanımladığı eşlemeyi, eşleme öncesinden kalmış
 * BEKLEYEN satırlara geriye dönük uygular ve normal atama makinesiyle teslimatı dener.
 *
 * KRİTİK: yeni eşleme OLUŞTURMAZ / TAHMİN ETMEZ — yalnız `site_product_mappings` içindeki AKTİF,
 * elle tanımlanmış eşlemeler uygulanır (otomatik eşleştirme yok, güvenlik kuralı). lineId
 * verilirse tek satır, verilmezse siparişin tüm bekleyen satırları taranır.
 *
 * Sonuç SESSİZCE "başarılı" gösterilmez: hiçbir satır bağlanamadıysa ok=false + gerçek sebep.
 */
export async function resolvePendingAction(
  orderId: string,
  lineId?: string,
): Promise<MutationState> {
  // lineId opsiyoneldir; verilmişse o da doğrulanır (gövdeye gider ama kimlik şekli tektir).
  if (!isUuid(orderId) || (lineId !== undefined && !isUuid(lineId))) {
    return { ok: false, error: INVALID_ID };
  }
  try {
    const actor = await getActor();
    const res = await apiPost<ResolveResponse>(
      '/v1/admin/pending-lines/resolve',
      lineId ? { orderId, lineId } : { orderId },
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/orders');

    const scanned = res?.scanned ?? 0;
    const linked = res?.linked ?? 0;
    const delivered = res?.delivered ?? 0;
    const stillPending = res?.stillPending ?? 0;
    const noMapping = res?.noMapping ?? 0;

    if (scanned === 0) {
      return {
        ok: false,
        error:
          'Uygulanacak bekleyen satır bulunamadı — satır bu arada çözülmüş ya da iptal/iade edilmiş olabilir.',
      };
    }
    if (linked === 0) {
      // Bağlanan satır yoksa: eşleme yok (en sık) ya da satır bu arada değişti → gerçek sebebi ver.
      const first = res?.details?.[0]?.message;
      return {
        ok: false,
        error:
          first ??
          (noMapping > 0
            ? 'Bu mağaza ürünü için aktif eşleme yok — önce Ürün Eşleştirme ekranından eşleyin.'
            : 'Hiçbir satır bağlanamadı.'),
      };
    }

    const parts = [`${linked} satır bağlandı`];
    if (delivered > 0) parts.push(`${delivered} satır teslim edildi`);
    if (stillPending > 0) parts.push(`${stillPending} satır hâlâ bekliyor`);
    if (res?.truncated) parts.push('liste sınıra takıldı, tekrar çalıştırın');
    return { ok: true, message: `${parts.join(', ')}.` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Eşleme uygulanamadı' };
  }
}

/** Atamayı iptal et (iade) — key karantinaya, müşteri görünümünden düşer (§2). Geri alınamaz. */
export async function revokeAction(
  assignmentId: string,
  orderId: string,
  reason?: string,
): Promise<MutationState> {
  if (!isUuid(assignmentId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    await apiPost(
      `/v1/admin/assignments/${assignmentId}/revoke`,
      { reason: reason?.trim() || 'admin iptali' },
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama iptal edildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İptal başarısız' };
  }
}

/**
 * Proaktif değişim (§4): kusurlu key'i aynı üründen TAZE key ile değiştirir — müşteri
 * "Sorun Bildir" açmadan. Eski key karantinaya gider, satır 'canceled' işaretlenmez
 * (iade DEĞİL). reason zorunlu. Stok yoksa API 409 → mesaj yüzeye çıkar (eski atama korunur).
 */
export async function replaceAction(
  assignmentId: string,
  orderId: string,
  reason: string,
): Promise<MutationState> {
  if (!isUuid(assignmentId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  if (!reason?.trim()) return { ok: false, error: 'Değişim sebebi zorunlu.' };
  try {
    const actor = await getActor();
    await apiPost(
      `/v1/admin/assignments/${assignmentId}/replace`,
      { reason: reason.trim() },
      actor,
    );
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Key değiştirildi — taze key atandı, eski karantinada.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Değişim başarısız' };
  }
}

/**
 * Teslimat mailini yeniden gönder (§13/§17). API'de 60sn debounce var; çok sık denemede
 * 400 döner → kullanıcıya "çok sık" olarak yüzeye çıkarılır (artık sessiz değil).
 */
export async function resendAction(orderId: string): Promise<MutationState> {
  if (!isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/orders/${orderId}/resend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Mail yeniden kuyruğa alındı.' };
  } catch (e) {
    /*
      DURUM KODUNA BAĞLI (denetim D4): burada `/→\s*400\b/` REGEX'i vardı ve yalnız
      `lib/api`nin GENERIC mesaj kalıbıyla (`POST /path → 400`) eşleşiyordu. API bu uç için
      `message` gövdesi döndürdüğü an — ki `toApiError` varsa onu tercih eder — kalıp sessizce
      eşleşmeyi bırakır ve operatör "çok sık denendi" yerine anlamsız "Mail gönderilemedi."
      görürdü. Doğru desen aynı kod tabanında ZATEN var: `app/ops/actions.ts` → `ApiError.status`.
    */
    if (e instanceof ApiError && e.status === 400) {
      return { ok: false, error: 'Çok sık denendi — 60 sn bekleyip tekrar deneyin.' };
    }
    return { ok: false, error: 'Mail gönderilemedi.' };
  }
}

/**
 * Teslimat mailinin ÖNİZLEMESİ (kullanıcı isteği: "içeriği tekrar göndermeden teyit etmek").
 *
 * GÖNDERMEZ, kuyruğa ALMAZ — salt okuma. Sipariş sayfası SUNUCUDA render edildiği için
 * önizleme sayfa yüklenirken DEĞİL, operatör ikona bastığında istenir (gövde büyük olabilir
 * ve düz metin sır taşır → yalnız gerçekten bakılan sipariş için üretilir; ayrıca her sayfa
 * açılışı gereksiz bir `reveal` denetim kaydı yazmaz).
 *
 * `apiGet` oturumun aktörünü ve ROLÜNÜ iletir → API owner'a düz metin, owner-OLMAYAN admine
 * MASKELİ gövde döndürür (denetim A1). Karar SUNUCUDA verilir; bu aksiyon rol taşımaz.
 */
export async function previewDeliveryMailAction(
  orderId: string,
): Promise<{ ok: true; preview: DeliveryMailPreview } | { ok: false; error: string }> {
  if (!isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const preview = await apiGet<DeliveryMailPreview>(`/v1/admin/orders/${orderId}/mail-preview`);
    return { ok: true, preview };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) {
      return { ok: false, error: 'Sipariş bulunamadı.' };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Mail önizlemesi alınamadı.',
    };
  }
}

/** Atamayı askıya al — müşteri görünümünde "inceleme altında" (§4, geri alınabilir). */
export async function suspendAction(
  assignmentId: string,
  orderId: string,
): Promise<MutationState> {
  if (!isUuid(assignmentId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/assignments/${assignmentId}/suspend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama askıya alındı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Askıya alma başarısız' };
  }
}

/** Askıdan çıkar — atama tekrar aktif ve müşteriye görünür olur. */
export async function unsuspendAction(
  assignmentId: string,
  orderId: string,
): Promise<MutationState> {
  if (!isUuid(assignmentId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/assignments/${assignmentId}/unsuspend`, undefined, actor);
    revalidatePath(`/orders/${orderId}`);
    return { ok: true, message: 'Atama aktifleştirildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'İşlem başarısız' };
  }
}

/**
 * Değişim talebini SİPARİŞ ekranından onayla (§13): eskiyi geri al + taze key ata. API atomik
 * makineyi kullanır; MAK/stok-yok → 409 (mesaj yüzeye çıkar, talep 'approved' olmaz). Hem sipariş
 * hem /support yeniden doğrulanır → değişim her iki ekranda anında yansır (kullanıcı isteği).
 */
export async function approveReplacementForOrderAction(
  replacementId: string,
  orderId: string,
): Promise<MutationState> {
  if (!isUuid(replacementId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/replacements/${replacementId}/approve`, {}, actor);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/support');
    return { ok: true, message: 'Değişim onaylandı — taze key atandı.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Onaylanamadı' };
  }
}

/** Değişim talebini sipariş ekranından reddet — not zorunlu (müşteriye bildirilir). */
export async function rejectReplacementForOrderAction(
  replacementId: string,
  orderId: string,
  note: string,
): Promise<MutationState> {
  if (!isUuid(replacementId) || !isUuid(orderId)) return { ok: false, error: INVALID_ID };
  if (!note?.trim()) return { ok: false, error: 'Red gerekçesi zorunlu.' };
  try {
    const actor = await getActor();
    await apiPost(`/v1/admin/replacements/${replacementId}/reject`, { note: note.trim() }, actor);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath('/support');
    return { ok: true, message: 'Talep reddedildi.' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Reddedilemedi' };
  }
}
