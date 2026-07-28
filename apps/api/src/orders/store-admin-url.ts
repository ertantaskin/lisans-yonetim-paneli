/**
 * Mağaza admin panelinde siparişi AÇAN link (§17) — **TEK KAYNAK**.
 *
 * SALT LİNK ÜRETİMİ: panel mağazaya BAĞLANMAZ, oturum AÇMAZ, hiçbir istek ATMAZ; yalnız
 * operatörün kendi tarayıcısında açacağı bir URL metni döndürür (mağaza yetkisi tamamen
 * operatörün kendi oturumundadır).
 *
 * TEK KAYNAK: `sites.admin_order_url_template` (`{orderId}` yer tutucusu).
 *   · Mutlak URL ise aynen kullanılır.
 *   · Göreli ise (`/wp-admin/...`) site domain origin'iyle çözülür — ve YALNIZ o origin'e.
 *   · Şablon YOKSA link ÜRETİLMEZ (null) → UI linki hiç göstermez.
 *
 * NEDEN TİP-TABANLI TAHMİN KALDIRILDI (S4 — denetim F6, kullanıcı şartı "ya doğru olmalı ya
 * HİÇ link olmamalı"): eskiden `site.type === 'woocommerce'` olan şablonsuz sitelerde HPOS
 * varsayılan yolu (`/wp-admin/admin.php?page=wc-orders&action=edit&id=...`) UYDURULUYORDU.
 * Bu tahmin iki yaygın kurulumda YANLIŞ link üretir:
 *   1) HPOS KAPALI mağaza → doğru yol `post.php?post=<id>&action=edit`'tir;
 *   2) WordPress alt-dizine kurulu (`ornek.com/magaza/`) → gerçek admin `…/magaza/wp-admin/…`
 *      iken origin'den türetilen link kök `…/wp-admin/…` olur.
 * Her iki durumda da operatör "sipariş bulunamadı"/404 sayfasına düşüyordu. Doğru yolu YALNIZ
 * mağazanın kendisi bilir → şablon katalog senkronunda mağazadan gelir veya operatör elle girer
 * (S5: panel şablonu YALNIZ kolon boşken yazar, operatörün girdiğini EZMEZ).
 *
 * NEDEN webhookUrl KULLANILMIYOR (gerçek olaydan): `sites.webhook_url` makineden-makineye bir
 * adrestir ve İÇ hostname olabilir (sahada: `http://wordpress/wp-json/wpteslimat/v1/webhook`,
 * Docker servis adı). Origin'i oradan türetmek operatöre ÇÖZÜLEMEYEN link üretiyordu.
 *
 * GÜVENLİK:
 *  - `remoteOrderId` `encodeURIComponent` ile kaçırılır (query/yol parçalanamaz).
 *  - Üretilen her URL `new URL()` ile ayrıştırılır; YALNIZ http/https şeması kabul edilir
 *    (`javascript:`/`data:` şablonu → null; operatör-kaynaklı da olsa ham geçirilmez).
 *  - Kimlik bilgisi taşıyan URL (`https://kullanici:parola@host/...`) REDDEDİLİR (F15).
 *  - Göreli şablon başka bir origin'e sıçrayamaz (protokol-göreli `//baska-host/...` → null).
 *
 * DÜRÜSTLÜK: hostname "genel" görünmüyorsa link ÜRETİLMEZ (null). Yanlış bir yönlendirme
 * vermektense hiç link vermemek doğrudur — operatör linke tıklayıp hata sayfasıyla karşılaşmasın.
 */

/**
 * Yalnız link üretimi için gereken alanlar (sır kolonu OKUNMAZ/İSTENMEZ).
 * `type` link türetiminde ARTIK KULLANILMAZ (S4) ama çağıranlar site satırını bu şekilde
 * seçtiği için alan korunur (ileride kanal-özel şablon varsayılanı gerekirse buradan okunur).
 */
export type StoreAdminUrlSite = {
  type?: string | null;
  domain?: string | null;
  adminOrderUrlTemplate?: string | null;
};

/**
 * Yalnız iç ağda/geliştirme ortamında çözülen alan adı sonekleri (RFC 6761/8375 özel-kullanım
 * + yaygın LAN sonekleri). Bu soneklerle biten hostname operatörün tarayıcısında çözülmez.
 */
const INTERNAL_HOST_SUFFIXES = [
  '.local',
  '.localhost',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.test',
  '.invalid',
  '.example',
];

/**
 * Hostname operatörün tarayıcısından çözülebilir "genel" bir ad mı?
 * Reddedilenler: nokta içermeyen çıplak hostname ('wordpress', 'api' — Docker servis adı),
 * localhost, loopback IP (127.0.0.0/8, ::1), 0.0.0.0 ve iç-ağ sonekleri.
 */
function isPublicHostname(hostname: string): boolean {
  // IPv6 URL hostname'i köşeli parantezli gelir ('[::1]') → sadeleştir.
  const host = hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return false;
  if (host === 'localhost' || host === '::1' || host === '::' || host === '0.0.0.0') return false;
  if (/^127\./.test(host)) return false;
  // Nokta da iki nokta da yoksa çıplak iç hostname'dir (yalnız iç DNS/hosts ile çözülür).
  if (!host.includes('.') && !host.includes(':')) return false;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return true;
}

/**
 * Ham metni güvenli mutlak URL'e çevirir: http/https DIŞI şema, KİMLİK BİLGİSİ taşıyan URL ve
 * iç/çözülemeyen hostname reddedilir (null). Ayrıştırılamayan metin de null.
 */
function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // F15: `https://kullanici:parola@magaza.example.com/...` — şablonda kimlik bilgisi
    // bulunması ya yanlış yapılandırmadır ya da kimlik-avı/karışıklık girişimidir. Panel
    // bu URL'i operatöre GÖSTERMEZ (tarayıcıda tıklanınca sır ekrana/geçmişe/log'a düşerdi;
    // ayrıca `user@host` biçimi gerçek hedefi gizlemeye yarayan klasik bir hiledir).
    if (u.username || u.password) return null;
    if (!isPublicHostname(u.hostname)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Mağaza origin'i YALNIZ `sites.domain`'den türetilir (webhookUrl'den ASLA — iç hostname riski).
 * domain kolonu şemasız tutulur ('ornek-site.com') ama şemalı/yollu girilmiş olabilir → normalize edilir.
 */
function originFromDomain(domain: string | null | undefined): string | null {
  const raw = (domain ?? '').trim();
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withScheme);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // F15 (aynı gerekçe): domain alanına da kimlik bilgisi yazılmış olabilir → origin türetme.
    if (u.username || u.password) return null;
    if (!isPublicHostname(u.hostname)) return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Mağaza adminindeki siparişi açan URL'i üretir; üretilemiyorsa null döner (UI linki gizler).
 *
 * Link YALNIZ `sites.admin_order_url_template` doluyken üretilir (S4) — tip-tabanlı tahmin YOK.
 * Şablonu olmayan sitede operatör "Mağazada aç" linki görmez; şablon site ayarlarından girilir
 * (ör. HPOS: `/wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}`, klasik:
 * `/wp-admin/post.php?post={orderId}&action=edit`).
 */
export function buildStoreAdminUrl(
  site: StoreAdminUrlSite | null | undefined,
  remoteOrderId: string | null | undefined,
): string | null {
  if (!site || !remoteOrderId) return null;

  const template = (site.adminOrderUrlTemplate ?? '').trim();
  // Şablon yoksa TAHMİN YOK → link yok (yanlış link vermektense hiç link verme).
  if (!template) return null;

  const encoded = encodeURIComponent(String(remoteOrderId));
  const filled = template.split('{orderId}').join(encoded);

  // Şablon operatör/mağaza kaynaklı ham metindir → OLDUĞU GİBİ kullanılmaz, ayrıştırılır.
  const absolute = safeHttpUrl(filled);
  if (absolute) return absolute;

  // Mutlak değilse göreli yol olabilir ("/wp-admin/...") → sitenin kendi origin'iyle çöz.
  const origin = originFromDomain(site.domain);
  if (!origin) return null;
  let resolved: URL;
  try {
    resolved = new URL(filled, origin);
  } catch {
    return null;
  }
  // Göreli şablon YALNIZ sitenin kendi origin'ine çözülebilir (protokol-göreli '//baska-host'
  // ile farklı bir mağazaya sıçrama engellenir).
  if (resolved.origin !== origin) return null;
  return safeHttpUrl(resolved.toString());
}
