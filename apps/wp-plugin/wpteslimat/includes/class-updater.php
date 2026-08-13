<?php
if (!defined('ABSPATH')) exit;

/**
 * Eklenti güncelleme denetçisi (§16). Güncelleme kaynağı WordPress.org DEĞİL,
 * merkezi lisans teslimat panelidir: eklenti panelin `/v1/updates/plugin/info`
 * ucundan sürüm bilgisini çeker ve WP'nin standart güncelleme akışına
 * (Kontrol Paneli → Güncellemeler, eklenti listesi "güncelle" bağlantısı) enjekte eder.
 *
 * Panel yapılandırılmamışsa (panel_url yok) hiçbir şey yapmaz — no-op.
 * Sürüm bilgisi 12 saat transient ile önbelleğe alınır (her istekte panel çağrısı yapılmaz).
 */
class Wpteslimat_Updater {
    private static $instance = null;

    /** Sürüm bilgisi önbellek anahtarı ve süresi (12 saat). */
    const CACHE_KEY = 'wpteslimat_update_info';
    const CACHE_TTL = 12 * HOUR_IN_SECONDS;

    /**
     * NEGATİF önbellek (başarısız denemeler). Panel kapalı/erişilemezken 12sn timeout'lu HTTP
     * denemesi HER güncelleme kontrolünde tekrarlanıp yönetim panelini yavaşlatıyordu. Başarısız
     * yanıt KISA süre (15dk) hatırlanır → hem site yavaşlamaz hem acil sürüm uzun süre gecikmez.
     */
    const FAIL_KEY = 'wpteslimat_update_fail';
    const FAIL_TTL = 15 * MINUTE_IN_SECONDS;

    /**
     * POZİTİF-BOŞ önbellek ("panel çalışıyor ama henüz yayınlanmış sürüm yok").
     *
     * Panelde hiç eklenti sürümü yayınlanmamışken uç `200 {}` (boş gövde) döndürür. Bu bir
     * BAŞARISIZLIK DEĞİLDİR — panel erişilebilir ve doğru yanıt veriyor. Bunu FAIL_KEY'e yazmak
     * yanıltıcıydı: "panel erişilemiyor" durumuyla "henüz yayın yok" durumu aynı kovaya düşüyordu.
     * Ayrı ve daha kısa (1 saat) anahtarla hatırlanır → site her güncelleme kontrolünde panele
     * gitmez, ilk yayın da en geç 1 saat içinde görünür (FAIL yolunun 15dk davranışı AYNEN kalır).
     */
    const EMPTY_KEY = 'wpteslimat_update_none';
    const EMPTY_TTL = HOUR_IN_SECONDS;

    /**
     * "Yeni sürüm var AMA paket URL'i güvenlik kapısına takıldı" bayrağı.
     *
     * Bu durum eskiden SESSİZDİ: WP "güncelleme yok" görüyor, operatör panelde yeni sürüm
     * yayınlanmış olmasına rağmen hiçbir yerde neden görmüyordu. Bu projede aynı ders daha önce
     * `is_secure_panel_url` kesintisinde alındı: fail-safe bir kapı SESSİZ olursa arıza teşhis
     * edilemez. Güvenlik kontrolü GEVŞETİLMEZ — yalnız GÖRÜNÜR kılınır (bkz. insecure_panel_notice).
     */
    const PKG_REJECT_KEY = 'wpteslimat_update_pkg_rejected';
    const PKG_REJECT_TTL = 12 * HOUR_IN_SECONDS;

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Panel yapılandırılmamışsa güncelleme denetimini hiç bağlama (no-op).
        if (Wpteslimat_Settings::panel_url() === '') {
            return;
        }
        add_filter('pre_set_site_transient_update_plugins', [$this, 'check_update']);
        add_filter('plugins_api', [$this, 'plugin_info'], 10, 3);
        // Paket URL'i reddedilip güncelleme düşürüldüyse yöneticiye GÖRÜNÜR uyarı bas.
        // Multisite: eklenti güncellemesini yapabilen kişi NETWORK yöneticisidir ve o kullanıcı
        // günlerce tek bir blogun panosuna hiç uğramayabilir → uyarıyı network ekranlarına da bağla.
        // (İki kanca aynı ekranda ateşlemez: `admin_notices` network-admin ekranlarında çalışmaz.)
        add_action('admin_notices', [$this, 'package_rejected_notice']);
        add_action('network_admin_notices', [$this, 'package_rejected_notice']);
    }

    /** Bu eklentinin plugin_basename değeri (ör. "wpteslimat/wpteslimat.php"). */
    private static function basename() {
        return plugin_basename(WPTESLIMAT_FILE);
    }

    /**
     * Operatör WP'nin "Tekrar denetle" (force-check) bağlantısına mı bastı?
     *
     * Panelden ACİL bir sürüm yayınlandığında 12 saatlik önbellek yüzünden güncelleme sitelerde
     * 12 saate kadar görünmüyordu; WP'nin standart kurtarma yolu force-check'tir ama bizim kendi
     * transient'imizi temizlemiyordu. Yetki kapısı: bayrak yalnız YÖNETİM tarafında ve eklenti
     * güncelleme yetkisi olan kullanıcı için geçerlidir → anonim ziyaretçi `?force-check=1` ile
     * önbelleği bozup her istekte panele HTTP çağrısı tetikleyemez.
     */
    private static function is_force_check() {
        // current_user_can, pluggable fonksiyonlara dayanır; filtre çok erken bir bağlamda
        // (mu-plugin/cron) tetiklenirse fatal vermeyelim → yoksa force-check yok say.
        if (!is_admin() || !function_exists('current_user_can') || !current_user_can('update_plugins')) {
            return false;
        }
        // phpcs:ignore WordPress.Security.NonceVerification.Recommended -- salt okunur önbellek tazeleme
        return !empty($_GET['force-check']);
    }

    /**
     * Panelden sürüm bilgisini çeker (12sa transient önbellekli). Sürüm yoksa/başarısızlıkta null.
     * Dönen dizi panel yanıtının ham çözümlenmiş halidir (version, download_url, ...).
     *
     * null'ın İKİ ayrı nedeni vardır ve ayrı önbelleklenir (çağıranlar için davranış aynı):
     *   - GERÇEK hata (ağ hatası / 4xx-5xx / bozuk JSON) → FAIL_KEY, 15dk.
     *   - Panel çalışıyor ama YAYIN YOK (2xx + geçerli JSON, `version` alanı yok) → EMPTY_KEY, 1sa.
     */
    private static function fetch_info() {
        // "Tekrar denetle" → pozitif + negatif + "yayın yok" önbelleklerini sil: acil sürüm ANINDA görünsün.
        $force = self::is_force_check();
        if ($force) {
            delete_transient(self::CACHE_KEY);
            delete_transient(self::FAIL_KEY);
            delete_transient(self::EMPTY_KEY);
        }

        $cached = get_transient(self::CACHE_KEY);
        if (is_array($cached)) {
            return $cached;
        }

        // Yakın zamanda başarısız olduysa panele tekrar tekrar gitme (site yavaşlamasın).
        // Force-check bu kapıyı BİLEREK atlar — operatör elle tazelemek istiyordur.
        if (!$force && get_transient(self::FAIL_KEY)) {
            return null;
        }

        // Panelde henüz yayın olmadığı yakın zamanda GÖRÜLDÜYSE de tekrar tekrar sorma.
        // Ayrı anahtar: bu bir hata değil, yalnız "içerik yok" durumudur (kısa TTL).
        if (!$force && get_transient(self::EMPTY_KEY)) {
            return null;
        }

        $panel = Wpteslimat_Settings::panel_url();
        if ($panel === '') {
            return null;
        }

        // GÜVENLİK (denetim W1): eklenti güncellemesi güvenilmez/DÜZ-METİN kanaldan ALINMAZ.
        // panel_url https değilse (localhost hariç) güncelleme denetimini ATLA → ağ yolundaki
        // bir saldırganın (MITM) sahte "yeni sürüm + kötücül download_url" enjekte edip WP'ye
        // keyfi PHP kurdurması (RCE) yolu kapanır. Orders/HMAC ayrı kanaldır; bu yalnız updater.
        if (!Wpteslimat_Settings::is_secure_panel_url($panel)) {
            set_transient(self::FAIL_KEY, 1, self::FAIL_TTL);
            return null;
        }

        $res = wp_remote_get($panel . '/v1/updates/plugin/info', [
            'timeout' => 12,
            'headers' => ['Accept' => 'application/json'],
        ]);

        if (is_wp_error($res)) {
            set_transient(self::FAIL_KEY, 1, self::FAIL_TTL);
            return null;
        }

        $http = (int) wp_remote_retrieve_response_code($res);
        $data = json_decode(wp_remote_retrieve_body($res), true);

        // GERÇEK hata: HTTP 2xx dışı ya da JSON olarak çözülemeyen gövde → panel erişilemez/bozuk
        // sayılır, KISA negatif önbellek (mevcut davranış AYNEN korunur).
        if ($http < 200 || $http >= 300 || !is_array($data)) {
            set_transient(self::FAIL_KEY, 1, self::FAIL_TTL);
            return null;
        }

        // 2xx + geçerli JSON, ama `version` YOK → panelde HENÜZ HİÇ SÜRÜM YAYINLANMAMIŞ (`200 {}`).
        // Panel sağlıklı; bunu "başarısızlık" saymak teknik olarak yanlıştı. FAIL_KEY'e YAZILMAZ
        // (varsa temizlenir), yerine kısa POZİTİF-boş önbellek yazılır ve null dönülür → çağıranlar
        // (check_update / plugin_info) bugünkü davranışlarını aynen sürdürür.
        if (empty($data['version'])) {
            delete_transient(self::FAIL_KEY);
            set_transient(self::EMPTY_KEY, 1, self::EMPTY_TTL);
            return null;
        }

        delete_transient(self::FAIL_KEY);
        delete_transient(self::EMPTY_KEY);
        set_transient(self::CACHE_KEY, $data, self::CACHE_TTL);
        return $data;
    }

    /**
     * Kurulacak paket URL'i güvenli mi? (denetim W1) YALNIZ panelin KENDİ host'undan
     * indirilebilir → MITM ile enjekte edilmiş düz-metin/yabancı-host bir .zip WP çekirdeğine
     * KURDURULMAZ (RCE savunması). İKİ koşul birlikte aranır: (1) kanal güvenli, (2) host panelle aynı.
     *
     * KANAL KAPISI TEK TANIMA BAĞLIDIR: `Wpteslimat_Settings::is_secure_panel_url()`. Burada eskiden
     * ayrı ve DAHA DAR bir kural vardı (http yalnız localhost/127.0.0.1/::1) — 1.0.3'te panel kapısı
     * genişletilince (özel IP · tek etiketli Docker servis adı · .local/.internal/.test) iki kapı
     * ÇELİŞTİ: `http://api:3001` gibi MEŞRU bir iç kurulumda panel adresi kabul edilirken paket adresi
     * reddediliyor, üstelik bu red artık GÖRÜNÜR bir uyarı bastığı için operatörün kapatamayacağı
     * kalıcı bir hata bandına dönüşüyordu. Doğrudan `is_secure_panel_url($download)` çağrılıyor
     * (yardımcıyı `public` yapmak yerine): `is_private_host` PRIVATE kalır, yeni yüzey açılmaz ve
     * kural gelecekte tek yerde değişir. TEHDİT MODELİ AYNI — host eşitliği şartı KALDIRILMADI.
     */
    private static function is_valid_package_url($download) {
        if ($download === '') {
            return false;
        }
        $host = strtolower((string) wp_parse_url($download, PHP_URL_HOST));
        $panel_host = strtolower((string) wp_parse_url(Wpteslimat_Settings::panel_url(), PHP_URL_HOST));
        if ($host === '' || $panel_host === '') {
            return false;
        }
        // Şemayı önce http(s) ile sınırla: `is_secure_panel_url` yalnız "https mi, değilse host özel mi"
        // sorusunu yanıtlar → özel host'ta ftp:/file: gibi bir şema kapıdan geçebilirdi (eski kural da
        // öyleydi). Burada tavan daraltılıyor, gevşetilmiyor.
        $scheme = strtolower((string) wp_parse_url($download, PHP_URL_SCHEME));
        if ($scheme !== 'https' && $scheme !== 'http') {
            return false;
        }
        // Şema kapısı: https her zaman; http YALNIZ kanıtlanabilir özel/iç adreslerde (panel kapısının
        // birebir aynısı). Trafik özel ağı terk etmiyorsa araya girecek bir ağ da yoktur.
        if (!Wpteslimat_Settings::is_secure_panel_url($download)) {
            return false;
        }
        return $host === $panel_host;
    }

    /**
     * Uyarı metnine girecek URL'i güvenle kısalt.
     *
     * Ham `substr()` BAYT keser; çok baytlı (UTF-8) bir karakterin ortasından bölerse `esc_html()`
     * geçersiz diziyi BOŞ string'e çevirir → operatör teşhis edilemez, bomboş bir kırmızı kutu görür.
     * mbstring varsa karakter bazında kesilir; yoksa bayt kesiminin bozuk kuyruğu WP'nin kendi
     * `wp_check_invalid_utf8(..., true)` süzgeciyle atılır. Kırpma SESSİZ değildir — görünür işaretlenir.
     */
    private static function truncate_url($url, $limit = 200) {
        $url = (string) $url;
        if (function_exists('mb_strlen') && function_exists('mb_substr')) {
            if (mb_strlen($url, 'UTF-8') <= $limit) {
                return $url;
            }
            return mb_substr($url, 0, $limit, 'UTF-8') . ' … (kırpıldı)';
        }
        if (strlen($url) <= $limit) {
            return $url;
        }
        return wp_check_invalid_utf8(substr($url, 0, $limit), true) . ' … (kırpıldı)';
    }

    /**
     * PKG_REJECT bayrağı okuma/yazma/silme — MULTISITE kapsam düzeltmesi.
     *
     * `set_transient()` ailesi BLOG kapsamlıdır; oysa tetikleyen `update_plugins` transient'i SİTE
     * (network) kapsamlıdır → bayrağı yazan blog ile temizleyen blog farklı olabilir ve uyarı yanlış
     * yerde asılı kalırdı. Multisite'ta site kapsamlı (`*_site_transient`) API kullanılır; tekil
     * kurulumda davranış AYNEN eskisi gibidir.
     */
    private static function flag_get() {
        return is_multisite()
            ? get_site_transient(self::PKG_REJECT_KEY)
            : get_transient(self::PKG_REJECT_KEY);
    }

    private static function flag_set($value, $ttl) {
        if (is_multisite()) {
            set_site_transient(self::PKG_REJECT_KEY, $value, $ttl);
            return;
        }
        set_transient(self::PKG_REJECT_KEY, $value, $ttl);
    }

    private static function flag_delete() {
        if (is_multisite()) {
            delete_site_transient(self::PKG_REJECT_KEY);
            return;
        }
        delete_transient(self::PKG_REJECT_KEY);
    }

    /**
     * Paket URL'i reddedildi → bayrağı yaz (SESSİZ düşürme yok). Güvenlik kararı DEĞİŞMEZ,
     * yalnız görünür olur. Kısa TTL: panel/panel_url düzeltilince uyarı kendiliğinden söner
     * (bir sonraki denetim ya kaydı yeniler ya da siler).
     *
     * `checked_at`/`expires_at`: bayrağın NE ZAMAN doğrulandığını ve ne zaman düşeceğini payload'ın
     * KENDİSİ taşır → panele ulaşılamadığı turlarda kayıt "bayat" damgasıyla TTL UZATILMADAN
     * yeniden yazılabilir (bkz. mark_flag_stale).
     */
    private static function flag_package_rejected($version, $download) {
        $now = time();
        self::flag_set([
            'version'    => (string) $version,
            'url'        => self::truncate_url($download),
            'host'       => strtolower((string) wp_parse_url($download, PHP_URL_HOST)),
            'panel_host' => strtolower((string) wp_parse_url(Wpteslimat_Settings::panel_url(), PHP_URL_HOST)),
            'checked_at' => $now,
            'expires_at' => $now + self::PKG_REJECT_TTL,
        ], self::PKG_REJECT_TTL);
    }

    /**
     * Panelden bilgi ALINAMADI (erişilemez / yayın yok / panel adresi güvensiz) ve elde eski bir
     * red bayrağı var → bayrağı SİLME. Silmek gerçek bir reddi tekrar sessizleştirirdi; asıl sorun
     * bilginin DOĞRULANAMAMIŞ olmasıdır. Bayrak `stale_since` damgasıyla yeniden yazılır ve uyarı
     * daha yumuşak bir metne döner. TTL UZATILMAZ: kalan süre payload'daki `expires_at`'ten
     * hesaplanır (süre dolduysa hiç yazılmaz, kayıt kendiliğinden düşer).
     */
    private static function mark_flag_stale() {
        $flag = self::flag_get();
        if (!is_array($flag)) {
            return;
        }
        $expires = isset($flag['expires_at']) ? (int) $flag['expires_at'] : 0;
        $left = $expires - time();
        if ($left <= 0) {
            return;
        }
        if (empty($flag['stale_since'])) {
            $flag['stale_since'] = time();
        }
        self::flag_set($flag, $left);
    }

    /**
     * Yeni sürüm yayınlanmış ama paket URL'i güvenlik kontrolüne takıldığı için güncelleme
     * SUNULMUYOR → `manage_options` yetkili kullanıcıya nedenini söyle (reddedilen host +
     * beklenen host). Aksi halde operatör "panelde yayınladım, sitede görünmüyor" ile kalıyor.
     */
    public function package_rejected_notice() {
        // Network ekranlarında yetkili kişi network yöneticisidir; blog ekranlarında mevcut kural korunur.
        $cap = (function_exists('is_network_admin') && is_network_admin())
            ? 'manage_network_options'
            : 'manage_options';
        if (!current_user_can($cap)) return;
        $flag = self::flag_get();
        if (!is_array($flag)) return;

        $version    = isset($flag['version']) ? (string) $flag['version'] : '';
        $url        = isset($flag['url']) ? (string) $flag['url'] : '';
        $host       = isset($flag['host']) ? (string) $flag['host'] : '';
        $panel_host = isset($flag['panel_host']) ? (string) $flag['panel_host'] : '';

        // BAYAT kayıt: bilgi eski bir denetimden geliyor, panele ŞU AN ulaşılamıyor. Kesin bir
        // güvenlik reddi gibi sunulmamalı (kullanıcı çaresiz hissetmesin) → yumuşak uyarı.
        if (!empty($flag['stale_since'])) {
            $checked = isset($flag['checked_at']) ? (int) $flag['checked_at'] : 0;
            $fmt = get_option('date_format') . ' ' . get_option('time_format');
            $when = $checked > 0
                ? (function_exists('wp_date') ? wp_date($fmt, $checked) : date_i18n($fmt, $checked))
                : '—';
            echo '<div class="notice notice-warning"><p>' . esc_html(sprintf(
                'Teslimat eklentisi: Panelde yeni sürüm (%1$s) için güncelleme sunulamamıştı — indirme ' .
                'adresi geçerli değildi. Bu bilgi en son %2$s tarihinde doğrulandı ve panele ŞU AN ' .
                'ulaşılamıyor, yani durum değişmiş olabilir. Panel erişimini ve adresini kontrol edip ' .
                '"Kontrol Paneli → Güncellemeler" sayfasından tekrar denetleyin.',
                $version !== '' ? $version : '—',
                $when
            )) . '</p></div>';
            return;
        }

        if ($url === '') {
            $msg = sprintf(
                'Teslimat eklentisi: Panelde yeni sürüm (%1$s) görünüyor ama panel bir indirme adresi ' .
                'BİLDİRMEDİ — güncelleme sunulmuyor. Panelde sürümün .zip paketiyle birlikte ' .
                'yayınlandığını doğrulayın.',
                $version
            );
        } else {
            $msg = sprintf(
                'Teslimat eklentisi: Panelde yeni sürüm (%1$s) var ama güncelleme SUNULMUYOR — ' .
                'panelin bildirdiği indirme adresi güvenlik kontrolüne takıldı. Reddedilen adres: %2$s ' .
                '(host: %3$s). Beklenen: "%4$s" host\'u ve https şeması (http yalnız iç/özel adreslerde ' .
                'kabul edilir). Panelin PUBLIC_API_URL ayarı ' .
                'ile buradaki panel adresi AYNI host olmalı; düzelttikten sonra "Kontrol Paneli → ' .
                'Güncellemeler" sayfasından tekrar denetleyin.',
                $version,
                $url,
                $host !== '' ? $host : '—',
                $panel_host !== '' ? $panel_host : '—'
            );
        }
        echo '<div class="notice notice-error"><p>' . esc_html($msg) . '</p></div>';
    }

    /**
     * `pre_set_site_transient_update_plugins` kancası: panelde daha yeni sürüm
     * varsa transient'in `response` alanına bu eklenti için güncelleme kaydı ekler.
     */
    public function check_update($transient) {
        if (!is_object($transient)) {
            return $transient;
        }

        $info = self::fetch_info();
        if ($info === null) {
            // Panel erişilemez / yayın yok / adres güvensiz → red bayrağı DOĞRULANAMADI.
            // Silme (gerçek reddi sessizleştirir), aynen bırakma (12 saat bayat uyarı) → BAYAT damgala.
            self::mark_flag_stale();
            return $transient;
        }

        $new_version = (string) $info['version'];
        $basename = self::basename();
        $download = isset($info['download_url']) ? (string) $info['download_url'] : '';
        // GÜVENLİK (denetim W1): kurulacak paket URL'i doğrulanır — yalnız panel host'u + https.
        // Geçersizse boş bırakılır ve AŞAĞIDA güncelleme HİÇ sunulmaz (kötücül kurulum önlenir).
        $safe_download = self::is_valid_package_url($download) ? $download : '';

        if (version_compare($new_version, WPTESLIMAT_VERSION, '<=')) {
            // (#13) Panel sürümü mevcut sürümden YENİ DEĞİL. Erken dönmek yerine `no_update`
            // kaydı yaz: WP eklenti listesindeki "otomatik güncellemeleri etkinleştir" bağlantısı
            // + auto-update cron YALNIZ eklenti bu transient'in no_update listesinde göründüğünde
            // çalışır (aksi halde WP eklentiyi 'bilinmeyen kaynak' sayıp oto-güncelleme UI'sini gizler).
            if (!isset($transient->no_update) || !is_array($transient->no_update)) {
                $transient->no_update = [];
            }
            // Daha yeni sürüm YOK → düşürülmüş bir güncelleme de yok; bayrak varsa temizle.
            self::flag_delete();
            $transient->no_update[$basename] = (object) [
                'slug'        => 'wpteslimat',
                'plugin'      => $basename,
                'new_version' => WPTESLIMAT_VERSION,
                'package'     => $safe_download,
                'url'         => Wpteslimat_Settings::panel_url(),
            ];
            return $transient;
        }

        // Yeni sürüm var AMA paket URL'i güvenli değil (plaintext / yabancı host) → güncelleme
        // SUNMA (RCE savunması). WP "güncelleme yok" görür; operatör panel_url'i https yapınca çözülür.
        // ARTIK SESSİZ DEĞİL: yönetici uyarısı için bayrak yazılır (güvenlik kararı aynen korunur).
        if ($safe_download === '') {
            self::flag_package_rejected($new_version, $download);
            return $transient;
        }

        // Paket URL'i geçerli → varsa eski uyarı bayrağını temizle.
        self::flag_delete();

        if (!isset($transient->response) || !is_array($transient->response)) {
            $transient->response = [];
        }

        $transient->response[$basename] = (object) [
            'slug'        => 'wpteslimat',
            'plugin'      => $basename,
            'new_version' => $new_version,
            'package'     => $download,
            'url'         => Wpteslimat_Settings::panel_url(),
        ];

        return $transient;
    }

    /**
     * `plugins_api` kancası: eklenti detay penceresi ("Ayrıntıları görüntüle")
     * için panel verisinden bilgi nesnesi üretir. Yalnız bu eklenti sorgulandığında.
     */
    public function plugin_info($result, $action, $args) {
        if ($action !== 'plugin_information') {
            return $result;
        }
        if (!isset($args->slug) || $args->slug !== 'wpteslimat') {
            return $result;
        }

        $info = self::fetch_info();
        if ($info === null) {
            return $result;
        }

        $download  = isset($info['download_url']) ? (string) $info['download_url'] : '';
        // GÜVENLİK (denetim B3): check_update ile TUTARLI ol — paket URL'i yalnız panel host'u + https
        // ise geçerli; değilse boş bırak (WP "Ayrıntıları görüntüle" penceresi güvensiz indirme sunmaz).
        if ($download !== '' && !self::is_valid_package_url($download)) {
            $download = '';
        }
        // Panel changelog'u sections:{changelog} altında NEST'ler → önce nest'li yoldan oku (eskiden
        // yalnız üst-düzey okunuyordu → detay penceresi Değişiklik Günlüğü hep boştu). Üst-düzey uyum fallback.
        $changelog = isset($info['sections']['changelog'])
            ? (string) $info['sections']['changelog']
            : (isset($info['changelog']) ? (string) $info['changelog'] : '');

        return (object) [
            'name'          => isset($info['name']) ? (string) $info['name'] : 'WP Teslimat Eklentisi',
            'slug'          => 'wpteslimat',
            'version'       => (string) $info['version'],
            'download_link' => $download,
            'sections'      => [
                'changelog' => $changelog,
            ],
            'requires'      => isset($info['requires']) ? (string) $info['requires'] : '',
            'tested'        => isset($info['tested']) ? (string) $info['tested'] : '',
            'requires_php'  => isset($info['requires_php']) ? (string) $info['requires_php'] : '7.4',
        ];
    }
}
