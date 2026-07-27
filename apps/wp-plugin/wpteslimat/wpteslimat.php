<?php
/**
 * Plugin Name: WP Teslimat Eklentisi
 * Description: WooCommerce siparişlerini merkezi lisans teslimat paneline iletir; teslimatları
 *              müşteriye gösterir. Lisans verisi WP'de TUTULMAZ — panel tek doğruluk kaynağı.
 * Version: 0.4.0
 * Requires PHP: 7.4
 * Author: Lisans Paneli
 * Text Domain: wpteslimat
 *
 * İnce istemci (MIMARI.md §7): yalnız istek kuyruğu + assignment_id referansı.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('WPTESLIMAT_VERSION', '0.4.0');
define('WPTESLIMAT_DIR', plugin_dir_path(__FILE__));
define('WPTESLIMAT_FILE', __FILE__);

// ── Geriye dönük uyum (yeniden adlandırma: eski ad → wpteslimat) ─────────────
// Eski kurulumların wp-config.php'sinde önceki sürümün sabitleri (…_PANEL_URL /
// …_API_KEY / …_HMAC_SECRET / …_BOUND_HOME) tanımlı olabilir. Yeni ad tanımlı
// DEĞİLSE eskisinden köprüle → mevcut siteler güncelleme sonrası kimlik doğrulamaya
// KESİNTİSİZ devam eder (operatör wp-config'i düzenlemek zorunda kalmaz).
foreach (['PANEL_URL', 'API_KEY', 'HMAC_SECRET', 'BOUND_HOME'] as $__wpt_legacy) {
    if (!defined('WPTESLIMAT_' . $__wpt_legacy) && defined('JETLISANS_' . $__wpt_legacy)) {
        define('WPTESLIMAT_' . $__wpt_legacy, constant('JETLISANS_' . $__wpt_legacy));
    }
}
unset($__wpt_legacy);

require_once WPTESLIMAT_DIR . 'includes/class-settings.php';
require_once WPTESLIMAT_DIR . 'includes/class-panel-client.php';
require_once WPTESLIMAT_DIR . 'includes/class-order-sync.php';
require_once WPTESLIMAT_DIR . 'includes/class-order-list.php';
require_once WPTESLIMAT_DIR . 'includes/class-webhook.php';
require_once WPTESLIMAT_DIR . 'includes/class-my-account.php';
require_once WPTESLIMAT_DIR . 'includes/class-admin-metabox.php';
require_once WPTESLIMAT_DIR . 'includes/class-product-mapping.php';
require_once WPTESLIMAT_DIR . 'includes/class-report-issue.php';
require_once WPTESLIMAT_DIR . 'includes/class-updater.php';

/**
 * Eklentiyi başlat.
 */
function wpteslimat_init() {
    Wpteslimat_Settings::instance();
    Wpteslimat_Order_Sync::instance();
    Wpteslimat_Order_List::instance();
    Wpteslimat_Webhook::instance();
    Wpteslimat_My_Account::instance();
    Wpteslimat_Admin_Metabox::instance();
    Wpteslimat_Product_Mapping::instance();
    Wpteslimat_Report_Issue::instance();
    Wpteslimat_Updater::instance();

    // Budama cron'u YALNIZ aktivasyonda kuruluyordu; WP güncellemede aktivasyon hook'u ÇALIŞMAZ
    // (bu eklenti kendi güncelleyicisini taşır) ve temizlenen bir cron olayı da yeniden kurulmaz.
    // Eksikse normal yükleme yolunda yeniden kur → kuyruk logu sınırsız büyümesin (§7). Action zaten
    // dosya düzeyinde kayıtlı (aşağıda), bu yüzden cron tetiklendiğinde çalışır.
    if (Wpteslimat_Settings::is_configured() && !wp_next_scheduled('wpteslimat_prune_queue')) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'wpteslimat_prune_queue');
    }
}
add_action('plugins_loaded', 'wpteslimat_init');

/**
 * Kuyruk log budama işi — WP-cron her fırlattığında çalışabilmesi için action HER
 * yüklemede kayıtlı olmalı (aktivasyon değil, plugin dosyası düzeyinde).
 */
add_action('wpteslimat_prune_queue', 'wpteslimat_do_prune_queue');

/**
 * 30 günden eski kuyruk log satırlarını siler (§7: "yerel tablo YALNIZ istek kuyruğu
 * logudur ve 30 gün otomatik budanır — DB şişmesi geri gelmesin"). Aktivasyonda
 * zamanlanan günlük cron bunu çağırır. Tablo adı $wpdb->prefix'ten türer (kullanıcı
 * girdisi değil); tek dinamik değer aralık gün sayısıdır (prepare ile bağlanır).
 */
function wpteslimat_do_prune_queue() {
    global $wpdb;
    $table = $wpdb->prefix . 'wpteslimat_queue';
    // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table güvenli (prefix)
    $wpdb->query(
        $wpdb->prepare("DELETE FROM `$table` WHERE created_at < ( NOW() - INTERVAL %d DAY )", 30)
    );
}

/**
 * İstek kuyruğu log tablosunu oluşturur (30 gün budanır — DB şişmesin, §7).
 * Hem aktivasyonda hem tek-seferlik göçte kullanılır (idempotent — dbDelta).
 */
function wpteslimat_create_queue_table() {
    global $wpdb;
    $table = $wpdb->prefix . 'wpteslimat_queue';
    $charset = $wpdb->get_charset_collate();
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta("CREATE TABLE $table (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        order_id BIGINT UNSIGNED NOT NULL,
        direction VARCHAR(10) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending',
        payload LONGTEXT NULL,
        response LONGTEXT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY order_id (order_id),
        KEY created_at (created_at)
    ) $charset;");
}

/**
 * Tek-seferlik yeniden-adlandırma göçü (eski ad → wpteslimat). WP eklenti GÜNCELLEMESİNDE
 * aktivasyon hook'u ÇALIŞMADIĞI için (bu eklenti kendi güncelleyicisini taşır) init'ten önce
 * de çağrılır; `wpteslimat_schema` sürüm option'ıyla korunur → normal yüklemede DB'ye dokunmaz.
 * Fresh kurulumda no-op (eski ad yok). Amaç: eski kuyruk tablosunu + connect-akışı option'larını
 * kaybetmeden yeni adlara taşımak, böylece güncelleyen siteler kesintisiz çalışır.
 */
function wpteslimat_ensure_schema() {
    if (get_option('wpteslimat_schema') === WPTESLIMAT_VERSION) {
        return; // Zaten güncel — her yüklemede DB sorgusu yapma.
    }
    global $wpdb;
    $new = $wpdb->prefix . 'wpteslimat_queue';
    $old = $wpdb->prefix . 'jetlisans_queue';

    // Kuyruk log tablosu: yeni yoksa → eskiyi yeniden adlandır (logları koru) yoksa taze oluştur.
    $has_new = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $new)) === $new;
    if (!$has_new) {
        $has_old = $wpdb->get_var($wpdb->prepare('SHOW TABLES LIKE %s', $old)) === $old;
        if ($has_old) {
            // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- tablo adları prefix'ten güvenli
            $wpdb->query("RENAME TABLE `$old` TO `$new`");
        } else {
            wpteslimat_create_queue_table();
        }
    }

    // Option göçü: connect akışının kaydettiği URL/sırlar + klon-koruma taban option'ı.
    foreach (['panel_url', 'api_key', 'hmac_secret', 'bound_home'] as $k) {
        $legacy = get_option('jetlisans_' . $k, null);
        if ($legacy !== null && $legacy !== '' && get_option('wpteslimat_' . $k, '') === '') {
            update_option('wpteslimat_' . $k, $legacy);
        }
    }

    update_option('wpteslimat_schema', WPTESLIMAT_VERSION);
}
// init (öncelik 10) sınıfları örneklemeden ÖNCE göçü tamamla (öncelik 5).
add_action('plugins_loaded', 'wpteslimat_ensure_schema', 5);

/**
 * İstek kuyruğu log tablosu + günlük budama cron'u + klon-koruma tabanı (fresh aktivasyon).
 */
function wpteslimat_activate() {
    wpteslimat_create_queue_table();

    // Günlük budama cron'u — DB şişmesini gerçekten önleyen kısım (§7). Yalnız yoksa kur.
    if (!wp_next_scheduled('wpteslimat_prune_queue')) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'wpteslimat_prune_queue');
    }

    // Klon/staging koruması TABAN ÇİZGİSİ (§7): bu sitenin home_url'ini bir kez sabitle.
    // Aktivasyon PROD'da kurulumda çalışır; DB staging'e klonlandığında (aynı wp-config → aynı
    // api_key/hmac_secret) klon bu PROD URL'ini devralır → is_clone() staging'de doğru şekilde true
    // döner. Böylece "Panele Bağlan" akışına GİRMEYEN sabit-tabanlı/el ile kurulumlarda da koruma
    // etkin olur (önceden yalnız connect akışı bound_home yazıyordu → önerilen güvenli kurulumda
    // korumanın kalıcı no-op olması giderildi). Yalnız yoksa yaz — mevcut bağlanmayı EZME.
    if (get_option('wpteslimat_bound_home', '') === '') {
        update_option('wpteslimat_bound_home', home_url());
    }
    update_option('wpteslimat_schema', WPTESLIMAT_VERSION);
}
register_activation_hook(__FILE__, 'wpteslimat_activate');

/**
 * Deaktivasyonda budama cron'unu temizle (yetim zamanlanmış olay kalmasın).
 */
function wpteslimat_deactivate() {
    wp_clear_scheduled_hook('wpteslimat_prune_queue');
}
register_deactivation_hook(__FILE__, 'wpteslimat_deactivate');
