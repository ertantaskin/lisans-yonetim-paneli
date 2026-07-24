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
        // (§7 "no-store — key cache'lenmez") Sipariş-görüntüle uçları çözülmüş lisans
        // anahtarı içerebilir → sayfa önbelleğe/CDN'e alınmasın. template_redirect ÇIKTI
        // başlamadan çalışır → nocache_headers() gerçekten header yazabilir; DONOTCACHEPAGE
        // erkenden tanımlanır (page-cache eklentileri bunu kontrol eder).
        add_action('template_redirect', [$this, 'nocache_account']);
    }

    /** Sipariş-görüntüle hesap uçlarında sayfa-cache/CDN önbelleklemesini kapatır (§7). */
    public function nocache_account() {
        if (!function_exists('is_wc_endpoint_url')) return;
        if (is_wc_endpoint_url('view-order') || is_wc_endpoint_url('order-received')) {
            if (!defined('DONOTCACHEPAGE')) {
                define('DONOTCACHEPAGE', true);
            }
            nocache_headers();
        }
    }

    public function render($order) {
        if (!is_a($order, 'WC_Order')) return;
        $panel_order_id = $order->get_meta('_jetlisans_order_id');
        if (!$panel_order_id) return;

        $res = Jetlisans_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries');
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $deliveries = (isset($body['deliveries']) && is_array($body['deliveries'])) ? $body['deliveries'] : [];

        // (§8 held staleness) Panel artık YETKİLİ `held` bayrağını /deliveries yanıtında döndürür.
        // Fetch başarılı (2xx) VE bayrak mevcutsa authoritative (bool); aksi halde $panel_held=null
        // ("bilinmiyor" → graceful fallback, aşağıda temizleme/banner kararlarında). Panel held=false
        // dediyse (teslimat durumu ne olursa olsun) bayat _jetlisans_held_for_review işaretini kalıcı
        // temizle — stoksuz onaylanan held sipariş 'pending'+held=false'ta kalıp banner'ı asılı bırakmasın.
        $fetch_ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        $panel_held = ($fetch_ok && array_key_exists('held', $body)) ? (bool) $body['held'] : null;
        if ($panel_held === false) {
            self::clear_held($order);
        }

        echo '<section class="jetlisans-deliveries" style="margin-top:24px">';
        echo '<h2>' . esc_html__('Lisans Teslimatınız', 'jetlisans') . '</h2>';
        // Sorun Bildir işlem sonucu bildirimi (varsa).
        Jetlisans_Report_Issue::render_notice();

        // (#32) Teslimat e-postası ulaşmadıysa (failed/bounced) bilgilendirici bant. Sır/sızıntı
        // içermez — müşteriye lisansın bu sayfada görünür olduğunu ve destek yolunu söyler.
        $mail_status = isset($body['mailStatus']) ? (string) $body['mailStatus'] : '';
        if (in_array($mail_status, ['failed', 'bounced'], true)) {
            echo '<div class="woocommerce-info" role="alert" style="margin-bottom:12px">' .
                esc_html__('Teslimat e-postanız size ulaşmamış olabilir. Lisans bilgilerinizi bu sayfadan görüntüleyebilirsiniz; sorun yaşarsanız destek ekibimizle iletişime geçin.', 'jetlisans') .
                '</div>';
        }

        if (empty($deliveries)) {
            $status = isset($body['status']) ? $body['status'] : '';
            // (§8 dinamik satış kotası / İnceleme Kuyruğu) Panel TERMİNAL/teslim durumu bildirdiyse
            // (fulfilled/partial/revoked) inceleme sonuçlanmıştır → bayat _jetlisans_held_for_review
            // işaretini kalıcı temizle (held=false sinyali gelmese bile). "güvenlik incelemesinde"
            // bildirimi bir daha çıkmaz.
            if (in_array($status, ['fulfilled', 'partial', 'revoked'], true)) {
                self::clear_held($order);
            }
            // (§8) İnceleme bandını YALNIZ: yerel held işareti VAR + panel HÂLÂ held=true DİYOR,
            // VEYA (held sinyali yok ama durum 'pending' — eski panel / graceful fallback) göster.
            // Panel held=false dediyse yukarıda temizlendi → $held_local zaten false → banner çıkmaz.
            // Fetch başarısızsa ($panel_held=null, $status='') banner çıkmaz, temizlik de yapılmaz
            // (aşağıdaki genel "yükleniyor" mesajına düşer — biten/reddedilen siparişte asılı kalmaz).
            $held_local = ($order->get_meta('_jetlisans_held_for_review') === 'yes');
            $show_review = $held_local && (
                $panel_held === true ||
                ($panel_held === null && $status === 'pending')
            );
            if ($show_review) {
                echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                    esc_html__('Siparişiniz güvenlik incelemesindedir. Onaylandığında lisansınız burada görünecek ve e-posta ile bildirilecektir.', 'jetlisans') .
                    '</div>';
            } else {
                echo '<p>' . esc_html($this->status_message($status)) . '</p>';
            }
        } else {
            // Teslimat geldi → inceleme sonuçlandı; bayat held işaretini temizle (idempotent).
            self::clear_held($order);
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
                    $exp = !empty($d['expired']);
                    echo '<br><small' . ($exp ? ' style="color:#b45309"' : '') . '>';
                    echo esc_html($exp ? __('Süresi doldu:', 'jetlisans') : __('Geçerlilik:', 'jetlisans'));
                    echo ' ' . esc_html(self::format_date($d['validUntil'])) . '</small>';
                }
                // Bu kalem için "Sorun Bildir" — assignmentId panelin opak referansı (varsa).
                $assignment_id = isset($d['assignmentId']) ? $d['assignmentId'] : (isset($d['id']) ? $d['id'] : '');
                Jetlisans_Report_Issue::render_button($order, $assignment_id);
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

    /**
     * (§8 İnceleme Kuyruğu) held işaretini idempotent temizler — yalnız 'yes' iken yazar; hiç
     * held olmamış sipariş no-op (gereksiz save yok). WC order meta API (HPOS + klasik postmeta
     * uyumlu); silme in-memory'de de anında etkir → aynı istekte get_meta artık '' döner.
     */
    private static function clear_held($order) {
        if ($order->get_meta('_jetlisans_held_for_review') === 'yes') {
            $order->delete_meta_data('_jetlisans_held_for_review');
            $order->save();
        }
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
