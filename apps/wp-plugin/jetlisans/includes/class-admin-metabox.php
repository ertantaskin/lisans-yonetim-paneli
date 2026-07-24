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

        $local_status = $order->get_meta('_jetlisans_status');
        $panel_order_id = $order->get_meta('_jetlisans_order_id');

        // Panele hiç iletilmemiş sipariş → canlı sorgu yapılamaz; yerel durumu göster ve çık.
        if (!$panel_order_id) {
            echo '<p><strong>Durum:</strong> ' . esc_html($local_status ?: 'bilinmiyor') . '</p>';
            echo '<p><em>Henüz panele iletilmedi.</em></p>';
            return;
        }

        // Canlı /deliveries — YETKİLİ durum + `held` bayrağı buradan gelir. held-clear/rozet kararını
        // ve "Durum:" satırını bu FETCH SONRASI, canlı veriden sür (bayat manuel-poll _jetlisans_panel_status
        // DEĞİL). Panel rejectHeld akışı webhook YAYMAZ ama canlı /deliveries durumu+held'i doğru bildirir.
        $res = Jetlisans_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries');
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $deliveries = (isset($body['deliveries']) && is_array($body['deliveries'])) ? $body['deliveries'] : [];
        $fetch_ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        $live_status = isset($body['status']) ? (string) $body['status'] : '';
        $panel_held = ($fetch_ok && array_key_exists('held', $body)) ? (bool) $body['held'] : null;

        // "Durum:" — canlı durumu tercih et (bayat 'pending' okumasın); yoksa yerel meta'ya düş.
        $display_status = $live_status !== '' ? $live_status : ($local_status ?: 'bilinmiyor');
        echo '<p><strong>Durum:</strong> ' . esc_html($display_status) . '</p>';

        // (§8 held staleness) held-clear/rozet kararı canlı held + durumdan (my-account ile aynadır):
        // panel held=false YA DA terminal/teslim durumu (revoked/fulfilled/partial) → bayat işareti
        // idempotent temizle; rozet YALNIZ held gerçekten true iken (veya held sinyali yok + durum
        // pending/bilinmiyor → graceful fallback: fetch başarısızsa temizleme, rozeti koru).
        if ($order->get_meta('_jetlisans_held_for_review') === 'yes') {
            $terminal = in_array($live_status, ['revoked', 'fulfilled', 'partial'], true);
            if ($panel_held === false || $terminal) {
                $order->delete_meta_data('_jetlisans_held_for_review');
                $order->save();
            } elseif ($panel_held === true || ($panel_held === null && ($live_status === 'pending' || $live_status === ''))) {
                echo '<p><strong style="color:#b45309">' . esc_html__('İnceleme bekliyor', 'jetlisans') . '</strong></p>';
            }
        }

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
