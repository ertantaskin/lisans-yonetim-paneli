<?php
if (!defined('ABSPATH')) exit;

/**
 * Ayarlar + kimlik bilgisi erişimi. Sırlar (api key, hmac secret) ÖNCELİKLE
 * wp-config.php sabitlerinden okunur (§8 — WP DB'de düz metin option değil).
 * Panel URL sır değildir; option olarak da tutulabilir.
 *
 * "Panele Bağlan" tek-seferlik kod akışı (§7/§14): operatör panelden aldığı
 * tek kullanımlık kodu buraya girer → eklenti kimlik doğrulaması GEREKTİRMEYEN
 * `POST {panel}/v1/connect/claim { code }` çağrısını yapar; panel siteyi eşler
 * ve `{ siteDomain, apiKey, hmacSecret }` döner. Bunlar option'a kaydedilir.
 * Sabit tanımlıysa (JETLISANS_API_KEY vb.) option'lar yok sayılacağı için bu
 * akış devre dışı bırakılır.
 */
class Jetlisans_Settings {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_init', [$this, 'register']);
        add_action('admin_post_jetlisans_connect', [$this, 'handle_connect']);
        add_action('admin_notices', [$this, 'clone_notice']);
    }

    public static function panel_url() {
        if (defined('JETLISANS_PANEL_URL')) return rtrim(JETLISANS_PANEL_URL, '/');
        return rtrim((string) get_option('jetlisans_panel_url', ''), '/');
    }
    public static function api_key() {
        return defined('JETLISANS_API_KEY') ? JETLISANS_API_KEY : (string) get_option('jetlisans_api_key', '');
    }
    public static function hmac_secret() {
        return defined('JETLISANS_HMAC_SECRET') ? JETLISANS_HMAC_SECRET : (string) get_option('jetlisans_hmac_secret', '');
    }
    public static function is_configured() {
        return self::panel_url() && self::api_key() && self::hmac_secret();
    }

    /**
     * Staging/klon koruması (§7 "URL değişince pasif mod"). "Panele Bağlan" anında sitenin
     * home_url'i `jetlisans_bound_home`'a yazılır. Site başka bir alan adına klonlanırsa
     * (prod → staging, aynı wp-config → aynı api_key/hmac_secret) home_url DEĞİŞİR ve klon
     * gerçek panele push edip CANLI stoğu tüketebilir. Bu kontrol o durumu yakalar.
     *
     * Baseline YOKSA (sabit-tabanlı kurulum veya bu sürümden önce bağlanmış eski site)
     * false döner — kontrol atlanır (mevcut kurulumları kırmamak için güvenli varsayılan);
     * korumayı etkinleştirmek için panele bir kez yeniden bağlanmak yeterlidir.
     */
    public static function is_clone() {
        $bound = (string) get_option('jetlisans_bound_home', '');
        if ($bound === '') return false;
        return untrailingslashit(home_url()) !== untrailingslashit($bound);
    }

    /** Kopya/staging tespit edilirse yönetici panelinde kalıcı uyarı gösterir. */
    public function clone_notice() {
        if (!self::is_clone()) return;
        if (!current_user_can('manage_options')) return;
        $bound = (string) get_option('jetlisans_bound_home', '');
        echo '<div class="notice notice-error"><p>' . esc_html(sprintf(
            'Jetlisans: Site adresi (%s) bağlanma anındaki adresten (%s) farklı. Kopya/staging koruması etkin: ' .
            'siparişler panele İLETİLMİYOR (canlı stok korunur). Bu kasıtlı bir taşımaysa panele yeniden bağlanın.',
            home_url(),
            $bound
        )) . '</p></div>';
    }

    /**
     * SIR kimlik bilgileri (apiKey/hmacSecret) sabitle tanımlı mı? "Panele Bağlan"
     * akışının tek amacı bu sırları panelden çekip option'a yazmaktır; sırlar sabitse
     * yazılan option'lar yok sayılacağından akış anlamsızdır (devre dışı).
     *
     * NOT: Sırsız JETLISANS_PANEL_URL sabiti bu akışı KİLİTLEMEZ — yalnız panel
     * adresi sabitken token/secret alma akışı geçerli kalmalıdır (panel URL yine
     * connect isteğinde `self::panel_url()` sabit değerinden gelir).
     */
    private static function has_const() {
        return defined('JETLISANS_API_KEY') || defined('JETLISANS_HMAC_SECRET');
    }

    /**
     * Panel URL güvenli mi? "Panele Bağlan" yanıtı sırları düz metin döndürdüğü
     * için https zorunludur; yalnız yerel geliştirme adresleri (localhost/127.0.0.1/::1)
     * http'ye izinlidir.
     */
    private static function is_secure_panel_url($url) {
        $host = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        if ($host === 'localhost' || $host === '127.0.0.1' || $host === '::1') {
            return true;
        }
        return strtolower((string) wp_parse_url($url, PHP_URL_SCHEME)) === 'https';
    }

    public function menu() {
        add_options_page('Jetlisans', 'Jetlisans', 'manage_options', 'jetlisans', [$this, 'page']);
    }

    public function register() {
        register_setting('jetlisans', 'jetlisans_panel_url');
        register_setting('jetlisans', 'jetlisans_api_key');
        register_setting('jetlisans', 'jetlisans_hmac_secret');
    }

    public function page() {
        $configured = self::is_configured();
        $has_const  = self::has_const();
        ?>
        <div class="wrap">
            <h1>Jetlisans — Lisans Teslimat İstemcisi</h1>
            <?php self::render_connect_notice(); ?>
            <p>Durum:
                <?php if ($configured): ?>
                    <strong style="color:#1a7f5a">✓ Yapılandırıldı</strong> — panel: <?php echo esc_html(self::panel_url()); ?>
                <?php else: ?>
                    <strong style="color:#c0392b">✗ Eksik</strong>
                <?php endif; ?>
            </p>

            <hr>
            <h2>Panele Bağlan (tek seferlik kod)</h2>
            <p>Panel yönetim arayüzünden aldığınız <strong>tek kullanımlık bağlan kodunu</strong> girin;
               eklenti API anahtarı ve HMAC sırrını panelden otomatik alıp kaydeder.</p>
            <?php if ($has_const): ?>
                <p><strong style="color:#b26a00">Sabit tanımlı — kod ile bağlama devre dışı.</strong>
                   Kimlik bilgileri <code>wp-config.php</code> sabitlerinden okunuyor.</p>
            <?php else: ?>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="jetlisans_connect">
                    <?php wp_nonce_field('jetlisans_connect'); ?>
                    <table class="form-table">
                        <tr>
                            <th><label for="jl-connect-panel">Panel URL</label></th>
                            <td>
                                <input type="url" id="jl-connect-panel" name="panel_url" required
                                       value="<?php echo esc_attr(get_option('jetlisans_panel_url', '')); ?>"
                                       placeholder="https://api.167-233-108-12.sslip.io" class="regular-text">
                            </td>
                        </tr>
                        <tr>
                            <th><label for="jl-connect-code">Bağlan Kodu</label></th>
                            <td>
                                <input type="text" id="jl-connect-code" name="connect_code" required
                                       autocomplete="off" class="regular-text">
                                <br><small>Panelden alınan tek kullanımlık koddur; bir kez kullanılır.</small>
                            </td>
                        </tr>
                    </table>
                    <?php submit_button('Panele Bağlan', 'primary', 'submit', false); ?>
                </form>
            <?php endif; ?>

            <hr>
            <h2>Gelişmiş — kimlik bilgilerini el ile gir</h2>
            <p><em>Güvenlik önerisi (§8):</em> sırları <code>wp-config.php</code>'ye sabit olarak ekleyin:</p>
            <pre style="background:#f6f7f7;padding:12px;border-radius:6px">define('JETLISANS_PANEL_URL', 'https://api.panel.example');
define('JETLISANS_API_KEY', 'jl_...');
define('JETLISANS_HMAC_SECRET', '...');</pre>
            <form method="post" action="options.php">
                <?php settings_fields('jetlisans'); ?>
                <table class="form-table">
                    <tr><th>Panel URL</th><td><input type="url" name="jetlisans_panel_url" value="<?php echo esc_attr(get_option('jetlisans_panel_url', '')); ?>" class="regular-text" <?php disabled(defined('JETLISANS_PANEL_URL')); ?>></td></tr>
                    <tr><th>API Key</th><td><input type="text" name="jetlisans_api_key" value="<?php echo esc_attr(get_option('jetlisans_api_key', '')); ?>" class="regular-text" <?php disabled(defined('JETLISANS_API_KEY')); ?>><br><small>Sabit tanımlıysa buradan değiştirilemez.</small></td></tr>
                    <tr><th>HMAC Secret</th><td><input type="password" name="jetlisans_hmac_secret" value="<?php echo esc_attr(get_option('jetlisans_hmac_secret', '')); ?>" class="regular-text" <?php disabled(defined('JETLISANS_HMAC_SECRET')); ?>></td></tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    /**
     * "Panele Bağlan" işlem sonucu bildirimi (redirect query arg üzerinden).
     * Ayar sayfası başında çağrılır.
     */
    private static function render_connect_notice() {
        if (!isset($_GET['jetlisans_connect'])) return;
        $flag = sanitize_key(wp_unslash($_GET['jetlisans_connect']));
        $msg  = isset($_GET['jetlisans_msg'])
            ? sanitize_text_field(wp_unslash($_GET['jetlisans_msg'])) : '';

        if ($flag === 'ok') {
            $text = $msg !== ''
                ? sprintf('Panele bağlanıldı (site: %s).', $msg)
                : 'Panele bağlanıldı.';
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($text) . '</p></div>';
        } elseif ($flag === 'missing') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html('Panel URL ve bağlan kodu zorunludur.') . '</p></div>';
        } elseif ($flag === 'const') {
            echo '<div class="notice notice-warning is-dismissible"><p>' .
                esc_html('Sabit tanımlı — kod ile bağlama devre dışı.') . '</p></div>';
        } elseif ($flag === 'insecure') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html('Panel adresi https değil. Kimlik bilgileri düz metin gönderileceğinden bağlantı yapılmadı; güvenli (https) bir panel adresi girin.') .
                '</p></div>';
        } elseif ($flag === 'error') {
            $text = $msg !== ''
                ? sprintf('Panele bağlanılamadı: %s', $msg)
                : 'Panele bağlanılamadı. Kodu ve panel adresini kontrol edin.';
            echo '<div class="notice notice-error is-dismissible"><p>' . esc_html($text) . '</p></div>';
        }
    }

    /**
     * "Panele Bağlan" form gönderimini işler: yetki + nonce doğrula → panele
     * kimlik doğrulamasız `POST /v1/connect/claim { code }` → dönen kimlik
     * bilgilerini option'a kaydet → ayar sayfasına geri yönlendir.
     */
    public function handle_connect() {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html('Bu işlem için yetkiniz yok.'), '', ['response' => 403]);
        }
        check_admin_referer('jetlisans_connect');

        // Sabit tanımlıysa option yazımı yok sayılır — akış devre dışı.
        if (self::has_const()) {
            self::redirect_settings('const');
        }

        $panel = isset($_POST['panel_url'])
            ? rtrim(esc_url_raw(trim(wp_unslash($_POST['panel_url']))), '/') : '';
        $code = isset($_POST['connect_code'])
            ? sanitize_text_field(wp_unslash($_POST['connect_code'])) : '';

        if ($panel === '' || $code === '') {
            self::redirect_settings('missing');
        }

        // Yanıt kimlik bilgilerini (apiKey/hmacSecret) DÜZ METİN döndürür; panel
        // https değilse sırlar ağda açık geçer — göndermeden reddet (yerel geliştirme
        // için localhost/127.0.0.1 istisna).
        if (!self::is_secure_panel_url($panel)) {
            self::redirect_settings('insecure');
        }

        $res = wp_remote_post($panel . '/v1/connect/claim', [
            'timeout' => 15,
            'headers' => ['Content-Type' => 'application/json'],
            'body'    => wp_json_encode(['code' => $code]),
        ]);

        if (is_wp_error($res)) {
            self::redirect_settings('error', $res->get_error_message());
        }

        $http = (int) wp_remote_retrieve_response_code($res);
        $data = json_decode(wp_remote_retrieve_body($res), true);

        if ($http < 200 || $http >= 300 || !is_array($data) ||
            empty($data['apiKey']) || empty($data['hmacSecret'])) {
            $err = is_array($data) && !empty($data['error']) ? (string) $data['error'] : '';
            self::redirect_settings('error', $err);
        }

        update_option('jetlisans_panel_url', $panel);
        update_option('jetlisans_api_key', (string) $data['apiKey']);
        update_option('jetlisans_hmac_secret', (string) $data['hmacSecret']);
        // Staging/klon koruması baseline'ı (§7): bağlanma anındaki site adresi. Site başka
        // alana klonlanırsa is_clone() bunu yakalar ve push'u pasifleştirir.
        update_option('jetlisans_bound_home', home_url());

        $domain = isset($data['siteDomain']) ? (string) $data['siteDomain'] : '';
        self::redirect_settings('ok', $domain);
    }

    /** Ayar sayfasına sonuç bayrağıyla (ve varsa mesajla) geri yönlendirir. */
    private static function redirect_settings($flag, $detail = '') {
        $url = add_query_arg('jetlisans_connect', $flag, admin_url('options-general.php?page=jetlisans'));
        if ($detail !== '') {
            $url = add_query_arg('jetlisans_msg', rawurlencode($detail), $url);
        }
        wp_safe_redirect($url);
        exit;
    }
}
