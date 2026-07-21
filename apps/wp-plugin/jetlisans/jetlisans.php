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
    Jetlisans_Webhook::instance();
    Jetlisans_My_Account::instance();
    Jetlisans_Admin_Metabox::instance();
    Jetlisans_Report_Issue::instance();
}
add_action('plugins_loaded', 'jetlisans_init');

/**
 * İstek kuyruğu log tablosu (30 gün budanır — DB şişmesin, §7).
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
}
register_activation_hook(__FILE__, 'jetlisans_activate');
