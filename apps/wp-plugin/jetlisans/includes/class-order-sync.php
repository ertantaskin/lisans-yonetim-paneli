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
        // İade/iptal → panelde lisansı geri al (§2: iade edilen key satışta CANLI kalmaz).
        add_action('woocommerce_order_status_refunded', [$this, 'revoke'], 10, 1);
        add_action('woocommerce_order_status_cancelled', [$this, 'revoke'], 10, 1);
        // Retry (Action Scheduler yoksa wp-cron).
        add_action('jetlisans_retry_push', [$this, 'push'], 10, 1);
        add_action('jetlisans_retry_revoke', [$this, 'revoke'], 10, 1);
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
            $line = [
                'remoteLineId'    => (string) $item_id,
                'remoteProductId' => (string) ($product->get_parent_id() ?: $product->get_id()),
                'qty'             => (int) $item->get_quantity(),
            ];
            // Yalnız varyasyonlu üründe gönder — null gönderme (panel string bekler).
            if ($product->is_type('variation')) {
                $line['remoteVariationId'] = (string) $product->get_id();
            }
            $lines[] = $line;
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

    /**
     * İade/iptal olan siparişin panel-tarafı lisanslarını geri alır (§2). Yalnız panele
     * push edilmiş siparişler için anlamlı (atama var). İdempotent: panel zaten revoked
     * ise no-op; bir kez işaretlenir. Lisans verisi WP'de tutulmadığından yalnız tetikler.
     */
    public function revoke($order_id) {
        if (!Jetlisans_Settings::is_configured()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Panele hiç gitmemiş sipariş → geri alınacak atama yok.
        if ($order->get_meta('_jetlisans_pushed') !== 'yes') return;
        // İdempotency: bir kez revoke (panel de order üzerinden idempotent).
        if ($order->get_meta('_jetlisans_revoked') === 'yes') return;

        $reason = 'WooCommerce: ' . $order->get_status();
        $body = ['reason' => $reason];
        $res = Jetlisans_Panel_Client::post(
            '/v1/orders/' . rawurlencode((string) $order_id) . '/revoke',
            $body
        );
        $this->log($order_id, 'revoke', $body, $res);

        // 200 → geri alındı; 404 → panelde sipariş yok (zaten temiz). İkisi de idempotent tamam.
        if (in_array($res['code'], [200, 404], true)) {
            $order->update_meta_data('_jetlisans_revoked', 'yes');
            $count = isset($res['body']['revoked']) ? (int) $res['body']['revoked'] : 0;
            $order->add_order_note(sprintf('Jetlisans: %d lisans geri alındı (%s).', $count, $reason));
            $order->save();
        } else {
            // Başarısız → retry planla.
            $this->schedule_revoke_retry($order_id);
        }
    }

    private function schedule_retry($order_id) {
        if (function_exists('as_schedule_single_action')) {
            as_schedule_single_action(time() + 300, 'jetlisans_retry_push', [$order_id], 'jetlisans');
        } else {
            wp_schedule_single_event(time() + 300, 'jetlisans_retry_push', [$order_id]);
        }
    }

    private function schedule_revoke_retry($order_id) {
        if (function_exists('as_schedule_single_action')) {
            as_schedule_single_action(time() + 300, 'jetlisans_retry_revoke', [$order_id], 'jetlisans');
        } else {
            wp_schedule_single_event(time() + 300, 'jetlisans_retry_revoke', [$order_id]);
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
