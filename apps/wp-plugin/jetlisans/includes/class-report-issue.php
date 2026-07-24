<?php
if (!defined('ABSPATH')) exit;

/**
 * "Sorun Bildir" akışı (§13 — self-servis / destek).
 * My Account teslimat bloğundaki her lisans kalemi için müşteri kısa bir açıklama
 * ile sorun bildirir → eklentinin MEVCUT HMAC istemcisiyle panele
 *   POST /v1/replacements { remoteOrderId, reason, assignmentId? }
 * gönderilir. Panel değişim/garanti talebi kaydı açar. Lisans verisi WP'de TUTULMAZ.
 *
 * Form gönderimi admin-post.php üzerinden (nonce'lu, CSRF korumalı); işlem sonrası
 * müşteri sipariş görünümüne geri yönlendirilir ve sade Türkçe geri bildirim gösterilir.
 */
class Jetlisans_Report_Issue {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Müşteri oturumlu (My Account) — nopriv da guest sipariş görünümü için kayıtlı.
        add_action('admin_post_jetlisans_report', [$this, 'handle']);
        add_action('admin_post_nopriv_jetlisans_report', [$this, 'handle']);
    }

    /**
     * Tek teslimat kalemi için "Sorun Bildir" açılır formu (kısa açıklama + gönder).
     * My Account render döngüsünden çağrılır. $assignment_id panelin deliveries
     * yanıtındaki opak referanstır (varsa gönderilir, yoksa atlanır).
     */
    public static function render_button($order, $assignment_id = '') {
        if (!is_a($order, 'WC_Order')) return;
        $order_id = $order->get_id();
        $fid = 'jl-report-' . intval($order_id) . '-' . sanitize_html_class((string) $assignment_id);
        ?>
        <details class="jetlisans-report" style="margin-top:8px">
            <summary style="cursor:pointer;color:#555;font-size:.9em"><?php echo esc_html__('Sorun Bildir', 'jetlisans'); ?></summary>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" style="margin-top:6px">
                <input type="hidden" name="action" value="jetlisans_report">
                <input type="hidden" name="order_id" value="<?php echo esc_attr($order_id); ?>">
                <input type="hidden" name="assignment_id" value="<?php echo esc_attr((string) $assignment_id); ?>">
                <?php wp_nonce_field('jetlisans_report_' . $order_id); ?>
                <label for="<?php echo esc_attr($fid); ?>" style="display:block;font-size:.85em;color:#555;margin-bottom:4px">
                    <?php echo esc_html__('Sorununuzu kısaca açıklayın (ör. lisans çalışmıyor):', 'jetlisans'); ?>
                </label>
                <textarea id="<?php echo esc_attr($fid); ?>" name="reason" rows="3" required minlength="3" maxlength="1000"
                          style="width:100%;max-width:420px" class="input-text"></textarea><br>
                <button type="submit" class="button button-small" style="margin-top:6px"><?php echo esc_html__('Gönder', 'jetlisans'); ?></button>
            </form>
        </details>
        <?php
    }

    /**
     * Sipariş görünümünde işlem sonucu bildirimi (redirect query arg üzerinden).
     * My Account render başında çağrılır.
     */
    public static function render_notice() {
        if (!isset($_GET['jetlisans_report'])) return;
        $r = sanitize_key(wp_unslash($_GET['jetlisans_report']));
        if ($r === 'ok') {
            echo '<div class="woocommerce-message" role="alert">' .
                esc_html__('Talebiniz alındı. Destek ekibimiz en kısa sürede inceleyecek.', 'jetlisans') .
                '</div>';
        } elseif ($r === 'short') {
            echo '<div class="woocommerce-error" role="alert">' .
                esc_html__('Lütfen sorununuzu biraz daha açıklayın (en az 3 karakter).', 'jetlisans') .
                '</div>';
        } elseif ($r === 'error') {
            echo '<div class="woocommerce-error" role="alert">' .
                esc_html__('Talebiniz gönderilemedi. Lütfen daha sonra tekrar deneyin.', 'jetlisans') .
                '</div>';
        }
    }

    /**
     * Form gönderimini işler: nonce + sahiplik doğrula → panele HMAC ile push → geri yönlendir.
     */
    public function handle() {
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;

        // Nonce (CSRF) doğrula — order id'ye bağlı.
        if (!$order_id || !isset($_POST['_wpnonce']) ||
            !wp_verify_nonce(wp_unslash($_POST['_wpnonce']), 'jetlisans_report_' . $order_id)) {
            wp_die(esc_html__('Geçersiz istek.', 'jetlisans'), '', ['response' => 403]);
        }

        $order = wc_get_order($order_id);
        // Sahiplik: müşteri yalnız kendi siparişi için sorun bildirebilir.
        if (!$order || !current_user_can('view_order', $order_id)) {
            wp_die(esc_html__('Bu sipariş için yetkiniz yok.', 'jetlisans'), '', ['response' => 403]);
        }

        $reason = isset($_POST['reason']) ? sanitize_textarea_field(wp_unslash($_POST['reason'])) : '';
        $reason = trim($reason);
        $assignment_id = isset($_POST['assignment_id'])
            ? sanitize_text_field(wp_unslash($_POST['assignment_id'])) : '';

        $back = $order->get_view_order_url();

        if (mb_strlen($reason) < 3) {
            self::redirect_back($back, 'short');
        }

        // Kopya/staging koruması (§7): klon ortamda CANLI panele değişim talebi
        // (POST /v1/replacements) GÖNDERME. Klon aynı api_key+hmac_secret'i miras aldığından
        // istek gerçek panelde geçerli bir talep açardı — push/resync/revoke ile aynı guard.
        // Talep iletilmediği için dürüstçe 'error' bildirimiyle geri dön.
        if (Jetlisans_Settings::is_clone()) {
            self::redirect_back($back, 'error');
        }

        $body = [
            'remoteOrderId' => (string) $order_id,
            'reason'        => $reason,
        ];
        if ($assignment_id !== '') {
            $body['assignmentId'] = $assignment_id;
        }

        $res = Jetlisans_Panel_Client::post('/v1/replacements', $body);
        $ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        self::redirect_back($back, $ok ? 'ok' : 'error');
    }

    private static function redirect_back($url, $flag) {
        wp_safe_redirect(add_query_arg('jetlisans_report', $flag, $url));
        exit;
    }
}
