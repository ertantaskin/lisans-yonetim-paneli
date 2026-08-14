<?php
/**
 * WP Teslimat Eklentisi — SAF PHP test koşucusu (PHPUnit YOK, bağımlılık YOK).
 *
 *   php apps/wp-plugin/tests/run.php
 *   (VPS'te tek atımlık konteynerle: docker run --rm -v "$PWD":/app -w /app php:8.2-cli-alpine \
 *     php apps/wp-plugin/tests/run.php)
 *
 * Başarısızlıkta ÇIKIŞ KODU 1 döner → CI'a doğrudan bağlanabilir (mevcut `php -l` adımının yanına).
 *
 * NEDEN BÖYLE (kapsam boşluğunun kendisi): eklentide hiç otomatik test yoktu; tek denetim
 * sözdizimi (`php -l`) idi. Oysa bu kod panelin kendi güncelleyicisiyle MÜŞTERİ SİTELERİNE
 * otomatik kurulur — bir mantık kusuru uzaktan ve sessizce yayılır. WordPress test paketi kurmak
 * bu turun kapsamı dışı olduğundan, WP'ye BAĞIMLI OLMAYAN saf yardımcılar hedeflenir.
 *
 * ÜRETİM KODU DEĞİŞTİRİLMEDİ: `private static` yardımcılar Reflection ile çağrılır. Görünürlüğü
 * gevşetmek (public yapmak) yeni bir genel yüzey açardı — bu proje `is_private_host` için bunu
 * BİLEREK reddetmişti (bkz. class-updater.php yorumu), aynı çizgi korunuyor.
 *
 * ODAK: güvenlik kapıları ve daha önce GERÇEKTEN kırılmış davranışlar —
 *   · is_secure_panel_url  → 1.0.3'te bu kapı tüm senkronu SESSİZCE durdurmuştu
 *   · is_valid_package_url → paket URL'i = uzaktan kod kurulumu (MITM/RCE savunması)
 *   · verify_webhook       → gelen webhook'un TEK kimlik doğrulaması
 *   · canonical_path       → imza yolu panel `canonicalizePath` ile BİREBİR olmak zorunda
 *   · is_clone             → klon/staging'in canlı lisansa dokunmasını engelleyen kapı
 *   · line_matches         → bonus satırı eşleştirmesi (geçmişte hatalı raporlanmıştı)
 *   · format_date          → wp_date vs date_i18n (saat dilimi)
 *   · ham enum sızıntısı   → durum etiketleri kullanıcıya teknik kod göstermemeli
 *
 * KAPSANMAYAN (WP/WooCommerce'e bağımlı — bilerek denenmedi): sipariş push/iade uzlaştırması
 * (WC_Order gerekir), iş kilidi/`$wpdb` atomikliği, Action Scheduler dispatch'i, AJAX yetki
 * kapıları, REST kaydı, katalog toplama (wc_get_products), HPOS tespiti.
 */

// ─── Minimal WordPress ortamı (yalnız test edilen kod yollarının ihtiyacı kadar) ──────────────
define('ABSPATH', __DIR__ . '/');           // include dosyalarının ilk satırdaki kapısı
define('MINUTE_IN_SECONDS', 60);
define('HOUR_IN_SECONDS', 3600);
define('DAY_IN_SECONDS', 86400);
// NOT: WPTESLIMAT_FILE ve register_activation_hook BİLEREK tanımlanmaz → class-catalog-sync.php
// dosya sonundaki aktivasyon kancası bloğu kendi guard'ıyla atlanır (yükleme yan etkisi yok).

$GLOBALS['wpt_options'] = [];
$GLOBALS['wpt_home']    = 'https://shop.example.com';

function get_option($name, $default = '') {
    return array_key_exists($name, $GLOBALS['wpt_options']) ? $GLOBALS['wpt_options'][$name] : $default;
}
function update_option($name, $value, $autoload = null) {
    $GLOBALS['wpt_options'][$name] = $value;
    return true;
}
function delete_option($name) {
    unset($GLOBALS['wpt_options'][$name]);
    return true;
}
function home_url($path = '') { return $GLOBALS['wpt_home'] . $path; }
function wp_parse_url($url, $component = -1) { return parse_url((string) $url, $component); }
function untrailingslashit($s) { return rtrim((string) $s, '/\\'); }
function __($text, $domain = '') { return $text; }
function esc_html($text) { return htmlspecialchars((string) $text, ENT_QUOTES, 'UTF-8'); }
function wp_check_invalid_utf8($string, $strip = false) {
    // WP davranışının test için yeterli yaklaşımı: geçerli olana dek sondan bayt at.
    // Bilerek YALNIZ PCRE kullanır (iconv/mbstring uzantısı şart olmasın — koşucu sıfır bağımlılıklı).
    $s = (string) $string;
    while ($s !== '' && preg_match('//u', $s) !== 1) {
        $s = substr($s, 0, -1);
    }
    return $s;
}
// format_date testinde hangi fonksiyonun SEÇİLDİĞİNİ ayırt edebilmek için ikisi de işaretli döner.
function wp_date($format, $timestamp = null, $timezone = null) { return 'WPDATE:' . $format . ':' . (int) $timestamp; }
function date_i18n($format, $timestamp = null, $gmt = false) { return 'I18N:' . $format . ':' . (int) $timestamp; }

// ─── Test edilecek sınıflar ──────────────────────────────────────────────────────────────────
$inc = dirname(__DIR__) . '/wpteslimat/includes/';
require_once $inc . 'class-settings.php';
require_once $inc . 'class-panel-client.php';
require_once $inc . 'class-updater.php';
require_once $inc . 'class-order-sync.php';
require_once $inc . 'class-order-list.php';
require_once $inc . 'class-webhook.php';
require_once $inc . 'class-my-account.php';
require_once $inc . 'class-admin-metabox.php';
require_once $inc . 'class-catalog-sync.php';

// ─── Minik test çatısı ───────────────────────────────────────────────────────────────────────
$GLOBALS['wpt_pass'] = 0;
$GLOBALS['wpt_fail'] = [];

/** private/protected static yardımcıyı üretim kodunu değiştirmeden çağırır. */
function call_static($class, $method, array $args = []) {
    $m = new ReflectionMethod($class, $method);
    $m->setAccessible(true);
    return $m->invokeArgs(null, $args);
}
function is_true($name, $actual)  { assert_same($name, true, $actual); }
function is_false($name, $actual) { assert_same($name, false, $actual); }
function assert_same($name, $expected, $actual) {
    if ($expected === $actual) { $GLOBALS['wpt_pass']++; return; }
    $GLOBALS['wpt_fail'][] = sprintf(
        "%s\n     beklenen: %s\n     gelen   : %s",
        $name,
        var_export($expected, true),
        var_export($actual, true)
    );
}
function assert_contains($name, $needle, $haystack) {
    if (is_string($haystack) && strpos($haystack, $needle) !== false) { $GLOBALS['wpt_pass']++; return; }
    $GLOBALS['wpt_fail'][] = sprintf("%s\n     '%s' bulunmadı; gelen: %s", $name, $needle, var_export($haystack, true));
}
function group($title) { echo "\n── $title\n"; }

// ═════════════════════════════════════════════════════════════════════════════════════════════
group('Wpteslimat_Settings::is_secure_panel_url — panel adresi güvenlik kapısı');
$sec = static function ($url) { return Wpteslimat_Settings::is_secure_panel_url($url); };

is_true('https her zaman kabul', $sec('https://panel.example.com'));
is_false('http + GERÇEK alan adı reddedilir (sır düz metin gitmez)', $sec('http://panel.example.com'));
is_true('http + localhost', $sec('http://localhost:3001'));
is_true('http + 127.0.0.1', $sec('http://127.0.0.1:3001'));
is_true('http + [::1]', $sec('http://[::1]:3001'));
// 1.0.3 REGRESYONU: bu satır kırıldığında Docker/aynı-sunucu kurulumunda eklenti panele HİÇ
// istek yapmamış, sipariş push + katalog senkronu GÜNLERCE sessizce durmuştu.
is_true('http + tek etiketli Docker servis adı (api:3001)', $sec('http://api:3001'));
is_true('http + 10/8', $sec('http://10.1.2.3'));
is_true('http + 192.168/16', $sec('http://192.168.1.5:8080'));
is_true('http + 172.16/12', $sec('http://172.16.0.9'));
is_true('http + 169.254/16 link-local', $sec('http://169.254.1.1'));
is_true('http + .local', $sec('http://panel.local'));
is_true('http + .internal', $sec('http://panel.internal'));
is_true('http + .test', $sec('http://panel.test'));
is_false('http + genel yönlendirilebilir IP', $sec('http://8.8.8.8'));
is_false('boş adres', $sec(''));
is_false('şemasız/host-suz çöp', $sec('panel.example.com'));
// BİLİNÇLİ DAVRANIŞ: bu fonksiyon YALNIZ "https mi, değilse host özel mi" sorusunu yanıtlar;
// şema daraltmasını çağıran yapar (bkz. Updater::is_valid_package_url). Sözleşme kilitleniyor.
is_true('ftp + özel host → bu kapı şemayı DARALTMAZ (çağıranın işi)', $sec('ftp://localhost/x'));

group('Wpteslimat_Updater::is_valid_package_url — kurulacak .zip adresi (MITM/RCE savunması)');
$GLOBALS['wpt_options']['wpteslimat_panel_url'] = 'https://panel.example.com';
$pkg = static function ($url) { return call_static('Wpteslimat_Updater', 'is_valid_package_url', [$url]); };
is_true('panel host + https', $pkg('https://panel.example.com/v1/updates/plugin/download'));
is_false('YABANCI host (paket enjeksiyonu)', $pkg('https://evil.example.com/x.zip'));
is_false('panel host ama http + genel alan adı', $pkg('http://panel.example.com/x.zip'));
is_false('ftp şeması reddedilir', $pkg('ftp://panel.example.com/x.zip'));
is_false('boş adres', $pkg(''));

$GLOBALS['wpt_options']['wpteslimat_panel_url'] = 'http://api:3001';
// 1.0.4 DÜZELTMESİ: paket kapısı panel kapısıyla AYNI tanıma bağlandı. Ayrı/dar kural, meşru iç
// kurulumda kapatılamayan kalıcı bir kırmızı uyarı bandı üretiyordu.
is_true('iç kurulum: http + tek etiketli host + AYNI host', $pkg('http://api:3001/v1/updates/plugin/download'));
is_false('iç kurulum: farklı host yine reddedilir', $pkg('http://other:3001/x.zip'));
$GLOBALS['wpt_options']['wpteslimat_panel_url'] = '';
is_false('panel adresi yokken hiçbir paket geçerli değil', $pkg('https://panel.example.com/x.zip'));

group('Wpteslimat_Panel_Client::canonical_path — imza yolu (panel canonicalizePath ile birebir)');
$cp = static function ($p) { return call_static('Wpteslimat_Panel_Client', 'canonical_path', [$p]); };
assert_same('query yoksa aynen', '/v1/orders', $cp('/v1/orders'));
assert_same('fragment atılır', '/v1/orders', $cp('/v1/orders#frag'));
assert_same('query paramları sıralanır', '/v1/x?a=1&b=2', $cp('/v1/x?b=2&a=1'));
assert_same('boş query "?" düşer', '/v1/x', $cp('/v1/x?'));
assert_same('fragment önce atılır, sonra sıralanır', '/v1/x?a=1', $cp('/v1/x?a=1#f'));

group('Wpteslimat_Panel_Client::sanitize_actor — başlık enjeksiyonu + uzunluk');
$act = static function ($v) { return call_static('Wpteslimat_Panel_Client', 'sanitize_actor', [$v]); };
assert_same('CR/LF elenir (başlık enjeksiyonu)', 'abc', $act("a\r\nbc"));
assert_same('HTML/kontrol karakterleri elenir', 'ahmet', $act('ah<m>et'));
assert_same('izinli karakterler korunur', 'a.b_c@d-e+f', $act('a.b_c@d-e+f'));
assert_same('boş → boş', '', $act(''));
$long = $act(str_repeat('a', 100));
assert_same('60 karaktere kırpılır (panel WpActor ile aynı)', 60, strlen($long));

group('Wpteslimat_Panel_Client::verify_webhook — gelen webhook TEK kimlik doğrulaması');
$sign = static function ($secret, $method, $path, $ts, $nonce, $body) {
    $canon = call_static('Wpteslimat_Panel_Client', 'canonical_path', [$path]);
    $payload = strtoupper($method) . "\n" . $canon . "\n" . $ts . "\n" . $nonce . "\n" . hash('sha256', $body);
    return hash_hmac('sha256', $payload, $secret);
};
$path = '/wp-json/wpteslimat/v1/webhook';
$body = '{"event":"order.fulfilled","seq":1}';
$ts   = (string) time();
$GLOBALS['wpt_options']['wpteslimat_hmac_secret'] = 'test-secret';
$good = $sign('test-secret', 'POST', $path, $ts, 'n1', $body);
is_true('geçerli imza kabul', Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, 'n1', $body, $good));
is_false('bozuk imza reddedilir', Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, 'n1', $body, str_repeat('0', 64)));
is_false('gövde kurcalanırsa reddedilir', Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, 'n1', $body . 'x', $good));
is_false('yanlış secret ile üretilmiş imza reddedilir',
    Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, 'n1', $body, $sign('baska', 'POST', $path, $ts, 'n1', $body)));
$old = (string) (time() - 400);
is_false('zaman penceresi dışı (replay) reddedilir',
    Wpteslimat_Panel_Client::verify_webhook('POST', $path, $old, 'n1', $body, $sign('test-secret', 'POST', $path, $old, 'n1', $body)));
// Query'li yol: imza kanonikleştirilmiş yol üzerinden kurulur → param sırası fark etmez.
$qsig = $sign('test-secret', 'POST', '/x?a=1&b=2', $ts, 'n2', $body);
is_true('query param sırası imzayı bozmaz', Wpteslimat_Panel_Client::verify_webhook('POST', '/x?b=2&a=1', $ts, 'n2', $body, $qsig));
// (#12) Yapılandırılmamış sitede secret '' olur; boş anahtar HERKESÇE bilinir.
$GLOBALS['wpt_options']['wpteslimat_hmac_secret'] = '';
is_false('BOŞ secret ile hiçbir imza kabul edilmez',
    Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, 'n3', $body, $sign('', 'POST', $path, $ts, 'n3', $body)));
$GLOBALS['wpt_options']['wpteslimat_hmac_secret'] = 'test-secret';

group('Wpteslimat_Settings::is_clone — klon/staging kapısı');
$clone = static function ($bound, $home) {
    $GLOBALS['wpt_options']['wpteslimat_bound_home'] = $bound;
    $GLOBALS['wpt_home'] = $home;
    return Wpteslimat_Settings::is_clone();
};
is_false('taban çizgisi YOKSA kontrol atlanır (güvenli varsayılan)', $clone('', 'https://shop.example.com'));
is_false('aynı adres', $clone('https://shop.example.com', 'https://shop.example.com'));
// SSL kurulumu (http→https) siteyi yanlışlıkla "klon" sanıp siparişleri sessizce durdurmamalı.
is_false('şema değişimi (http→https) klon SAYILMAZ', $clone('http://shop.example.com', 'https://shop.example.com'));
is_false('sondaki eğik çizgi fark etmez', $clone('https://shop.example.com/', 'https://shop.example.com'));
is_false('büyük/küçük harf fark etmez', $clone('https://Shop.Example.COM', 'https://shop.example.com'));
is_true('farklı host → KLON', $clone('https://shop.example.com', 'https://staging.example.com'));
is_true('alt dizin farkı → KLON', $clone('https://shop.example.com', 'https://shop.example.com/staging'));
$GLOBALS['wpt_options']['wpteslimat_bound_home'] = '';
$GLOBALS['wpt_home'] = 'https://shop.example.com';

group('Wpteslimat_Admin_Metabox::line_matches — bonus satırı eşleştirmesi');
$lm = static function ($remote, $item) { return call_static('Wpteslimat_Admin_Metabox', 'line_matches', [$remote, $item]); };
is_true('normal kalem birebir', $lm('123', '123'));
is_true('bonus:<item>:<uuid> aynı kaleme sayılır', $lm('bonus:123:9f2c', '123'));
is_false('başka kalem', $lm('124', '123'));
// Önek karışması olmamalı: "bonus:1:" öneki, kalem 12'ye ait bir satırı yakalamamalı.
is_false('önek karışması yok (bonus:12:… ↔ kalem 1)', $lm('bonus:12:abc', '1'));
is_false('boş kalem kimliği hiçbir şeye eşleşmez', $lm('123', ''));
is_false('eski biçim bonus:<uuid> (kalem id yok) bağlanmaz', $lm('bonus:9f2c', '123'));

group('Wpteslimat_Admin_Metabox::mask — panel maske biçimiyle hizalı');
$mask = static function ($v) { return call_static('Wpteslimat_Admin_Metabox', 'mask', [$v]); };
assert_same('son 4 hane görünür', '••••••1234', $mask('ABCD-EFGH-IJKL-1234'));
assert_same('kısa değer tamamen maskelenir', '••••••', $mask('abc'));
assert_same('boş değer', '••••••', $mask(''));
assert_same('tam 4 karakter sızmaz', '••••••', $mask('1234'));

group('Wpteslimat_Admin_Metabox — "değiştirildi" geriye dönük fallback');
$hist = [
    ['oldAssignmentId' => 'a1', 'oldMasked' => '••••••1234'],
    ['oldMasked' => '—'],
];
$lookup = call_static('Wpteslimat_Admin_Metabox', 'replaced_lookup', [$hist]);
is_true('eski atama kimliği kümeye girer', isset($lookup['ids']['a1']));
is_false('"—" yer tutucusu maske kümesine GİRMEZ', isset($lookup['masked']['—']));
$isr = static function ($a) use ($lookup) { return call_static('Wpteslimat_Admin_Metabox', 'is_replaced', [$a, $lookup]); };
is_true('revoked + geçmişte kimlik eşleşmesi → değiştirildi', $isr(['status' => 'revoked', 'id' => 'a1']));
is_true('quarantined + maske eşleşmesi → değiştirildi', $isr(['status' => 'quarantined', 'maskedPayload' => '••••••1234']));
is_false('AKTİF atama asla "değiştirildi" olmaz', $isr(['status' => 'active', 'id' => 'a1']));
is_false('eşleşme yoksa iade olarak kalır', $isr(['status' => 'revoked', 'id' => 'zz']));

group('Ham durum kodu (enum) kullanıcıya SIZMAMALI');
$asg = static function ($s) { return call_static('Wpteslimat_Admin_Metabox', 'asg_status_label', [$s]); };
assert_same('active', 'Aktif', $asg('active'));
assert_same('quarantined da "Değiştirildi"', 'Değiştirildi', $asg('quarantined'));
assert_same('bilinmeyen durum teknik kod göstermez', 'Bilinmiyor', $asg('some_new_status'));
$ord = static function ($s) { return call_static('Wpteslimat_Admin_Metabox', 'order_status_label', [$s]); };
assert_same('held → İncelemede', 'İncelemede', $ord('held'));
assert_same('unmapped → Türkçe', 'Ürün eşlenmemiş', $ord('unmapped'));
assert_same('bilinmeyen sipariş durumu', 'Bilinmiyor', $ord('zzz'));
$ols = static function ($s) { return call_static('Wpteslimat_Order_List', 'status_label', [$s]); };
assert_same('liste: fulfilled', 'Teslim edildi', $ols('fulfilled'));
assert_same('liste: bilinmeyen', 'Bilinmiyor', $ols('zzz'));
$pill = static function ($s) { return call_static('Wpteslimat_Admin_Metabox', 'pill_class', [$s]); };
assert_same('bilinen durum kendi sınıfını alır', 'wpt-pill--active', $pill('active'));
assert_same('bilinmeyen durum nötr sınıfa düşer', 'wpt-pill--replaced', $pill('zzz'));

group('Wpteslimat_Admin_Metabox::actor_label — "kim yaptı" okunurluğu');
$al = static function ($a) { return call_static('Wpteslimat_Admin_Metabox', 'actor_label', [$a]); };
assert_same('wp:<kullanıcı>@<site>', 'ahmet (mağaza)', $al('wp:ahmet@magaza.com'));
assert_same('wp:system → otomatik', 'otomatik işlem', $al('wp:system@magaza.com'));
assert_same('system', 'otomatik işlem', $al('system'));
assert_same('admin → panel yöneticisi', 'panel yöneticisi', $al('admin'));
assert_same('boş aktör', '', $al(''));
assert_same('e-postalı kullanıcı adında son @ ayırır', 'a@b (mağaza)', $al('wp:a@b@magaza.com'));

group('Wpteslimat_Webhook::human_note — ham olay adı sipariş notuna sızmamalı');
$hn = static function ($e, $s) { return call_static('Wpteslimat_Webhook', 'human_note', [$e, $s]); };
assert_contains('fulfilled → Türkçe cümle', 'Teslimat tamamlandı', $hn('order.fulfilled', 'fulfilled'));
assert_contains('durum, olaya göre ÖNCELİKLİ', 'Kısmi teslimat', $hn('order.fulfilled', 'partial'));
assert_contains('held', 'güvenlik incelemesine', $hn('order.held', 'held'));
assert_contains('durum yoksa olaydan türer', 'Kısmi teslimat', $hn('order.partially_fulfilled', ''));
assert_same('bilinmeyen olay + boş durum', 'Panelden teslimat durumu güncellendi.', $hn('order.whatever', ''));
foreach ([['order.fulfilled', 'fulfilled'], ['x', 'revoked'], ['order.partially_fulfilled', '']] as $c) {
    $note = $hn($c[0], $c[1]);
    is_false('notta ham "order." öneki yok: ' . $c[0] . '/' . $c[1], strpos($note, 'order.') !== false);
}

group('Wpteslimat_Order_List::pstatus_meta_clause — "panele iletilmedi" özel dalı');
$mc = static function ($v) { return call_static('Wpteslimat_Order_List', 'pstatus_meta_clause', [$v]); };
$not_pushed = $mc(Wpteslimat_Order_List::PSTATUS_NOT_PUSHED);
assert_same('yokluk sorgusu _wpteslimat_pushed üzerinden', '_wpteslimat_pushed', $not_pushed['key']);
assert_same('NOT EXISTS kullanılır', 'NOT EXISTS', $not_pushed['compare']);
$fulfilled = $mc('fulfilled');
assert_same('normal durum panel-status meta anahtarı', '_wpteslimat_panel_status', $fulfilled['key']);
assert_same('değer birebir eşleşir', 'fulfilled', $fulfilled['value']);

group('Wpteslimat_Catalog_Sync::template_hash — şema kararlılığı (gereksiz tam katalog push yok)');
$th = static function ($t) { return call_static('Wpteslimat_Catalog_Sync', 'template_hash', [$t]); };
assert_same(
    'http/https farkı hash DEĞİŞTİRMEZ (proxy arkasında her tetikte push olmasın)',
    $th('http://shop.example.com/wp-admin/post.php?post={orderId}&action=edit'),
    $th('https://shop.example.com/wp-admin/post.php?post={orderId}&action=edit')
);
is_false(
    'GERÇEK değişiklik (HPOS açıldı) hash değiştirir',
    $th('https://s/wp-admin/post.php?post={orderId}&action=edit')
        === $th('https://s/wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}')
);
assert_same('null şablon → boş dizenin hash\'i', md5(''), $th(null));

group('Wpteslimat_Catalog_Sync::truncate — çok baytlı güvenli kırpma');
$tr = static function ($s, $n) { return call_static('Wpteslimat_Catalog_Sync', 'truncate', [$s, $n]); };
assert_same('sınır altı aynen', 'abc', $tr('abc', 10));
assert_same('sınır üstü kırpılır', 'abc', $tr('abcdef', 3));

group('Wpteslimat_Updater::truncate_url — uyarı metni BOŞALMAMALI (çok baytlı URL)');
$tu = static function ($u, $n = 200) { return call_static('Wpteslimat_Updater', 'truncate_url', [$u, $n]); };
assert_same('kısa URL aynen', 'https://a/b.zip', $tu('https://a/b.zip'));
$long = $tu('https://a/' . str_repeat('ü', 300));
assert_contains('kırpma GÖRÜNÜR biçimde işaretlenir', 'kırpıldı', $long);
is_false('kırpılmış çok baytlı URL boş kalmaz (esc_html onu silmemeli)', $long === '' || $long === ' … (kırpıldı)');

group('Wpteslimat_My_Account::format_date — saat dilimi (wp_date vs date_i18n)');
$GLOBALS['wpt_options']['date_format'] = 'd.m.Y';
$out = Wpteslimat_My_Account::format_date('2026-08-14T18:00:00Z');
// date_i18n() timestamp'i ZATEN yerel sayar → panelden gelen UTC değeri mağaza saat diliminde
// DEĞİL, UTC olarak basılıyordu. wp_date() varsa o tercih edilmeli.
assert_contains('wp_date tercih edilir (UTC→mağaza saati)', 'WPDATE:', $out);
is_false('date_i18n\'e düşmez', strpos($out, 'I18N:') === 0);
assert_same('çözülemeyen tarih ham dönerse de ISO bozulmaz', 'yok', Wpteslimat_My_Account::format_date('yok'));

group('Wpteslimat_Order_Sync — iş kilidi anahtarı işe göre AYRIŞIR');
$lk = static function ($job, $id) { return call_static('Wpteslimat_Order_Sync', 'lock_key', [$job, $id]); };
is_false('farklı iş → farklı kilit', $lk('push', 5) === $lk('revoke', 5));
is_false('farklı sipariş → farklı kilit', $lk('push', 5) === $lk('push', 6));
assert_same('aynı (iş, sipariş) → AYNI kilit (async/retry/satır-içi paylaşır)', $lk('refund', 7), $lk('refund', '7'));
$dm = static function ($job, $id) { return call_static('Wpteslimat_Order_Sync', 'done_marker_key', [$job, $id]); };
is_false('"yapıldı" işareti kilit anahtarından AYRI', $dm('push', 5) === $lk('push', 5));

// ═════════════════════════════════════════════════════════════════════════════════════════════
$fails = $GLOBALS['wpt_fail'];
echo "\n" . str_repeat('─', 72) . "\n";
if (empty($fails)) {
    printf("TAMAM — %d doğrulama geçti.\n", $GLOBALS['wpt_pass']);
    exit(0);
}
printf("BAŞARISIZ — %d geçti, %d başarısız:\n\n", $GLOBALS['wpt_pass'], count($fails));
foreach ($fails as $i => $f) {
    printf("  %d) %s\n\n", $i + 1, $f);
}
exit(1);
