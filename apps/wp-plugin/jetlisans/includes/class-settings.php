<?php
if (!defined('ABSPATH')) exit;

/**
 * Ayarlar + kimlik bilgisi erişimi. Sırlar (api key, hmac secret) ÖNCELİKLE
 * wp-config.php sabitlerinden okunur (§8 — WP DB'de düz metin option değil).
 * Panel URL sır değildir; option olarak da tutulabilir.
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
        ?>
        <div class="wrap">
            <h1>Jetlisans — Lisans Teslimat İstemcisi</h1>
            <p>Durum:
                <?php if ($configured): ?>
                    <strong style="color:#1a7f5a">✓ Yapılandırıldı</strong> — panel: <?php echo esc_html(self::panel_url()); ?>
                <?php else: ?>
                    <strong style="color:#c0392b">✗ Eksik</strong>
                <?php endif; ?>
            </p>
            <p><em>Güvenlik önerisi (§8):</em> sırları <code>wp-config.php</code>'ye sabit olarak ekleyin:</p>
            <pre style="background:#f6f7f7;padding:12px;border-radius:6px">define('JETLISANS_PANEL_URL', 'https://api.panel.example');
define('JETLISANS_API_KEY', 'jl_...');
define('JETLISANS_HMAC_SECRET', '...');
define('JETLISANS_WEBHOOK_SECRET', '...'); // opsiyonel, yoksa HMAC_SECRET kullanılır</pre>
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
}
