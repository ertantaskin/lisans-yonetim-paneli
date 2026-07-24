<?php
if (!defined('ABSPATH')) exit;

/**
 * (#33) Sipariş listesi (shop_order) panel-durum kolonu + toplu-aksiyon.
 *
 * Kolon: order meta `_jetlisans_panel_status` (+ fulfilled/total) okunup gösterilir.
 * Toplu-aksiyon "Jetlisans: panel durumunu güncelle": seçili siparişler için
 *   POST /v1/orders/bulk-status { remoteOrderIds: [...] }  (HMAC imzalı)
 * çağrılır; dönen [{ remoteOrderId, status, fulfilled, total }] her siparişin
 * meta'sına yazılır (kolon bunu okur). Payload/sır GÖSTERİLMEZ — yalnız durum sayaçları.
 *
 * Klasik (posts) + HPOS (custom orders table) list table'larının ikisi de desteklenir.
 */
class Jetlisans_Order_List {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Klasik posts tablosu (shop_order).
        add_filter('manage_edit-shop_order_columns', [$this, 'add_column']);
        add_action('manage_shop_order_posts_custom_column', [$this, 'render_column_classic'], 10, 2);
        add_filter('bulk_actions-edit-shop_order', [$this, 'add_bulk_action']);
        add_filter('handle_bulk_actions-edit-shop_order', [$this, 'handle_bulk'], 10, 3);

        // HPOS (custom orders table).
        add_filter('woocommerce_shop_order_list_table_columns', [$this, 'add_column']);
        add_action('woocommerce_shop_order_list_table_custom_column', [$this, 'render_column_hpos'], 10, 2);
        add_filter('bulk_actions-woocommerce_page_wc-orders', [$this, 'add_bulk_action']);
        add_filter('handle_bulk_actions-woocommerce_page_wc-orders', [$this, 'handle_bulk'], 10, 3);

        add_action('admin_notices', [$this, 'bulk_notice']);
    }

    /** Panel Durumu kolonunu (varsa) sipariş durumundan hemen sonra ekler. */
    public function add_column($columns) {
        $new = [];
        foreach ($columns as $key => $label) {
            $new[$key] = $label;
            if ($key === 'order_status') {
                $new['jetlisans_panel_status'] = __('Panel Durumu', 'jetlisans');
            }
        }
        if (!isset($new['jetlisans_panel_status'])) {
            $new['jetlisans_panel_status'] = __('Panel Durumu', 'jetlisans');
        }
        return $new;
    }

    /** Klasik render: ($column, $post_id). */
    public function render_column_classic($column, $post_id) {
        if ($column !== 'jetlisans_panel_status') return;
        $order = wc_get_order($post_id);
        if ($order) $this->render_cell($order);
    }

    /** HPOS render: ($column, $order). */
    public function render_column_hpos($column, $order) {
        if ($column !== 'jetlisans_panel_status') return;
        $this->render_cell($order);
    }

    /** Hücre içeriği — yalnız durum + teslim sayacı (payload YOK). */
    private function render_cell($order) {
        if (!is_a($order, 'WC_Order')) return;
        // Panel-poll meta'sı (`_jetlisans_panel_status`) YALNIZ manuel toplu-poll ile yazılır ve
        // teslim sayaçlarını (fulfilled/total) taşır. Ancak gerçek-zamanlı geri-kanal webhook'lar
        // `_jetlisans_status`'a yazar → poll'suz kolon bayat kalırdı. Poll verisini TERCİH et,
        // yoksa webhook-güdümlü `_jetlisans_status`'a düş (metabox uzlaştırmasını aynalar).
        $panel_status = $order->get_meta('_jetlisans_panel_status');
        $has_poll = !($panel_status === '' || $panel_status === null);
        $status = $has_poll ? $panel_status : $order->get_meta('_jetlisans_status');
        if ($status === '' || $status === null) {
            // Henüz sorgulanmadı ve webhook durumu da yok; panele iletilip iletilmediğini göster.
            $pushed = $order->get_meta('_jetlisans_pushed') === 'yes';
            echo $pushed
                ? '<span style="color:#888">' . esc_html__('sorgulanmadı', 'jetlisans') . '</span>'
                : '<span style="color:#bbb">&mdash;</span>';
            return;
        }
        echo '<span>' . esc_html(self::status_label($status)) . '</span>';
        // Teslim sayacı YALNIZ panel-poll verisi varken anlamlı (webhook durumu sayaç taşımaz).
        if ($has_poll) {
            $fulfilled = (int) $order->get_meta('_jetlisans_panel_fulfilled');
            $total     = (int) $order->get_meta('_jetlisans_panel_total');
            if ($total > 0) {
                echo ' <small>(' . intval($fulfilled) . '/' . intval($total) . ')</small>';
            }
        }
    }

    /** Panel durum kodu → sade Türkçe etiket. */
    private static function status_label($status) {
        switch ($status) {
            case 'fulfilled': return __('Teslim edildi', 'jetlisans');
            case 'partial':   return __('Kısmi', 'jetlisans');
            case 'pending':   return __('Bekliyor', 'jetlisans');
            case 'revoked':   return __('İptal', 'jetlisans');
            case 'expired':   return __('Süresi doldu', 'jetlisans');
            default:          return (string) $status;
        }
    }

    /** Toplu-aksiyon menüsüne "panel durumunu güncelle" ekle. */
    public function add_bulk_action($actions) {
        $actions['jetlisans_refresh_status'] = __('Jetlisans: panel durumunu güncelle', 'jetlisans');
        return $actions;
    }

    /**
     * Toplu-aksiyon işleyici. Nonce doğrulaması WP list table tarafından (bulk-* referer)
     * bu filtre çağrılmadan önce yapılır; ayrıca yetki kontrolü ekliyoruz.
     * @param string $redirect  Yönlendirme URL'i (query arg ile geri döner).
     * @param string $action    Seçilen bulk aksiyon.
     * @param int[]  $ids        Seçili sipariş id'leri.
     */
    public function handle_bulk($redirect, $action, $ids) {
        if ($action !== 'jetlisans_refresh_status') return $redirect;
        if (!current_user_can('edit_shop_orders') && !current_user_can('manage_woocommerce')) {
            return $redirect;
        }
        if (!Jetlisans_Settings::is_configured()) {
            return add_query_arg('jetlisans_bulk', 'notconfigured', $redirect);
        }

        $ids = array_values(array_filter(array_map('absint', (array) $ids)));
        if (empty($ids)) return $redirect;

        $remote_ids = array_map('strval', $ids);
        $res = Jetlisans_Panel_Client::post('/v1/orders/bulk-status', [
            'remoteOrderIds' => $remote_ids,
        ]);

        $updated = 0;
        $ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        if ($ok && !empty($res['body']) && is_array($res['body'])) {
            // Yanıt düz dizi [{...}] ya da { results: [{...}] } olabilir — ikisini de karşıla.
            $rows = (isset($res['body']['results']) && is_array($res['body']['results']))
                ? $res['body']['results']
                : $res['body'];
            if (is_array($rows)) {
                foreach ($rows as $row) {
                    if (!is_array($row) || empty($row['remoteOrderId'])) continue;
                    $oid = absint($row['remoteOrderId']);
                    $order = $oid ? wc_get_order($oid) : null;
                    if (!$order) continue;
                    $order->update_meta_data('_jetlisans_panel_status',
                        isset($row['status']) ? sanitize_text_field((string) $row['status']) : '');
                    $order->update_meta_data('_jetlisans_panel_fulfilled',
                        isset($row['fulfilled']) ? (int) $row['fulfilled'] : 0);
                    $order->update_meta_data('_jetlisans_panel_total',
                        isset($row['total']) ? (int) $row['total'] : 0);
                    $order->save();
                    $updated++;
                }
            }
        }

        return add_query_arg([
            'jetlisans_bulk'   => $updated > 0 ? 'ok' : 'error',
            'jetlisans_bulk_n' => $updated,
        ], $redirect);
    }

    /** Toplu-aksiyon sonrası admin bildirimi. */
    public function bulk_notice() {
        if (!isset($_GET['jetlisans_bulk'])) return;
        $flag = sanitize_key(wp_unslash($_GET['jetlisans_bulk']));
        $n = isset($_GET['jetlisans_bulk_n']) ? absint($_GET['jetlisans_bulk_n']) : 0;
        if ($flag === 'ok') {
            echo '<div class="notice notice-success is-dismissible"><p>' .
                esc_html(sprintf(__('%d siparişin panel durumu güncellendi.', 'jetlisans'), $n)) .
                '</p></div>';
        } elseif ($flag === 'notconfigured') {
            echo '<div class="notice notice-warning is-dismissible"><p>' .
                esc_html__('Jetlisans paneli yapılandırılmadığı için panel durumu güncellenemedi.', 'jetlisans') .
                '</p></div>';
        } elseif ($flag === 'error') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html__('Panel durumu güncellenemedi. Lütfen daha sonra tekrar deneyin.', 'jetlisans') .
                '</p></div>';
        }
    }
}
