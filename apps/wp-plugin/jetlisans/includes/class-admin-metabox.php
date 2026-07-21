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

    /** Panel mask formatıyla hizalı: sabit gövde + son 4 hane (uzunluk/yapı sızmaz). */
    private static function mask($value) {
        $value = (string) $value;
        return strlen($value) <= 4 ? '••••••' : '••••••' . substr($value, -4);
    }

    public function render($post_or_order) {
        $order = ($post_or_order instanceof WC_Order) ? $post_or_order : wc_get_order($post_or_order->ID);
        if (!$order) return;

        $status = $order->get_meta('_jetlisans_status');
        $panel_order_id = $order->get_meta('_jetlisans_order_id');

        echo '<p><strong>Durum:</strong> ' . esc_html($status ?: 'bilinmiyor') . '</p>';

        // (§8 dinamik satış kotası) Sipariş güvenlik incelemesine alındıysa görsel işaret.
        // Yalnız pending iken göster; onaylanınca (webhook durumu tazeler) rozet düşer.
        if ($order->get_meta('_jetlisans_held_for_review') === 'yes' && ($status === 'pending' || $status === '')) {
            echo '<p><strong style="color:#b45309">' . esc_html__('İnceleme bekliyor', 'jetlisans') . '</strong></p>';
        }

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
                $is_account = isset($d['kind']) ? ($d['kind'] === 'account') : (!empty($d['fields']));
                // Hesap ürünü: alan-alan; secret alanlar KUYRUKSUZ maskeli, kullanıcı adı açık.
                if ($is_account && !empty($d['fields']) && is_array($d['fields'])) {
                    foreach ($d['fields'] as $f) {
                        $label = isset($f['label']) ? $f['label'] : '';
                        $val = isset($f['value']) ? $f['value'] : '';
                        // secret alan: son-4 sızdırma → sabit gövde; açık alan: tam değer.
                        $show = !empty($f['secret']) ? '••••••' : $val;
                        echo '<li><strong>' . esc_html($label) . ':</strong> <code>' . esc_html($show) . '</code></li>';
                    }
                } elseif ($is_account) {
                    echo '<li><em>Teslimat hazırlanıyor.</em></li>';
                } else {
                    $p = isset($d['payload']) ? $d['payload'] : '';
                    // SABİT genişlikli maske (panel ile hizalı); TAM değer DOM'a YAZILMAZ (title yok).
                    echo '<li><code>' . esc_html(self::mask($p)) . '</code></li>';
                }
                if (!empty($d['validUntil'])) {
                    echo '<li style="list-style:none;margin-left:-16px"><small>' . esc_html__('Geçerlilik:', 'jetlisans') . ' ' . esc_html(Jetlisans_My_Account::format_date($d['validUntil'])) . '</small></li>';
                }
            }
            echo '</ul>';
        }
        $panel = Jetlisans_Settings::panel_url();
        if ($panel) {
            echo '<p style="margin-top:10px"><em>Değiştir / tekrar mail / iptal işlemleri panel arayüzünde.</em></p>';
        }
    }
}
