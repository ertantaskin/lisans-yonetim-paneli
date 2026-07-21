<?php
if (!defined('ABSPATH')) exit;

/**
 * Panel geri kanal webhook alıcısı (§2). HMAC doğrular, order meta'yı günceller.
 * Bayat webhook (bozuk imza / zaman penceresi dışı) reddedilir.
 */
class Jetlisans_Webhook {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('rest_api_init', [$this, 'register']);
    }

    public function register() {
        register_rest_route('jetlisans/v1', '/webhook', [
            'methods'             => 'POST',
            'callback'            => [$this, 'handle'],
            'permission_callback' => '__return_true', // imza ile korunur
        ]);
    }

    public function handle(WP_REST_Request $request) {
        $raw = $request->get_body();
        $ts = $request->get_header('x-timestamp');
        $nonce = $request->get_header('x-nonce');
        $sig = $request->get_header('x-signature');
        $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

        if (!Jetlisans_Panel_Client::verify_webhook('POST', $path, $ts, $nonce, $raw, $sig)) {
            return new WP_REST_Response(['error' => 'invalid_signature'], 401);
        }

        // Nonce replay koruması (§4): imza DOĞRULANDIKTAN sonra, aksiyon almadan ÖNCE
        // nonce'u harca. Zaman penceresi ±300sn olduğundan replay [T−300, T+300] aralığında
        // olabilir → transient TTL bunu güvenle kapsayacak şekilde 600sn (tolerans+pay).
        // Aynı nonce ikinci kez gelirse (replay) aksiyon TEKRARLANMAZ → no-op 200.
        $nonce_key = 'jl_wh_' . md5((string) $nonce);
        if (get_transient($nonce_key)) {
            return new WP_REST_Response(['ok' => true, 'duplicate' => true], 200);
        }
        set_transient($nonce_key, 1, 600);

        $body = json_decode($raw, true);
        if (!is_array($body) || empty($body['remoteOrderId'])) {
            return new WP_REST_Response(['error' => 'bad_request'], 400);
        }

        $order = wc_get_order((int) $body['remoteOrderId']);
        if ($order) {
            // Monoton sıra kontrolü (§2/§7 "bayat webhook yok sayılır"): panel her olaya artan
            // bir seq (outbox oluşturma epoch-ms) koyar. Retry sırayı bozup daha ESKİ bir olayı
            // (ör. 'partial') daha yeni olandan ('fulfilled') SONRA ulaştırırsa, seq son-uygulanan
            // değerden küçük/eşittir → güncel durumu GERİ yazma (no-op). seq yoksa (eski panel) 0
            // → koşul devre dışı, eski davranış korunur (geriye dönük uyumlu).
            $seq = isset($body['seq']) ? (int) $body['seq'] : 0;
            $last_seq = (int) $order->get_meta('_jetlisans_seq');
            if ($seq > 0 && $seq <= $last_seq) {
                return new WP_REST_Response(['ok' => true, 'stale' => true], 200);
            }

            $status = isset($body['status']) ? sanitize_text_field($body['status']) : '';
            if ($status) {
                $order->update_meta_data('_jetlisans_status', $status);
            }
            if ($seq > 0) {
                $order->update_meta_data('_jetlisans_seq', $seq);
            }
            if ($status || $seq > 0) {
                $order->save();
            }
            $event = isset($body['event']) ? sanitize_text_field($body['event']) : 'update';
            $order->add_order_note(sprintf('Jetlisans: %s (durum: %s)', $event, $status));
        }

        return new WP_REST_Response(['ok' => true], 200);
    }
}
