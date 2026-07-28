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
     * Panelden sürüm bilgisini çeker (12sa transient önbellekli). Başarısızlıkta null.
     * Dönen dizi panel yanıtının ham çözümlenmiş halidir (version, download_url, ...).
     */
    private static function fetch_info() {
        // "Tekrar denetle" → hem pozitif hem negatif önbelleği sil: acil sürüm ANINDA görünsün.
        $force = self::is_force_check();
        if ($force) {
            delete_transient(self::CACHE_KEY);
            delete_transient(self::FAIL_KEY);
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

        $panel = Wpteslimat_Settings::panel_url();
        if ($panel === '') {
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

        if ($http < 200 || $http >= 300 || !is_array($data) || empty($data['version'])) {
            set_transient(self::FAIL_KEY, 1, self::FAIL_TTL);
            return null;
        }

        delete_transient(self::FAIL_KEY);
        set_transient(self::CACHE_KEY, $data, self::CACHE_TTL);
        return $data;
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
            return $transient;
        }

        $new_version = (string) $info['version'];
        $basename = self::basename();
        $download = isset($info['download_url']) ? (string) $info['download_url'] : '';

        if (version_compare($new_version, WPTESLIMAT_VERSION, '<=')) {
            // (#13) Panel sürümü mevcut sürümden YENİ DEĞİL. Erken dönmek yerine `no_update`
            // kaydı yaz: WP eklenti listesindeki "otomatik güncellemeleri etkinleştir" bağlantısı
            // + auto-update cron YALNIZ eklenti bu transient'in no_update listesinde göründüğünde
            // çalışır (aksi halde WP eklentiyi 'bilinmeyen kaynak' sayıp oto-güncelleme UI'sini gizler).
            if (!isset($transient->no_update) || !is_array($transient->no_update)) {
                $transient->no_update = [];
            }
            $transient->no_update[$basename] = (object) [
                'slug'        => 'wpteslimat',
                'plugin'      => $basename,
                'new_version' => WPTESLIMAT_VERSION,
                'package'     => $download,
                'url'         => Wpteslimat_Settings::panel_url(),
            ];
            return $transient;
        }

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
