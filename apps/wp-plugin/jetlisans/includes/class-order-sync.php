<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş senkronu (§2, §7): Woo siparişi processing/completed olunca panele push.
 * Panel atomik atama yapar; assignment referansı order meta'ya yazılır.
 * Lisans verisi WP'de TUTULMAZ.
 */
class Jetlisans_Order_Sync {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('woocommerce_order_status_processing', [$this, 'push'], 10, 1);
        add_action('woocommerce_order_status_completed', [$this, 'push'], 10, 1);
        // Retry (Action Scheduler yoksa wp-cron).
        add_action('jetlisans_retry_push', [$this, 'push'], 10, 1);
    }

    public function push($order_id) {
        if (!Jetlisans_Settings::is_configured()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Idempotency: bir kez push (panel de site+order ile idempotent).
        if ($order->get_meta('_jetlisans_pushed') === 'yes') return;

        $lines = [];
        foreach ($order->get_items() as $item_id => $item) {
            $product = $item->get_product();
            if (!$product) continue;
            $lines[] = [
                'remoteLineId'      => (string) $item_id,
                'remoteProductId'   => (string) ($product->get_parent_id() ?: $product->get_id()),
                'remoteVariationId' => $product->is_type('variation') ? (string) $product->get_id() : null,
                'qty'               => (int) $item->get_quantity(),
            ];
        }
        if (empty($lines)) return;

        $body = [
            'remoteOrderId' => (string) $order_id,
            'customerEmail' => $order->get_billing_email(),
            'lines'         => $lines,
        ];

        $res = Jetlisans_Panel_Client::post('/v1/orders', $body);
        $this->log($order_id, 'push', $body, $res);

        // 201 tam / 207 kısmi / 202 pending — hepsi başarılı bildirim.
        if (in_array($res['code'], [200, 201, 202, 207], true)) {
            $order->update_meta_data('_jetlisans_pushed', 'yes');
            if (!empty($res['body']['orderId'])) {
                $order->update_meta_data('_jetlisans_order_id', $res['body']['orderId']);
            }
            if (!empty($res['body']['status'])) {
                $order->update_meta_data('_jetlisans_status', $res['body']['status']);
            }
            $order->save();
        } else {
            // Başarısız → retry planla (§4 eklenti 1dk/5dk/30dk).
            $this->schedule_retry($order_id);
        }
    }

    private function schedule_retry($order_id) {
        if (function_exists('as_schedule_single_action')) {
            as_schedule_single_action(time() + 300, 'jetlisans_retry_push', [$order_id], 'jetlisans');
        } else {
            wp_schedule_single_event(time() + 300, 'jetlisans_retry_push', [$order_id]);
        }
    }

    private function log($order_id, $direction, $payload, $response) {
        global $wpdb;
        $wpdb->insert($wpdb->prefix . 'jetlisans_queue', [
            'order_id'  => $order_id,
            'direction' => $direction,
            'status'    => isset($response['code']) && $response['code'] >= 200 && $response['code'] < 300 ? 'ok' : 'error',
            'payload'   => wp_json_encode($payload),
            'response'  => wp_json_encode($response),
        ]);
    }
}
