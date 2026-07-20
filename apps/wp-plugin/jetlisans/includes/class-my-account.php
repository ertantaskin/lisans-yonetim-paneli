<?php
if (!defined('ABSPATH')) exit;

/**
 * Müşteri teslimat görünümü (§7). Sipariş detayında panel'den SERVER-SIDE çekilir;
 * yalnız aktif atamalar (panel SQL seviyesinde filtreler). Sırlar tarayıcıya panel
 * API'sinden değil, WP sunucusundan gelir; no-store.
 */
class Jetlisans_My_Account {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('woocommerce_order_details_after_order_table', [$this, 'render'], 10, 1);
    }

    public function render($order) {
        if (!is_a($order, 'WC_Order')) return;
        $panel_order_id = $order->get_meta('_jetlisans_order_id');
        if (!$panel_order_id) return;

        $res = Jetlisans_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries');
        $deliveries = isset($res['body']['deliveries']) ? $res['body']['deliveries'] : [];

        echo '<section class="jetlisans-deliveries" style="margin-top:24px">';
        echo '<h2>' . esc_html__('Lisans Teslimatınız', 'jetlisans') . '</h2>';

        if (empty($deliveries)) {
            $status = isset($res['body']['status']) ? $res['body']['status'] : '';
            echo '<p>' . esc_html($this->status_message($status)) . '</p>';
        } else {
            echo '<table class="woocommerce-table shop_table"><tbody>';
            foreach ($deliveries as $i => $d) {
                echo '<tr><td>';
                $is_account = isset($d['kind']) ? ($d['kind'] === 'account') : (!empty($d['fields']));
                // Hesap ürünü: alan-alan (Kullanıcı adı / Parola) + alan başına Kopyala.
                if ($is_account && !empty($d['fields']) && is_array($d['fields'])) {
                    echo '<div class="jetlisans-fields">';
                    foreach ($d['fields'] as $fi => $f) {
                        $label = isset($f['label']) ? $f['label'] : '';
                        $value = isset($f['value']) ? $f['value'] : '';
                        $fid = 'jl-f-' . intval($i) . '-' . intval($fi);
                        echo '<div style="margin:2px 0">';
                        echo '<strong>' . esc_html($label) . ':</strong> ';
                        echo '<code id="' . esc_attr($fid) . '" style="user-select:all">' . esc_html($value) . '</code> ';
                        echo '<button type="button" onclick="navigator.clipboard.writeText(document.getElementById(\'' . esc_js($fid) . '\').textContent)" class="button button-small" style="margin-left:6px">' . esc_html__('Kopyala', 'jetlisans') . '</button>';
                        echo '</div>';
                    }
                    echo '</div>';
                } elseif ($is_account) {
                    // Hesap ürünü ama alan yok (ör. şema sonradan düzenlendi) — düz-key dalına DÜŞME.
                    echo '<em>' . esc_html__('Teslimat hazırlanıyor.', 'jetlisans') . '</em>';
                } else {
                    $payload = isset($d['payload']) ? $d['payload'] : '';
                    $id = 'jl-key-' . intval($i);
                    echo '<code id="' . esc_attr($id) . '" style="user-select:all">' . esc_html($payload) . '</code> ';
                    echo '<button type="button" onclick="navigator.clipboard.writeText(document.getElementById(\'' . esc_js($id) . '\').textContent)" class="button" style="margin-left:8px">' . esc_html__('Kopyala', 'jetlisans') . '</button>';
                }
                if (!empty($d['validUntil'])) {
                    echo '<br><small>' . esc_html__('Geçerlilik:', 'jetlisans') . ' ' . esc_html(self::format_date($d['validUntil'])) . '</small>';
                }
                echo '</td></tr>';
            }
            echo '</tbody></table>';
        }
        echo '</section>';
    }

    /** ISO 8601 → WP yerelleştirilmiş tarih (ham ISO string müşteriye gösterilmez). */
    public static function format_date($iso) {
        $ts = strtotime((string) $iso);
        if (!$ts) return (string) $iso;
        return date_i18n(get_option('date_format') . ' H:i', $ts);
    }

    private function status_message($status) {
        switch ($status) {
            case 'pending':   return __('Siparişiniz hazırlanıyor, stok bekleniyor.', 'jetlisans');
            case 'partial':   return __('Siparişinizin bir kısmı teslim edildi, kalanı hazırlanıyor.', 'jetlisans');
            case 'revoked':   return __('Bu sipariş iade/iptal edildi.', 'jetlisans');
            default:          return __('Teslimat bilgisi yükleniyor.', 'jetlisans');
        }
    }
}
