<?php
/**
 * Plugin Name: Jetlisans — Lisans Teslimat İstemcisi
 * Description: WooCommerce siparişlerini merkezi Jetlisans paneline iletir; teslimatları
 *              müşteriye gösterir. Lisans verisi WP'de TUTULMAZ — panel tek doğruluk kaynağı.
 * Version: 0.1.0
 * Requires PHP: 7.4
 * Author: Jetlisans
 * Text Domain: jetlisans
 *
 * İnce istemci (MIMARI.md §7): yalnız istek kuyruğu + assignment_id referansı.
 */

if (!defined('ABSPATH')) {
    exit;
}

define('JETLISANS_VERSION', '0.1.0');
define('JETLISANS_DIR', plugin_dir_path(__FILE__));
define('JETLISANS_FILE', __FILE__);

require_once JETLISANS_DIR . 'includes/class-settings.php';
require_once JETLISANS_DIR . 'includes/class-panel-client.php';
require_once JETLISANS_DIR . 'includes/class-order-sync.php';
require_once JETLISANS_DIR . 'includes/class-order-list.php';
require_once JETLISANS_DIR . 'includes/class-webhook.php';
require_once JETLISANS_DIR . 'includes/class-my-account.php';
require_once JETLISANS_DIR . 'includes/class-admin-metabox.php';
require_once JETLISANS_DIR . 'includes/class-report-issue.php';
require_once JETLISANS_DIR . 'includes/class-updater.php';

/**
 * Eklentiyi başlat.
 */
function jetlisans_init() {
    Jetlisans_Settings::instance();
    Jetlisans_Order_Sync::instance();
    Jetlisans_Order_List::instance();
    Jetlisans_Webhook::instance();
    Jetlisans_My_Account::instance();
    Jetlisans_Admin_Metabox::instance();
    Jetlisans_Report_Issue::instance();
    Jetlisans_Updater::instance();
}
add_action('plugins_loaded', 'jetlisans_init');

/**
 * Kuyruk log budama işi — WP-cron her fırlattığında çalışabilmesi için action HER
 * yüklemede kayıtlı olmalı (aktivasyon değil, plugin dosyası düzeyinde).
 */
add_action('jetlisans_prune_queue', 'jetlisans_do_prune_queue');

/**
 * 30 günden eski kuyruk log satırlarını siler (§7: "yerel tablo YALNIZ istek kuyruğu
 * logudur ve 30 gün otomatik budanır — DB şişmesi geri gelmesin"). Aktivasyonda
 * zamanlanan günlük cron bunu çağırır. Tablo adı $wpdb->prefix'ten türer (kullanıcı
 * girdisi değil); tek dinamik değer aralık gün sayısıdır (prepare ile bağlanır).
 */
function jetlisans_do_prune_queue() {
    global $wpdb;
    $table = $wpdb->prefix . 'jetlisans_queue';
    // phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- $table güvenli (prefix)
    $wpdb->query(
        $wpdb->prepare("DELETE FROM `$table` WHERE created_at < ( NOW() - INTERVAL %d DAY )", 30)
    );
}

/**
 * İstek kuyruğu log tablosu (30 gün budanır — DB şişmesin, §7) + günlük budama cron'u.
 */
function jetlisans_activate() {
    global $wpdb;
    $table = $wpdb->prefix . 'jetlisans_queue';
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

    // Günlük budama cron'u — DB şişmesini gerçekten önleyen kısım (§7). Yalnız yoksa kur.
    if (!wp_next_scheduled('jetlisans_prune_queue')) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'jetlisans_prune_queue');
    }
}
register_activation_hook(__FILE__, 'jetlisans_activate');

/**
 * Deaktivasyonda budama cron'unu temizle (yetim zamanlanmış olay kalmasın).
 */
function jetlisans_deactivate() {
    wp_clear_scheduled_hook('jetlisans_prune_queue');
}
register_deactivation_hook(__FILE__, 'jetlisans_deactivate');
