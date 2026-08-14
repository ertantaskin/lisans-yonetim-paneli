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

// ── Stok kaleminin KULLANICIYA GÖSTERİLEN ADI ────────────────────────────────
/**
 * Panel yalnız lisans ANAHTARI satmaz: hesap, kod/hediye çeki, süreli hesap ve özel ürünler
 * de var (§2) — üstelik aynı ekranda karışık durabilirler. Ekranlarda her yere "anahtar"
 * yazmak yanlış: bir hesap kaydına "anahtar" demek operatörü yanıltır ve ileride yeni ürün
 * tipleri eklendikçe daha da yanlışlaşır.
 *
 * KURAL: liste TEK tipteyse o tipin adı ("3 hesap"), KARIŞIKSA ya da tip bilinmiyorsa nötr
 * "kalem" ("3 kalem"). Nötr ad hiçbir zaman yanlış olmaz; özel ad ise okunabilirliği artırır.
 *
 * `kalem` = `license_items` satırı: tek bir anahtar, tek bir hesap ya da tek bir kod.
 */
const ITEM_NOUN: Record<string, { one: string; many: string }> = {
  key: { one: 'anahtar', many: 'anahtarlar' },
  account: { one: 'hesap', many: 'hesaplar' },
  code: { one: 'kod', many: 'kodlar' },
  custom: { one: 'kalem', many: 'kalemler' },
};
const NEUTRAL_ITEM_NOUN = { one: 'kalem', many: 'kalemler' };

/** Tek bir ürün tipi ya da bir kalem kümesinin tipleri. */
export type ItemKinds = string | null | undefined | Iterable<string | null | undefined>;

/** Küme tek tipteyse o tip, değilse (ya da tip bilinmiyorsa) `null` → nötr dile düşülür. */
function uniformKind(kinds: ItemKinds): string | null {
  if (kinds == null) return null;
  if (typeof kinds === 'string') return kinds || null;
  let seen: string | null = null;
  for (const k of kinds) {
    // Tipi bilinmeyen TEK kalem bile varsa nötr dile düşeriz (yanlış ad yazmaktansa).
    if (!k) return null;
    if (seen === null) seen = k;
    else if (seen !== k) return null;
  }
  return seen;
}

function itemNounPair(kinds: ItemKinds) {
  const kind = uniformKind(kinds);
  return (kind && ITEM_NOUN[kind]) || NEUTRAL_ITEM_NOUN;
}

/** Tekil ad: 'anahtar' | 'hesap' | 'kod' | 'kalem'. */
export const itemNoun = (kinds: ItemKinds): string => itemNounPair(kinds).one;
/** Çoğul ad: 'anahtarlar' | 'hesaplar' | 'kodlar' | 'kalemler'. */
export const itemNounPlural = (kinds: ItemKinds): string => itemNounPair(kinds).many;

/**
 * Sayı + ad: `12 anahtar` / `12 kalem`. (Türkçede sayıdan sonra ad tekil kalır.)
 * Sayı binlik ayraçlı yazılır — 1.250 kalemlik listede okunurluk için.
 */
export const itemCount = (n: number, kinds?: ItemKinds): string =>
  `${n.toLocaleString('tr-TR')} ${itemNoun(kinds)}`;

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

// ── Admin rolü (§8) ──────────────────────────────────────────────────────────
/**
 * Rol ham enum olarak (`owner`/`admin`) kullanıcıya sızıyordu (admin oluşturma formu +
 * admin listesi rozeti). Etiket KISA tutulur: aynı fonksiyon hem `<option>`u hem rozeti
 * besler, "Sahip (tam yetki)" gibi uzun bir metin rozeti gereksiz şişirirdi — yetki
 * açıklaması çağrı yerinde yardım metni olarak verilir. `value`/`name` DEĞİŞMEZ.
 */
const ADMIN_ROLE: Record<string, string> = {
  owner: 'Sahip',
  admin: 'Yönetici',
};
export const adminRoleLabel = (r: string) => lookup(ADMIN_ROLE, r);

// ── Stok düzeltme işlemi ─────────────────────────────────────────────────────
const ADJUSTMENT_ACTION: Record<string, string> = {
  correct: 'Düzeltme',
  void: 'Geçersiz kıl',
  damage: 'Hasarlı',
  recall: 'Geri çekme',
};
export const adjustmentActionLabel = (a: string) => lookup(ADJUSTMENT_ACTION, a);

// ── Sipariş / atama durumu ───────────────────────────────────────────────────
// TERMİNOLOJİ TEKLİĞİ (denetim bulgusu): `fulfilled` burada 'Tamamlandı', rozet sözlüğünde
// (BADGE_STATUS → StatusBadge) 'Teslim edildi' idi → AYNI sipariş Ctrl+K'da "Tamamlandı",
// listede "Teslim edildi" görünüyordu; operatör iki farklı şey sanıyordu. Rozet dili panelin
// baskın dili olduğu için burası ONA hizalandı. Yeni bir durum eklerken İKİ sözlüğü de kontrol et.
const ORDER_STATUS: Record<string, string> = {
  pending: 'Bekliyor',
  partial: 'Kısmi teslim',
  fulfilled: 'Teslim edildi',
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

// ── Tedarikçi değişim fişi (§12) ─────────────────────────────────────────────
/**
 * Fişin yaşam döngüsü. "Fiş" bilinçli bir kelime: operatör bunu gün sonunda kesip
 * tedarikçiye gönderiyor (Z raporu benzetmesi). "Talep"/"RMA" denmedi — panelin geri
 * kalanı `replacement_requests`'e (MÜŞTERİ talebi) "talep" diyor, iki yön karışırdı.
 *
 * ⚠ `sent` anahtarı `BADGE_STATUS`'ta da var ama orası MAİL kaydıdır ("Gönderildi").
 * İki sözlük bilinçli AYRI — birleştirme, birini düzenlerken diğerine dokunma.
 */
const CLAIM_STATUS: Record<string, string> = {
  draft: 'Taslak',
  sent: 'Tedarikçiye gönderildi',
  closed: 'Kapandı',
  canceled: 'İptal edildi',
};
export const claimStatusLabel = (s: string) => lookup(CLAIM_STATUS, s);

/**
 * Fişteki TEK kalemin tedarikçi yanıtı.
 *
 * `pending` etiketi bilinçli UZUN: eskiden yalnız "Cevap bekleniyor" yazıyordu ve kullanıcı
 * "kimin cevabı?" diye sordu (rozet tek başına da listelerde görünüyor). Etiket artık aktörü
 * kendi içinde taşır — çevresindeki başlığa bağımlı değil.
 */
const CLAIM_OUTCOME: Record<string, string> = {
  pending: 'Tedarikçi yanıtı bekleniyor',
  replaced: 'Yenisi geldi',
  credited: 'Bedeli iade edildi',
  rejected: 'Tedarikçi kabul etmedi',
};
export const claimOutcomeLabel = (s: string) => lookup(CLAIM_OUTCOME, s);

/** Her yanıtın operatör için ANLAMI (rozet altı ipucu / açıklama listesi). */
const CLAIM_OUTCOME_HINT: Record<string, string> = {
  pending: 'Fişe girdi, tedarikçiden henüz yanıt gelmedi.',
  replaced: 'Tedarikçi yerine yenisini gönderdi — süreç bu kalem için kapandı.',
  credited: 'Tedarikçi bedelini iade etti/mahsup etti — süreç bu kalem için kapandı.',
  rejected: 'Tedarikçi kabul etmedi; kalem bildirilecekler havuzuna GERİ DÖNDÜ.',
};
export const claimOutcomeHint = (s: string) => lookup(CLAIM_OUTCOME_HINT, s);

/** Fiş durumunun operatör için ANLAMI (bir sonraki adımı söyler). */
const CLAIM_STATUS_HINT: Record<string, string> = {
  draft: 'Hazırlandı, henüz tedarikçiye iletilmedi. Raporu indirip gönderin.',
  sent: 'Rapor tedarikçiye iletildi (siz gönderdiniz, panel göndermez). Yanıt geldikçe kalemleri işaretleyin.',
  closed: 'Tedarikçiyle süreç kapandı; fiş tedarikçi karnesine işlendi.',
  canceled: 'Fiş iptal edildi; kalemleri havuza döndü.',
};
export const claimStatusHint = (s: string) => lookup(CLAIM_STATUS_HINT, s);

/** Kusurun KAYNAĞI — tedarikçiye giden raporda gerekçe ayrımı. */
const DEFECT_KIND: Record<string, string> = {
  customer_return: 'Müşteri iadesi',
  recall: 'Parti geri çekme',
  damage: 'Hasarlı',
  manual_void: 'Elle geçersiz kılındı',
};
export const defectKindLabel = (s: string) => lookup(DEFECT_KIND, s);

/** Kusur kaynağının bir cümlelik açıklaması (ekran içi rehber). */
const DEFECT_KIND_HINT: Record<string, string> = {
  customer_return: 'Müşteri “çalışmıyor” dedi; kalem geri alınıp yenisiyle değiştirildi.',
  recall: 'Partinin tamamı geri çekildi; stoktaki kalemler geçersiz kılındı.',
  damage: 'Stok düzeltmesinde “hasarlı” olarak düşüldü.',
  manual_void: 'Operatör elle geçersiz kıldı (ör. tedarikçi yanlış kalem gönderdi).',
};
export const defectKindHint = (s: string) => lookup(DEFECT_KIND_HINT, s);

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
//
// ⚠ ÇAKIŞAN ANAHTAR UYARISI (yaşanmış hata): bu sözlük ile tedarikçi fişi sözlükleri
// (`CLAIM_STATUS` / `CLAIM_OUTCOME` → `ClaimStatusBadge` / `ClaimOutcomeBadge`) BAZI
// anahtarları PAYLAŞIR — `sent`, `pending`, `approved`, `rejected` — ama AYNI anahtar iki
// vokabülerde FARKLI şey demektir:
//   · `sent`     burada MAİL kaydı ("Gönderildi"), fişte tedarikçiye iletilmiş fiş.
//   · `pending`  burada sipariş/atama ("Bekliyor"), fişte tedarikçi yanıtı bekleniyor.
//   · `approved`/`rejected` burada MÜŞTERİ değişim talebi, fişte TEDARİKÇİ yanıtı.
// Bu yüzden sözlükler bilinçli olarak AYRIDIR. Birini düzenlerken diğerini DEĞİŞTİRME ve
// asla tek haritada birleştirme — `sent` bir tur "Tedarikçiye gönderildi" yazıldığı için
// müşteriye giden teslimat maili sipariş detayında "Tedarikçiye gönderildi" görünüyordu.
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
  // Mail kaydı (`email_log.status`) — bu satırın okuyucusu sipariş detayındaki "Teslimat
  // Mailleri" kartıdır, yani MÜŞTERİYE giden mail. Tedarikçi fişinin `sent`'i AYRI sözlükte.
  sent: 'Gönderildi',
  delivered: 'İletildi',
  queued: 'Kuyrukta',
  failed: 'Başarısız',
  bounced: 'Geri döndü',
  // Lisans kalemi (envanter/karantina listeleri) — bu satırlar EKLENMEDEN önce envanter
  // tablosu kendi yerel sözlüğünü + ikonsuz düz `Badge`'ini kullanıyordu; aynı "Teslim
  // edildi" durumu /orders'ta yeşil-ikonlu, /stock'ta gri-ikonsuz görünüyordu.
  available: 'Stokta',
  reserved: 'Rezerve',
  assigned: 'Teslim edildi',
  depleted: 'Tükendi',
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

// ── Mağaza ürün türü (katalog senkronundan gelen HAM platform tipi) ──────────
// Anahtarlar mağazanın kendi vokabüleri (WooCommerce: simple/variable/variation) —
// panel ürün tipi (`PRODUCT_KIND`) DEĞİLDİR, karıştırılmamalı. Operatör için ayrım
// anlamlı: 'variable' satırı yalnızca ürün BAŞLIĞIdır (eşlenmemesi normal), asıl
// eşlenecek satır 'variation'dır. Bilinmeyen anahtar → ham değer (yeni platform
// tipleri sessizce kaybolmasın, ham görünüp fark edilsin).
const STORE_PRODUCT_KIND: Record<string, string> = {
  simple: 'Basit',
  variable: 'Varyasyonlu ürün',
  variation: 'Varyasyon',
  grouped: 'Gruplu',
  external: 'Harici / bağlı',
};
export const storeProductKindLabel = (k: string) => lookup(STORE_PRODUCT_KIND, k);

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

// ── Dağıtım / yayın işi durumu (deployments kuyruğu) ─────────────────────────
/**
 * `/deployments` (panel dağıtımı) ile `/releases` (eklenti yayını) AYNI `deployments`
 * tablosunu gösterir — runner hedefe göre `deploy.sh` ya da `publish-plugin.sh`'a dallanır.
 * İki ekran AYRI sözlük tutuyordu ve ÇELİŞİYORDU: aynı `running` bir ekranda mavi
 * "Çalışıyor", diğerinde gri "çalışıyor"; `success` bir yerde "Başarılı", diğerinde
 * "yayınlandı"; etiketler küçük harfti (cümle düzeni kuralı dışı). TEK KAYNAK burası.
 *
 * BU SÖZLÜK ROZET VARYANTINI DA TAŞIR (labels.ts'te istisna): durum bir `StatusBadge`
 * bileşeniyle değil, iki sayfada düz `<Badge variant>` ile basılıyor — metni burada,
 * rengi başka dosyada tutmak tam da çelişkiyi doğuran ayrımdı.
 *
 * Ton kuralı `components/ui/badge.tsx` ile AYNI (yeni hue EKLENMEZ):
 *   Bekliyor → warning (kuyrukta, kendiliğinden ilerler) · Çalışıyor → info (akıştaki iş)
 *   Başarılı → success · Başarısız → danger · bilinmeyen → neutral
 */
export type DeployStatusMeta = {
  variant: 'warning' | 'info' | 'success' | 'danger' | 'neutral';
  label: string;
};

const DEPLOY_STATUS: Record<string, DeployStatusMeta> = {
  pending: { variant: 'warning', label: 'Bekliyor' },
  running: { variant: 'info', label: 'Çalışıyor' },
  success: { variant: 'success', label: 'Başarılı' },
  failed: { variant: 'danger', label: 'Başarısız' },
};

/** Bilinmeyen durum kullanıcıya ham sızmasın → nötr Türkçe geri düşüş. */
export const deployStatusMeta = (s: string): DeployStatusMeta =>
  DEPLOY_STATUS[s] ?? { variant: 'neutral', label: 'Bilinmiyor' };

export const deployStatusLabel = (s: string): string => deployStatusMeta(s).label;
