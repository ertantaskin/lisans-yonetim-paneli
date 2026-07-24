<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş senkronu (§2, §7): Woo siparişi processing/completed olunca panele push.
 * Panel atomik atama yapar; assignment referansı order meta'ya yazılır.
 * Lisans verisi WP'de TUTULMAZ.
 */
class Jetlisans_Order_Sync {
    private static $instance = null;
    /** Re-entrancy guard: resync sırasındaki save() zinciri kendini tetiklemesin (#16). */
    private static $syncing = false;
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
        // (#16) Sipariş kalemleri düzenlenip kaydedilince (yalnız item değişimi) — daha önce
        // panele iletilmiş siparişi güncel adetlerle yeniden uzlaştır. Guard sonsuz döngüyü keser.
        add_action('woocommerce_saved_order_items', [$this, 'resync_items'], 20, 2);
        // Retry (Action Scheduler yoksa wp-cron).
        add_action('jetlisans_retry_push', [$this, 'push'], 10, 1);
        add_action('jetlisans_retry_revoke', [$this, 'revoke'], 10, 1);
    }

    public function push($order_id) {
        if (!Jetlisans_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): site adresi bağlanma anındakinden farklıysa CANLI
        // panele push etme (klon ortamı gerçek stoğu tüketmesin). Admin'e uyarı gösterilir.
        if (Jetlisans_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Idempotency: bir kez push (panel de site+order ile idempotent).
        if ($order->get_meta('_jetlisans_pushed') === 'yes') return;

        $lines = $this->collect_lines($order);
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
            // (§8 dinamik satış kotası) Panel siparişi KABUL etti ama dinamik kota eşiği
            // aşıldığından teslimatı yönetici incelemesine aldı (202 + body.held=true). Sipariş
            // pending kalır; yönetici onaylarsa normal teslimat + geri-kanal webhook devam eder,
            // reddederse revoked olur (bulk-status poll'de görünür). Sadece EK işaret: held yok/
            // false ise bugünküyle birebir aynı davranış (geriye dönük uyumlu).
            if (!empty($res['body']['held']) && $order->get_meta('_jetlisans_held_for_review') !== 'yes') {
                $order->update_meta_data('_jetlisans_held_for_review', 'yes');
                $order->add_order_note('Jetlisans: Sipariş güvenlik incelemesine alındı — teslimat yönetici onayından sonra tamamlanacak.');
            }
            $order->save();
        } else {
            // Başarısız → retry planla (§4 eklenti 1dk/5dk/30dk).
            $this->schedule_retry($order_id);
        }
    }

    /**
     * Güncel sipariş kalemlerinden panel satırlarını üretir (push + resync ortak).
     * Varyasyon id yalnız varyasyonlu üründe gönderilir (panel string bekler).
     */
    private function collect_lines($order) {
        $lines = [];
        foreach ($order->get_items() as $item_id => $item) {
            $product = $item->get_product();
            if (!$product) continue;
            $line = [
                'remoteLineId'    => (string) $item_id,
                'remoteProductId' => (string) ($product->get_parent_id() ?: $product->get_id()),
                'qty'             => (int) $item->get_quantity(),
            ];
            if ($product->is_type('variation')) {
                $line['remoteVariationId'] = (string) $product->get_id();
            }
            $lines[] = $line;
        }
        return $lines;
    }

    /**
     * (#16) Sipariş kalemleri düzenlenip kaydedilince yeniden uzlaştırır. Yalnız DAHA ÖNCE
     * panele iletilmiş sipariş (_jetlisans_pushed=yes) için çalışır; güncel adetlerle mevcut
     * POST /v1/orders akışını AYNI idempotency anahtarıyla (site+remoteOrder+remoteLine) yeniden
     * çağırır — adet değişimini panel uzlaştırır. Re-entrancy guard sonsuz döngüyü engeller.
     *
     * `woocommerce_saved_order_items` hook'u YALNIZ kalem değişiminde ateşlenir; ayrıca
     * içerideki $order->save() zinciri guard ile kendini yeniden tetikleyemez.
     */
    public function resync_items($order_id, $items = null) {
        if (self::$syncing) return;
        if (!Jetlisans_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): klon ortamda uzlaştırma push'u yapma.
        if (Jetlisans_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Panele hiç iletilmemiş sipariş → uzlaştırılacak atama yok (ilk push status geçişinde olur).
        if ($order->get_meta('_jetlisans_pushed') !== 'yes') return;

        $lines = $this->collect_lines($order);
        if (empty($lines)) return;

        $body = [
            'remoteOrderId' => (string) $order_id,
            'customerEmail' => $order->get_billing_email(),
            'lines'         => $lines,
        ];

        self::$syncing = true;
        $res = Jetlisans_Panel_Client::post('/v1/orders', $body);
        $this->log($order_id, 'resync', $body, $res);

        // 200/201/207/202 → panel güncel adetlerle uzlaştı; durum meta'sını tazele.
        if (in_array($res['code'], [200, 201, 202, 207], true)) {
            if (!empty($res['body']['status'])) {
                $order->update_meta_data('_jetlisans_status', $res['body']['status']);
                $order->save();
            }
        }
        self::$syncing = false;
    }

    /**
     * İade/iptal olan siparişin panel-tarafı lisanslarını geri alır (§2). Yalnız panele
     * push edilmiş siparişler için anlamlı (atama var). İdempotent: panel zaten revoked
     * ise no-op; bir kez işaretlenir. Lisans verisi WP'de tutulmadığından yalnız tetikler.
     */
    public function revoke($order_id) {
        if (!Jetlisans_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): klon ortamda CANLI panele revoke GÖNDERME. Klon aynı
        // api_key+hmac_secret VE `_jetlisans_pushed` meta'sını miras alır → is_clone() true olsa
        // bile revoke aksi halde CANLI panele giderdi; staging'de iade/iptal edilen sipariş GERÇEK
        // müşterinin prod lisanslarını geri alırdı. push/resync ile aynı guard; retry hook
        // (jetlisans_retry_revoke) da bu metottan geçtiği için otomatik kapsanır.
        if (Jetlisans_Settings::is_clone()) return;
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
            // (§8 held staleness) Terminal durumu yerel meta'ya yansıt (manuel poll beklemeden):
            // iade/iptal edilen sipariş 'revoked'dır ve varsa "İnceleme bekliyor" işareti artık
            // geçersizdir → idempotent temizle. Aksi halde refund edilen bir held siparişin bayat
            // held meta'sı my-account/metabox'ta asılı kalırdı.
            $order->update_meta_data('_jetlisans_status', 'revoked');
            if ($order->get_meta('_jetlisans_held_for_review') === 'yes') {
                $order->delete_meta_data('_jetlisans_held_for_review');
            }
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
