<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş ekranı meta box (§7). Panel durumu + teslim edilen lisanslar (site-scoped
 * deliveries). Yazma aksiyonları (değiştir/askıya al) panel admin'inde; buradan
 * yalnız görüntüleme + panele link. HPOS + klasik uyumlu.
 */
class Jetlisans_Admin_Metabox {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('add_meta_boxes', [$this, 'add'], 30, 2);
    }

    public function add($post_type, $post) {
        // HPOS ekran id'si veya klasik 'shop_order'.
        $screen = class_exists('\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController')
            && function_exists('wc_get_page_screen_id')
            ? wc_get_page_screen_id('shop-order')
            : 'shop_order';
        add_meta_box('jetlisans_deliveries', 'Jetlisans — Lisans Teslimatı', [$this, 'render'], $screen, 'side', 'high');
    }

    public function render($post_or_order) {
        $order = ($post_or_order instanceof WC_Order) ? $post_or_order : wc_get_order($post_or_order->ID);
        if (!$order) return;

        $status = $order->get_meta('_jetlisans_status');
        $panel_order_id = $order->get_meta('_jetlisans_order_id');

        echo '<p><strong>Durum:</strong> ' . esc_html($status ?: 'bilinmiyor') . '</p>';

        if (!$panel_order_id) {
            echo '<p><em>Henüz panele iletilmedi.</em></p>';
            return;
        }

        $res = Jetlisans_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries');
        $deliveries = isset($res['body']['deliveries']) ? $res['body']['deliveries'] : [];

        if (empty($deliveries)) {
            echo '<p><em>Aktif teslimat yok.</em></p>';
        } else {
            echo '<ul style="margin:0;padding-left:16px">';
            foreach ($deliveries as $d) {
                $p = isset($d['payload']) ? $d['payload'] : '';
                // Maskeli göster (son 5 hane), tam değer başlık ipucunda.
                $masked = strlen($p) > 5 ? str_repeat('•', max(0, strlen($p) - 5)) . substr($p, -5) : $p;
                echo '<li><code title="' . esc_attr($p) . '">' . esc_html($masked) . '</code></li>';
            }
            echo '</ul>';
        }
        $panel = Jetlisans_Settings::panel_url();
        if ($panel) {
            echo '<p style="margin-top:10px"><em>Değiştir / tekrar mail / iptal işlemleri panel arayüzünde.</em></p>';
        }
    }
}
