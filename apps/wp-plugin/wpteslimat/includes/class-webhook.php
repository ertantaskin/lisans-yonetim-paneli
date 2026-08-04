<?php
if (!defined('ABSPATH')) exit;

/**
 * Panel geri kanal webhook alıcısı (§2). HMAC doğrular, order meta'yı günceller.
 * Bayat webhook (bozuk imza / zaman penceresi dışı) reddedilir.
 */
class Wpteslimat_Webhook {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('rest_api_init', [$this, 'register']);
    }

    public function register() {
        $args = [
            'methods'             => 'POST',
            'callback'            => [$this, 'handle'],
            'permission_callback' => '__return_true', // imza ile korunur
        ];
        register_rest_route('wpteslimat/v1', '/webhook', $args);
        // Geriye dönük uyum (yeniden adlandırma): eski kurulumlarda panelde kayıtlı
        // webhook_url önceki REST ad-alanını (…/wp-json/jetlisans/v1/webhook) gösterebilir.
        // Eklenti güncellenince o rota 404 vermesin diye eski ad-alanını da AYNI işleyiciye
        // bağla. İmza yolu handle() içinde REQUEST_URI'den okunur (kanonikleştirilir) →
        // panel hangi URL'i imzaladıysa doğrulama yine tutar.
        register_rest_route('jetlisans/v1', '/webhook', $args);
    }

    public function handle(WP_REST_Request $request) {
        // (#12) Yapılandırılmamış sitede HMAC secret boş ('') olur; boş anahtar herkesçe
        // bilinir → sahte webhook imzası geçebilir. verify_webhook() de boş secret'ı reddeder
        // (savunma katmanı); burada erken 401 ile hiç işleme almadan reddet (no-op).
        if (!Wpteslimat_Settings::is_configured()) {
            return new WP_REST_Response(['error' => 'not_configured'], 401);
        }
        $raw = $request->get_body();
        $ts = $request->get_header('x-timestamp');
        $nonce = $request->get_header('x-nonce');
        $sig = $request->get_header('x-signature');
        $path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

        if (!Wpteslimat_Panel_Client::verify_webhook('POST', $path, $ts, $nonce, $raw, $sig)) {
            return new WP_REST_Response(['error' => 'invalid_signature'], 401);
        }

        // Nonce replay koruması (§4): imza DOĞRULANDIKTAN sonra, aksiyon almadan ÖNCE
        // nonce'u harca. Zaman penceresi ±300sn olduğundan replay [T−300, T+300] aralığında
        // olabilir. TTL TAM 2×tolerans (600) olursa saat kayması + saniye-altı zamanlamayla
        // transient tam expiry anına denk gelen bir replay penceresi kalır → paylaşılan sözleşme
        // (packages/shared HMAC_NONCE_TTL_SEC = 2×300+60 = 660) marj ekler; WP tarafını da hizala.
        // Aynı nonce ikinci kez gelirse (replay) aksiyon TEKRARLANMAZ → no-op 200.
        $nonce_key = 'jl_wh_' . md5((string) $nonce);
        if (get_transient($nonce_key)) {
            return new WP_REST_Response(['ok' => true, 'duplicate' => true], 200);
        }
        set_transient($nonce_key, 1, 660);

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
            // (#9) seq epoch-MİLİSANİYE (~1.7e12); (int) cast 32-bit PHP'de PHP_INT_MAX'e
            // doygunlaşır → ilk webhook'tan sonra HEPSİ "stale" sanılır. float ile karşılaştır +
            // string olarak sakla (epoch-ms < 2^53 → float tam sayısaldır; 64-bit bozulmaz).
            $seq = isset($body['seq']) ? (float) $body['seq'] : 0.0;
            $last_seq = (float) $order->get_meta('_wpteslimat_seq');
            if ($seq > 0 && $seq <= $last_seq) {
                return new WP_REST_Response(['ok' => true, 'stale' => true], 200);
            }

            $status = isset($body['status']) ? sanitize_text_field($body['status']) : '';
            if ($status) {
                $order->update_meta_data('_wpteslimat_status', $status);
                // (Denetim) Sipariş listesi panel-durum FİLTRESİ `_wpteslimat_panel_status`'ı sorgular;
                // bu meta normalde yalnız manuel toplu-poll ile yazılır. Webhook durumunu da aynı meta'ya
                // aynala → geri-kanal ile teslim edilen (hiç poll edilmemiş) siparişler de filtrede görünür
                // (aksi halde kolon "Teslim edildi" derken filtre onları eler = yanıltıcı eksik sonuç).
                $order->update_meta_data('_wpteslimat_panel_status', $status);
                // (#6) Webhook teslim SAYACI taşımaz; eski manuel-poll'dan kalan fulfilled/total
                // meta'ları `_wpteslimat_panel_status` yazılırken SİL → sipariş listesi kolonu
                // "Teslim edildi (2/5)" gibi çelişkili bayat sayaç göstermesin (sayaç meta'sı
                // yoksa kolon zaten hiç göstermez).
                $order->delete_meta_data('_wpteslimat_panel_fulfilled');
                $order->delete_meta_data('_wpteslimat_panel_total');
                // (§8 İnceleme Kuyruğu) Panel geri-kanal bir TERMİNAL/teslim durumu bildirdiyse
                // (order.fulfilled/partially_fulfilled → fulfilled/partial, ya da revoked) inceleme
                // SONUÇLANMIŞ demektir (held sipariş yalnız release SONRASI webhook üretir). Bayat
                // "güvenlik incelemesinde" bildirimini kalıcı düşürmek için held işaretini temizle.
                // İdempotent: işaret yoksa/zaten boşsa no-op. _wpteslimat_status güncellemesini aynadan
                // izler → aşağıdaki mevcut $order->save() ($status doğru olduğu için) silmeyi kalıcılar.
                if (in_array($status, ['fulfilled', 'partial', 'revoked'], true)
                    && $order->get_meta('_wpteslimat_held_for_review') === 'yes') {
                    $order->delete_meta_data('_wpteslimat_held_for_review');
                }
            }
            if ($seq > 0) {
                // (#9) 32-bit güvenli: seq'i tam sayı STRING olarak sakla (float→bilimsel
                // gösterim/taşma yok; okurken (float) cast ile karşılaştırılır).
                $order->update_meta_data('_wpteslimat_seq', sprintf('%.0f', $seq));
            }
            if ($status || $seq > 0) {
                $order->save();
            }
            $event = isset($body['event']) ? sanitize_text_field($body['event']) : 'update';
            $order->add_order_note(self::human_note($event, $status));
        }

        return new WP_REST_Response(['ok' => true], 200);
    }

    /**
     * Panel geri-kanal olayını müşteri/operatör dostu Türkçe sipariş notuna çevirir.
     * Ham event adı (`order.fulfilled`) veya durum enum'u (`fulfilled`) NOTA SIZMAZ — operatör
     * ne olduğunu düz Türkçeyle görür. Durum önceliklidir (daha güvenilir); yoksa event'e düşer.
     */
    private static function human_note($event, $status) {
        switch ($status) {
            case 'fulfilled':
                return __('Teslimat tamamlandı — tüm lisanslar müşteriye iletildi.', 'wpteslimat');
            case 'partial':
                return __('Kısmi teslimat — bazı lisanslar henüz beklemede; stok geldiğinde otomatik tamamlanır.', 'wpteslimat');
            case 'revoked':
                return __('Lisanslar iptal/iade edildi — teslim edilen anahtarlar geri alındı.', 'wpteslimat');
            case 'held':
                return __('Sipariş güvenlik incelemesine alındı — teslimat yönetici onayından sonra tamamlanacak.', 'wpteslimat');
            case 'pending':
                return __('Teslimat bekliyor — lisanslar hazırlanıyor.', 'wpteslimat');
        }
        // Bilinmeyen/boş durum: event'e göre kaba ifade, ama ham teknik adı gösterme.
        if ($event === 'order.fulfilled') {
            return __('Teslimat tamamlandı.', 'wpteslimat');
        }
        if (strpos((string) $event, 'partial') !== false) {
            return __('Kısmi teslimat güncellemesi alındı.', 'wpteslimat');
        }
        return __('Panelden teslimat durumu güncellendi.', 'wpteslimat');
    }
}
