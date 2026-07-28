/**
 * Türkçe etiket sözlüğü — enum/kod değerlerini operatöre gösterilecek Türkçe metne çevirir.
 * TEK KAYNAK: ham enum (`partial-auto`, `voided`, `MAK`…) kullanıcıya asla çıplak gösterilmez.
 * Tüm admin ekranları buradan okur → tutarlılık. Bilinmeyen anahtar → ham değer (regresyonsuz geri düşüş).
 */

function lookup(map: Record<string, string>, key: string | null | undefined): string {
  if (key == null) return '';
  return map[key] ?? key;
}

// ── Ürün ───────────────────────────────────────────────────────────────────
const PRODUCT_KIND: Record<string, string> = {
  key: 'Lisans anahtarı',
  account: 'Hesap',
  code: 'Kod / hediye çeki',
  custom: 'Özel',
};
export const productKindLabel = (k: string) => lookup(PRODUCT_KIND, k);

const USAGE_MODE: Record<string, string> = {
  single: 'Tek kullanımlık',
  multi: 'Çok kullanımlık (MAK)',
};
export const usageModeLabel = (m: string) => lookup(USAGE_MODE, m);

const FULFILLMENT_POLICY: Record<string, string> = {
  'partial-auto': 'Kısmi — otomatik',
  'partial-approval': 'Kısmi — onaylı',
  'all-or-nothing': 'Ya hep ya hiç',
};
export const fulfillmentPolicyLabel = (p: string) => lookup(FULFILLMENT_POLICY, p);

const ON_EXPIRY: Record<string, string> = {
  hide: 'Erişimi gizle',
  keep: 'Erişimi koru',
};
export const onExpiryLabel = (v: string) => lookup(ON_EXPIRY, v);

/** Ürün tip özeti (products-table + detay başlığı ortak dili): tip · MAK×N · Ng. */
export function productTypeSummary(p: {
  kind: string;
  usageMode?: string | null;
  maxUses?: number | null;
  validityDays?: number | null;
}): string {
  const parts: string[] = [productKindLabel(p.kind)];
  if (p.usageMode === 'multi') parts.push(`MAK×${p.maxUses ?? '?'}`);
  if (p.validityDays) parts.push(`${p.validityDays} gün`);
  return parts.join(' · ');
}

// ── Stok durumu (StatTile kırılımı) ──────────────────────────────────────────
const STOCK_STATE: Record<string, string> = {
  available: 'Kullanılabilir',
  assigned: 'Teslim edilen',
  revoked: 'Geri alınan',
  expired: 'Süresi dolan',
  voided: 'Geçersiz',
  quarantined: 'Karantinada',
  replaced: 'Değiştirildi',
};
export const stockStateLabel = (s: string) => lookup(STOCK_STATE, s);

// ── Parti / Satın alma emri durumu ──────────────────────────────────────────
const SUPPLY_STATUS: Record<string, string> = {
  active: 'Aktif',
  received: 'Teslim alındı',
  ordered: 'Sipariş verildi',
  partial: 'Kısmi',
  draft: 'Taslak',
  recalled: 'Geri çekildi',
  voided: 'Geçersiz',
  cancelled: 'İptal',
  canceled: 'İptal',
};
export const supplyStatusLabel = (s: string) => lookup(SUPPLY_STATUS, s);

// ── Stok düzeltme işlemi ─────────────────────────────────────────────────────
const ADJUSTMENT_ACTION: Record<string, string> = {
  correct: 'Düzeltme',
  void: 'Geçersiz kıl',
  damage: 'Hasarlı',
  recall: 'Geri çekme',
};
export const adjustmentActionLabel = (a: string) => lookup(ADJUSTMENT_ACTION, a);

// ── Sipariş / atama durumu ───────────────────────────────────────────────────
const ORDER_STATUS: Record<string, string> = {
  pending: 'Bekliyor',
  partial: 'Kısmi teslim',
  fulfilled: 'Tamamlandı',
  held_for_review: 'İncelemede',
  revoked: 'Geri alındı',
  canceled: 'İptal',
  cancelled: 'İptal',
};
export const orderStatusLabel = (s: string) => lookup(ORDER_STATUS, s);

const ASSIGNMENT_STATUS: Record<string, string> = {
  active: 'Aktif',
  delivered: 'Teslim edildi',
  suspended: 'Askıda',
  revoked: 'Geri alındı',
  expired: 'Süresi doldu',
  // Değişim sonrası eski atama: "iptal" DEĞİL — anahtar değiştirildi (kullanıcı geri bildirimi).
  replaced: 'Değiştirildi',
  quarantined: 'Karantinada',
};
export const assignmentStatusLabel = (s: string) => lookup(ASSIGNMENT_STATUS, s);

// ── Lisans kalemi (license_items) durumu — envanter listeleri ────────────────
const LICENSE_ITEM_STATUS: Record<string, string> = {
  available: 'Stokta',
  reserved: 'Rezerve',
  assigned: 'Teslim edildi',
  quarantined: 'Karantinada',
  voided: 'Geçersiz kılındı',
  expired: 'Süresi doldu',
  // Atama tarafından türeyen ama envanter listelerinde de görülebilen durumlar.
  suspended: 'Askıda',
  replaced: 'Değiştirildi',
  revoked: 'Geri alındı',
  depleted: 'Tükendi',
};
export const licenseItemStatusLabel = (s: string) => lookup(LICENSE_ITEM_STATUS, s);

// ── Satır neden bekliyor? (sipariş detayı tanısı) ────────────────────────────
const PENDING_REASON: Record<string, string> = {
  unmapped: 'Mağaza ürünü panelde eşlenmemiş',
  no_stock: 'Stok yok',
  held: 'Sipariş incelemede',
  canceled: 'Satır iptal/iade edilmiş',
  release_gated: 'Ön sipariş — satış tarihi gelmedi',
  all_or_nothing: 'Tamamı hazır değil (hep-ya-hiç politikası)',
};
export const pendingReasonLabel = (r: string) => lookup(PENDING_REASON, r);

/** Bekleme nedeni için operatörün atması gereken adım (tek cümle). */
const PENDING_REASON_ACTION: Record<string, string> = {
  unmapped: 'Ürün Eşleştirme ekranından bu mağaza ürününü panel ürününe eşleyin, sonra “Eşlemeyi uygula” deyin.',
  no_stock: 'Ürüne stok girin; stok gelince bekleyen satır otomatik tamamlanır.',
  held: 'İnceleme Kuyruğu’ndan siparişi onaylayın ya da reddedin.',
  canceled: 'İşlem gerekmiyor — iade/iptal edilen satır yeniden teslim edilmez.',
  release_gated: 'Ürünün satış tarihini bekleyin veya ürün ayarından tarihi değiştirin.',
  all_or_nothing: 'Satırın tamamını karşılayacak stok girin ya da politikayı kısmi teslimata çevirin.',
};
export const pendingReasonAction = (r: string) => lookup(PENDING_REASON_ACTION, r);

/**
 * Satır tanısı (`GET /v1/admin/pending-lines/diagnose/:orderId` → `LineDiagnosisReason`).
 * `PENDING_REASON` ile AYRI vokabülerdir: orası `detail()`'in kaba nedenini (`no_stock`),
 * burası tanı ucunun ayrıntılı nedenini (`out-of-stock`, `mapping-available`…) karşılar.
 */
const DIAGNOSIS_REASON: Record<string, string> = {
  ok: 'Teslim edildi',
  ready: 'Teslime hazır',
  'mapping-available': 'Eşleme hazır — satıra uygulanmayı bekliyor',
  unmapped: 'Mağaza ürünü panelde eşlenmemiş',
  'no-remote-id': 'Mağaza ürün kimliği kayıtlı değil',
  held: 'Sipariş güvenlik incelemesinde',
  'out-of-stock': 'Stok yetersiz',
  preorder: 'Ön sipariş — satış tarihi gelmedi',
  canceled: 'Satır iade/iptal edilmiş',
};
export const diagnosisReasonLabel = (r: string) => lookup(DIAGNOSIS_REASON, r);

// ── Destek / değişim talebi durumu ───────────────────────────────────────────
const SUPPORT_STATUS: Record<string, string> = {
  open: 'Açık',
  info_requested: 'Bilgi bekleniyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
};
export const supportStatusLabel = (s: string) => lookup(SUPPORT_STATUS, s);

const MESSAGE_AUTHOR: Record<string, string> = {
  admin: 'Yönetici',
  customer: 'Müşteri',
  system: 'Sistem',
};
export const messageAuthorLabel = (t: string) => lookup(MESSAGE_AUTHOR, t);

// ── Rozet durumu (ui/badge → StatusBadge) ────────────────────────────────────
// `StatusBadge` TEK bileşende birden çok vokabüleri gösterir (sipariş / atama / destek /
// mail / lisans kalemi). Etiketler burada birleşir → bileşende yalnız renk + ikon eşlemesi
// kalır. Büyük/küçük harf tutarlıdır (eski sözlükte "teslim edildi" ile "Geri alındı"
// karışıktı — aynı satırda iki farklı dil görünüyordu).
const BADGE_STATUS: Record<string, string> = {
  // Sipariş / atama
  fulfilled: 'Teslim edildi',
  active: 'Aktif',
  partial: 'Kısmi teslim',
  pending: 'Bekliyor',
  suspended: 'Askıda',
  expired: 'Süresi doldu',
  revoked: 'Geri alındı',
  replaced: 'Değiştirildi',
  held_for_review: 'İncelemede',
  canceled: 'İptal',
  unmapped: 'Eşlenmemiş',
  // Destek / değişim talebi
  open: 'Açık',
  info_requested: 'Bilgi bekleniyor',
  approved: 'Onaylandı',
  rejected: 'Reddedildi',
  // Mail kaydı
  sent: 'Gönderildi',
  delivered: 'İletildi',
  queued: 'Kuyrukta',
  failed: 'Başarısız',
  bounced: 'Geri döndü',
  // Lisans kalemi
  quarantined: 'Karantinada',
  voided: 'Geçersiz kılındı',
};
export const badgeStatusLabel = (s: string) => lookup(BADGE_STATUS, s);

// ── Site tipi ────────────────────────────────────────────────────────────────
const SITE_TYPE: Record<string, string> = {
  woocommerce: 'WooCommerce',
  marketplace: 'Pazar yeri',
  reseller: 'Bayi',
};
export const siteTypeLabel = (t: string) => lookup(SITE_TYPE, t);

// ── AI triyaj (kategori / öncelik) ───────────────────────────────────────────
const AI_CATEGORY: Record<string, string> = {
  garanti: 'Garanti',
  calismyor: 'Çalışmıyor',
  'yanlis-urun': 'Yanlış ürün',
  iade: 'İade',
  diger: 'Diğer',
};
export const aiCategoryLabel = (c: string) => lookup(AI_CATEGORY, c);

const AI_PRIORITY: Record<string, string> = {
  dusuk: 'Düşük',
  orta: 'Orta',
  yuksek: 'Yüksek',
};
export const aiPriorityLabel = (p: string) => lookup(AI_PRIORITY, p);

// ── Zaman çizelgesi olay tipi ────────────────────────────────────────────────
// Anahtarlar GERÇEK `fulfillment_events.type` değerleridir (kaynak: apps/api/src/orders/
// {orders,admin-orders,fulfillment}.service.ts — sipariş detayı bu tabloyu ham döndürür).
// Bilinmeyen anahtar → ham değer (regresyonsuz geri düşüş); hedef: hiçbir ham snake_case
// string (ör. `assignment_created`) operatöre çıplak görünmesin.
const EVENT_TYPE: Record<string, string> = {
  order_received: 'Sipariş alındı',
  held_for_review: 'İncelemeye alındı',
  fulfilled: 'Sipariş tamamlandı',
  partially_fulfilled: 'Kısmi teslim edildi',
  pending_stock: 'Stok bekleniyor',
  line_completed: 'Satır tamamlandı',
  order_edited: 'Sipariş güncellendi',
  revoked: 'Geri alındı',
  review_released: 'İnceleme onaylandı',
  review_rejected: 'İnceleme reddedildi',
  // Eşleme sonradan yapıldı → eski bekleyen satır geriye dönük bağlandı (§3).
  mapping_resolved: 'Eşleme uygulandı',
  assignment_created: 'Lisans atandı',
  replaced: 'Lisans değiştirildi',
  bonus_assigned: 'Bonus lisans eklendi',
  suspended: 'Askıya alındı',
  unsuspended: 'Askı kaldırıldı',
  resent: 'Mail yeniden gönderildi',
};
export const eventTypeLabel = (t: string) => lookup(EVENT_TYPE, t);

// ── Denetim kaydı işlemi (audit_log.action) ──────────────────────────────────
// Anahtarlar `audit_action` PG enum'unun TAM listesidir (apps/api/src/db/schema/enums.ts).
const AUDIT_ACTION: Record<string, string> = {
  reveal: 'Lisans görüntülendi',
  replace: 'Lisans değiştirildi',
  revoke: 'Lisans iptal edildi',
  suspend: 'Lisans askıya alındı',
  unsuspend: 'Lisans askıdan çıkarıldı',
  import: 'Stok içe aktarıldı',
  login: 'Panele giriş',
  assign: 'Lisans atandı',
  resend: 'Teslimat maili yeniden gönderildi',
  site_update: 'Site güncellendi',
  anonymize: 'Veri anonimleştirildi',
  receive: 'Tedarik teslim alındı',
  recall: 'Parti geri çekildi',
  adjust: 'Stok düzeltildi',
};
export const auditActionLabel = (a: string) => lookup(AUDIT_ACTION, a);

// ── Güvenlik olayı tipi ──────────────────────────────────────────────────────
// Anahtarlar GERÇEK `security_events.type` değerleridir (kaynak: apps/api/src/security/
// security.service.ts — velocity/anomaly/quota_exceeded/quota_review; blocklist şemada
// belgeli rezerve tür). Bilinmeyen anahtar → ham değer. English-in-parens YOK.
const SECURITY_TYPE: Record<string, string> = {
  velocity: 'Anormal hız',
  quota_exceeded: 'Kota aşımı',
  quota_review: 'Kota incelemesi',
  anomaly: 'Anomali',
  blocklist: 'Kara liste',
};
export const securityTypeLabel = (t: string) => lookup(SECURITY_TYPE, t);

// ── Önem seviyesi (güvenlik + bildirim ortak: info/warning/critical) ──────────
const SEVERITY: Record<string, string> = {
  info: 'Bilgi',
  warning: 'Uyarı',
  critical: 'Kritik',
};
export const severityLabel = (s: string) => lookup(SEVERITY, s);

// ── Bildirim türü ────────────────────────────────────────────────────────────
// Anahtarlar GERÇEK `notifications.type` değerleridir (kaynak: low-stock/daily-digest/
// reconcile servisleri). Bilinmeyen anahtar → ham değer.
const NOTIFICATION_TYPE: Record<string, string> = {
  low_stock: 'Düşük stok',
  digest_alert: 'Günlük özet uyarısı',
  reconcile_violation: 'Mutabakat ihlali',
  quota_review: 'Kota incelemesi',
};
export const notificationTypeLabel = (t: string) => lookup(NOTIFICATION_TYPE, t);
