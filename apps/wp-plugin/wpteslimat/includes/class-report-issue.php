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
 *
 * YAZIŞMA (iki yönlü, §13): panel operatörü "Ek bilgi iste" dediğinde müşteriye
 *   "ek bilgiye ihtiyacımız var" maili gidiyor ANCAK müşterinin CEVAP VERECEK bir yolu yoktu —
 * tek çıkış "Sorun Bildir"e tekrar basmaktı; bu YENİ talep açar, 24 saatlik talep bütçesini
 * yer ve eski talep sonsuza dek `info_requested` kalır (kapalı döngü). Panelde uçlar ZATEN
 * vardı (`GET/POST /v1/replacements/:id/messages`, site-scoped, HMAC'li) ama eklenti
 *   (a) talep id'sini hiç saklamıyor,
 *   (b) yazışmayı hiç göstermiyordu.
 * Bu sınıf ikisini de kapatır: talep id'si sipariş meta'sına yazılır, müşteri yazışmayı
 * sipariş sayfasında görür ve aynı talebe yanıt yazabilir.
 */
class Wpteslimat_Report_Issue {
    /**
     * Sipariş meta'sı: bu siparişte açılmış PANEL talep referansları.
     *
     * Dizi olarak saklanır — bir siparişte birden çok ürün/kalem için ayrı talep açılabilir.
     * Her giriş: ['id' => uuid, 'at' => unix ts, 'reason' => müşterinin kendi metni (kısaltılmış)].
     * SIR İÇERMEZ (lisans verisi WP'de tutulmaz, §7): yalnız opak talep kimliği + müşterinin
     * kendi yazdığı açıklama.
     */
    const META_REQUESTS = '_wpteslimat_replacement_ids';

    /** Sipariş başına saklanan talep referansı üst sınırı (meta sınırsız şişmesin). */
    const MAX_REQUESTS = 20;

    /** Ekranda gösterilen SON mesaj sayısı (uzun yazışma sipariş sayfasını metin duvarı yapmasın). */
    const THREAD_VISIBLE = 20;

    /** Yazışması KENDİLİĞİNDEN açılan en yaşlı talep (saniye). Daha eskisi tek tık arkasında. */
    const AUTO_OPEN_MAX_AGE = 7776000; // 90 gün

    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Müşteri oturumlu (My Account) — nopriv da guest sipariş görünümü için kayıtlı.
        add_action('admin_post_wpteslimat_report', [$this, 'handle']);
        add_action('admin_post_nopriv_wpteslimat_report', [$this, 'handle']);
        // Mevcut talebe MÜŞTERİ YANITI (yazışma) — aynı sahiplik/nonce deseni.
        add_action('admin_post_wpteslimat_reply', [$this, 'handle_reply']);
        add_action('admin_post_nopriv_wpteslimat_reply', [$this, 'handle_reply']);
    }

    /**
     * Tek teslimat kalemi için "Sorun Bildir" açılır formu (kısa açıklama + gönder).
     * My Account render döngüsünden çağrılır. $assignment_id panelin deliveries
     * yanıtındaki opak referanstır (varsa gönderilir, yoksa atlanır).
     */
    public static function render_button($order, $assignment_id = '') {
        if (!is_a($order, 'WC_Order')) return;
        $order_id = $order->get_id();
        $fid = 'wpt-report-' . intval($order_id) . '-' . sanitize_html_class((string) $assignment_id);
        self::print_styles();
        ?>
        <details class="wpteslimat-report">
            <summary class="wpt-report__summary"><?php echo esc_html__('Sorun Bildir', 'wpteslimat'); ?></summary>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="wpt-report__form">
                <input type="hidden" name="action" value="wpteslimat_report">
                <input type="hidden" name="order_id" value="<?php echo esc_attr($order_id); ?>">
                <input type="hidden" name="assignment_id" value="<?php echo esc_attr((string) $assignment_id); ?>">
                <?php // Sahiplik kanıtı (denetim B1): GİRİŞ YAPMIŞ müşteride handle() current_user_can(
                      // 'view_order') ile doğrular → order_key DOM'a GÖMÜLMEZ (gereksiz bearer-token ifşası).
                      // MİSAFİR (guest checkout) için order_key tek sahiplik kanıtıdır → yalnız orada basılır. ?>
                <?php if (!is_user_logged_in()) : ?>
                <input type="hidden" name="order_key" value="<?php echo esc_attr($order->get_order_key()); ?>">
                <?php endif; ?>
                <?php wp_nonce_field('wpteslimat_report_' . $order_id); ?>
                <label for="<?php echo esc_attr($fid); ?>" class="wpt-report__label">
                    <?php echo esc_html__('Sorununuzu kısaca açıklayın (ör. lisans çalışmıyor):', 'wpteslimat'); ?>
                </label>
                <textarea id="<?php echo esc_attr($fid); ?>" name="reason" rows="3" required minlength="3" maxlength="1000"
                          class="input-text wpt-report__text"></textarea><br>
                <button type="submit" class="button button-small wpt-report__submit"><?php echo esc_html__('Gönder', 'wpteslimat'); ?></button>
            </form>
        </details>
        <?php
    }

    /**
     * Destek yüzeyinin stili — sayfada BİR KEZ basılır (my-account'taki desenin aynısı).
     *
     * TEMA-NÖTR: sabit `color:#555` kullanılmıyordu ve koyu zeminli WooCommerce temalarında
     * "Sorun Bildir" özeti ile form etiketi ≈2,6:1 kontrastla neredeyse okunmuyordu (teslimat
     * kartları bu yüzden zaten yarı saydam gri katmanlara geçirilmişti; bu iki blok atlanmıştı).
     * Renk artık temadan MİRAS ALINIR (`currentColor`), ayrım yalnız opaklık/dolgu ile yapılır →
     * hem açık hem koyu temada okunur kalır ve YENİ sabit renk eklenmez.
     */
    public static function print_styles() {
        static $printed = false;
        if ($printed) return;
        $printed = true;
        ?>
        <style>
        .wpteslimat-report{margin-top:8px}
        .wpteslimat-report>.wpt-report__summary{cursor:pointer;font-size:.9em;opacity:.75}
        .wpteslimat-report>.wpt-report__summary:hover,.wpteslimat-report[open]>.wpt-report__summary{opacity:1}
        .wpt-report__form{margin-top:6px}
        .wpt-report__label{display:block;font-size:.85em;opacity:.75;margin-bottom:4px}
        .wpt-report__text{width:100%;max-width:420px}
        .wpt-report__submit{margin-top:6px}
        .wpt-support{margin-top:18px;padding-top:14px;border-top:1px solid rgba(128,128,128,.28)}
        .wpt-support__title{margin:0 0 4px;font-size:1.05em}
        .wpt-support__intro{margin:0 0 10px;font-size:.88em;opacity:.8}
        .wpt-ticket{border:1px solid rgba(128,128,128,.32);border-radius:10px;padding:10px 14px;margin:0 0 12px}
        .wpt-ticket__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;font-size:.85em;opacity:.8}
        .wpt-ticket__reason{margin:6px 0 0;font-style:italic;opacity:.9}
        .wpt-ticket__state{margin:8px 0 0;font-size:.9em;font-weight:600}
        .wpt-thread{list-style:none;margin:10px 0 0;padding:0}
        .wpt-msg{border-radius:8px;padding:8px 10px;margin:6px 0;background:rgba(128,128,128,.10)}
        .wpt-msg--customer{background:rgba(128,128,128,.20)}
        .wpt-msg__head{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:.8em;opacity:.75;margin-bottom:3px}
        .wpt-msg__who{font-weight:600}
        .wpt-msg__body{word-break:break-word}
        .wpt-reply{margin-top:10px}
        .wpt-reply__text{width:100%;max-width:520px}
        </style>
        <?php
    }

    /**
     * Sipariş görünümünde işlem sonucu bildirimi (redirect query arg üzerinden).
     * My Account render başında çağrılır.
     */
    public static function render_notice() {
        if (isset($_GET['wpteslimat_report'])) {
            $r = sanitize_key(wp_unslash($_GET['wpteslimat_report']));
            if ($r === 'ok') {
                echo '<div class="woocommerce-message" role="alert">' .
                    esc_html__('Talebiniz alındı. Destek ekibimiz en kısa sürede inceleyecek; yanıtları bu sayfadaki "Destek talepleriniz" bölümünden takip edebilir ve cevap yazabilirsiniz.', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'short') {
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Lütfen sorununuzu biraz daha açıklayın (en az 3 karakter).', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'limit') {
                // (§13 suistimal sınırı) Panel 429 döndü: 24 saatlik talep bütçesi dolmuş.
                // Eskiden bu da genel "gönderilemedi" hatasına düşüyordu → müşteri sebebini
                // anlamayıp tekrar tekrar deniyordu. MEVCUT talebe yazmaya yönlendir.
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Kısa sürede çok fazla talep açtınız. Mevcut talebinizin altındaki yanıt kutusundan yazmaya devam edebilir veya bir süre sonra yeni talep açabilirsiniz.', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'error') {
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Talebiniz gönderilemedi. Lütfen daha sonra tekrar deneyin.', 'wpteslimat') .
                    '</div>';
            }
        }

        if (isset($_GET['wpteslimat_reply'])) {
            $r = sanitize_key(wp_unslash($_GET['wpteslimat_reply']));
            if ($r === 'ok') {
                echo '<div class="woocommerce-message" role="alert">' .
                    esc_html__('Mesajınız destek ekibimize iletildi.', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'short') {
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Lütfen bir mesaj yazın.', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'limit') {
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Kısa sürede çok fazla mesaj gönderdiniz. Lütfen biraz sonra tekrar deneyin.', 'wpteslimat') .
                    '</div>';
            } elseif ($r === 'error') {
                echo '<div class="woocommerce-error" role="alert">' .
                    esc_html__('Mesajınız gönderilemedi. Lütfen daha sonra tekrar deneyin.', 'wpteslimat') .
                    '</div>';
            }
        }
    }

    /**
     * Form gönderimini işler: nonce + sahiplik doğrula → panele HMAC ile push → geri yönlendir.
     */
    public function handle() {
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;

        // Nonce (CSRF) doğrula — order id'ye bağlı.
        if (!$order_id || !isset($_POST['_wpnonce']) ||
            !wp_verify_nonce(wp_unslash($_POST['_wpnonce']), 'wpteslimat_report_' . $order_id)) {
            wp_die(esc_html__('Geçersiz istek.', 'wpteslimat'), '', ['response' => 403]);
        }

        // admin-post ucu (nopriv dâhil) WooCommerce'ten BAĞIMSIZ kayıtlıdır → Woo geçici olarak
        // devre dışıyken wc_get_order() FATAL üretirdi. Geçici hata olarak dön.
        if (!function_exists('wc_get_order')) {
            wp_die(
                esc_html__('Talebiniz şu an alınamıyor. Lütfen daha sonra tekrar deneyin.', 'wpteslimat'),
                '',
                ['response' => 503]
            );
        }

        $order = self::authorized_order_or_die($order_id);

        $reason = isset($_POST['reason']) ? sanitize_textarea_field(wp_unslash($_POST['reason'])) : '';
        $reason = trim($reason);
        $assignment_id = isset($_POST['assignment_id'])
            ? sanitize_text_field(wp_unslash($_POST['assignment_id'])) : '';

        $back = self::order_url($order);

        if (mb_strlen($reason) < 3) {
            self::redirect_back($back, 'short');
        }

        // Kopya/staging koruması (§7): klon ortamda CANLI panele değişim talebi
        // (POST /v1/replacements) GÖNDERME. Klon aynı api_key+hmac_secret'i miras aldığından
        // istek gerçek panelde geçerli bir talep açardı — push/resync/revoke ile aynı guard.
        // Talep iletilmediği için dürüstçe 'error' bildirimiyle geri dön.
        if (Wpteslimat_Settings::is_clone()) {
            self::redirect_back($back, 'error');
        }

        $body = [
            'remoteOrderId' => (string) $order_id,
            'reason'        => $reason,
        ];
        if ($assignment_id !== '') {
            $body['assignmentId'] = $assignment_id;
        }

        $res = Wpteslimat_Panel_Client::post('/v1/replacements', $body);
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $ok = $code >= 200 && $code < 300;

        if ($ok) {
            /*
             * TALEP REFERANSINI SAKLA (kapalı döngünün ilk şartı).
             *
             * Eskiden yalnız HTTP koduna bakılıyor, yanıttaki `{id}` ATILIYORDU → müşteri kendi
             * talebinin kimliğini asla öğrenmiyor, dolayısıyla o talebe yanıt yazmak (yazışma
             * uçları talep id'si ister) imkânsız oluyordu. Panel id'yi zaten döndürüyor; tek
             * eksik onu siparişe bağlamaktı. Bu meta AYNI ZAMANDA bir YETKİ kaydıdır:
             * yazışma uçları paneldeki site kapsamıyla korunur (aynı mağazanın HERHANGİ bir
             * talebi), müşteri kapsamıyla DEĞİL → hangi talebin bu siparişe ait olduğunu
             * yalnız mağaza bilebilir. Okuma/yazma yollarında bu listeye üyelik ŞART koşulur.
             */
            $req_id = (isset($res['body']['id']) && is_scalar($res['body']['id']))
                ? (string) $res['body']['id'] : '';
            if ($req_id !== '' && self::looks_like_request_id($req_id)) {
                self::remember_request($order, $req_id, $reason);
                // Yazışma bloğu doğrudan yeni talebin üzerinde açılsın (müşteri nereye
                // yazacağını arasın istemiyoruz).
                $back = add_query_arg('wpt_thread', $req_id, $back);
            }
        }

        // 429 = talep açma bütçesi (§13). Genel "gönderilemedi" mesajı sebebini gizliyordu.
        self::redirect_back($back, $ok ? 'ok' : ($code === 429 ? 'limit' : 'error'));
    }

    /**
     * MEVCUT talebe müşteri yanıtı → panele `POST /v1/replacements/:id/messages`.
     *
     * Sahiplik iki katmanlı: (1) sipariş sahipliği (login → view_order, misafir → order_key),
     * (2) talep bu siparişin meta listesinde OLMALI. (2) atlanırsa panelin site-kapsamı tek
     * başına yeterli DEĞİLDİR: aynı mağazanın BAŞKA bir müşterisinin talebine yazılabilirdi.
     */
    public function handle_reply() {
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;

        if (!$order_id || !isset($_POST['_wpnonce']) ||
            !wp_verify_nonce(wp_unslash($_POST['_wpnonce']), 'wpteslimat_reply_' . $order_id)) {
            wp_die(esc_html__('Geçersiz istek.', 'wpteslimat'), '', ['response' => 403]);
        }
        if (!function_exists('wc_get_order')) {
            wp_die(
                esc_html__('Mesajınız şu an alınamıyor. Lütfen daha sonra tekrar deneyin.', 'wpteslimat'),
                '',
                ['response' => 503]
            );
        }

        $order = self::authorized_order_or_die($order_id);

        $request_id = isset($_POST['request_id'])
            ? sanitize_text_field(wp_unslash($_POST['request_id'])) : '';
        if (!self::owns_request($order, $request_id)) {
            wp_die(esc_html__('Bu talep için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }

        $message = isset($_POST['message']) ? sanitize_textarea_field(wp_unslash($_POST['message'])) : '';
        $message = trim($message);

        $back = add_query_arg('wpt_thread', $request_id, self::order_url($order));

        if ($message === '') {
            self::redirect_back_reply($back, 'short');
        }
        // Panel üst sınırı 2000 karakter (CustomerMessageBody) — sunucuda kırp ki uzun mesaj
        // 400 ile sessizce KAYBOLMASIN (müşteri yazdığını gönderdiğini sanır).
        if (function_exists('mb_substr')) {
            $message = mb_substr($message, 0, 2000);
        } else {
            $message = substr($message, 0, 2000);
        }

        // Klon/staging koruması (§7): klon aynı kimliği miras alır → CANLI panele gerçek
        // müşteri mesajı yazmasın (report/push/revoke ile aynı guard).
        if (Wpteslimat_Settings::is_clone()) {
            self::redirect_back_reply($back, 'error');
        }

        $res = Wpteslimat_Panel_Client::post(
            '/v1/replacements/' . rawurlencode($request_id) . '/messages',
            ['body' => $message]
        );
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $ok = $code >= 200 && $code < 300;
        self::redirect_back_reply($back, $ok ? 'ok' : ($code === 429 ? 'limit' : 'error'));
    }

    /**
     * Sipariş sahipliği (login → view_order meta-yetki; MİSAFİR → order_key). Yetkisizse 403 ile
     * sonlanır. `handle()` içinde satır satır duran kontrolün aynısı — yanıt yolu da AYNI kapıdan
     * geçsin diye tek noktaya alındı (iki uygulama zamanla ayrışır).
     *
     * @return WC_Order
     */
    private static function authorized_order_or_die($order_id) {
        $order = wc_get_order($order_id);
        if (!$order) {
            wp_die(esc_html__('Bu sipariş için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }
        // current_user_can('view_order') misafirde (uid 0) HER ZAMAN false döner → guest
        // checkout'ta destek akışı tümüyle 403 yiyordu; order_key WooCommerce'in misafir sipariş
        // erişiminde kullandığı standart sahiplik kanıtıdır. Nonce ayrıca CSRF'i order-id'ye bağlar.
        $authorized = false;
        if (is_user_logged_in()) {
            $authorized = current_user_can('view_order', $order_id);
        } else {
            $submitted_key = isset($_POST['order_key'])
                ? sanitize_text_field(wp_unslash($_POST['order_key'])) : '';
            $authorized = $submitted_key !== ''
                && hash_equals((string) $order->get_order_key(), $submitted_key);
        }
        if (!$authorized) {
            wp_die(esc_html__('Bu sipariş için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }
        return $order;
    }

    /**
     * Müşterinin geri döneceği sipariş görünümü URL'i.
     *
     * Misafir sahipliği order_key ile kanıtlanır; `get_view_order_url()` anahtarı İÇERMEZ →
     * misafir /my-account/view-order/<id>/'de login duvarına takılır, bildirimi göremez ve
     * lisans erişimini kaybeder. `key` query arg'ı eklenir ki TÜM sonuçlarda misafir
     * erişilebilir bir sayfaya dönsün.
     */
    private static function order_url($order) {
        $url = $order->get_view_order_url();
        if (!is_user_logged_in()) {
            $url = add_query_arg('key', $order->get_order_key(), $url);
        }
        return $url;
    }

    private static function redirect_back($url, $flag) {
        wp_safe_redirect(add_query_arg('wpteslimat_report', $flag, $url) . '#wpt-support');
        exit;
    }

    private static function redirect_back_reply($url, $flag) {
        wp_safe_redirect(add_query_arg('wpteslimat_reply', $flag, $url) . '#wpt-support');
        exit;
    }

    // ── Talep referansları (sipariş meta'sı) ────────────────────────────────────

    /** Panel talep kimliği biçimi (uuid). Bozuk/uydurma değer meta'ya ve panele hiç gitmesin. */
    private static function looks_like_request_id($id) {
        return (bool) preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', (string) $id);
    }

    /** Talep referansını siparişe ekler (en yeni başta, idempotent, üst sınırlı). */
    private static function remember_request($order, $request_id, $reason) {
        $list = self::get_requests($order);
        foreach ($list as $e) {
            if ($e['id'] === $request_id) return; // zaten kayıtlı
        }
        $excerpt = function_exists('mb_substr') ? mb_substr($reason, 0, 300) : substr($reason, 0, 300);
        array_unshift($list, ['id' => $request_id, 'at' => time(), 'reason' => $excerpt]);
        if (count($list) > self::MAX_REQUESTS) {
            $list = array_slice($list, 0, self::MAX_REQUESTS);
        }
        $order->update_meta_data(self::META_REQUESTS, $list);
        $order->save();
    }

    /**
     * Siparişin talep referansları (en yeni başta). Bozuk/eksik girişler SESSİZCE elenir —
     * meta elle düzenlenmiş olabilir; yarım kayıt yüzünden sipariş sayfası kırılmamalı.
     *
     * @return array<int, array{id:string, at:int, reason:string}>
     */
    public static function get_requests($order) {
        if (!is_a($order, 'WC_Order')) return [];
        $raw = $order->get_meta(self::META_REQUESTS);
        if (!is_array($raw)) return [];
        $out = [];
        foreach ($raw as $e) {
            if (!is_array($e) || !isset($e['id']) || !is_scalar($e['id'])) continue;
            $id = (string) $e['id'];
            if (!self::looks_like_request_id($id)) continue;
            $out[] = [
                'id'     => $id,
                'at'     => isset($e['at']) ? (int) $e['at'] : 0,
                'reason' => (isset($e['reason']) && is_scalar($e['reason'])) ? (string) $e['reason'] : '',
            ];
        }
        return $out;
    }

    /** Talep GERÇEKTEN bu siparişe mi ait? (yazışma okuma/yazma yollarının yetki kapısı) */
    private static function owns_request($order, $request_id) {
        $request_id = (string) $request_id;
        if (!self::looks_like_request_id($request_id)) return false;
        foreach (self::get_requests($order) as $e) {
            if (hash_equals($e['id'], $request_id)) return true;
        }
        return false;
    }

    // ── Yazışma görünümü ────────────────────────────────────────────────────────

    /**
     * Müşteri yazışma bloğu — My Account teslimat bölümünün altında.
     *
     * PERFORMANS/KOTA KARARI: sayfa render'ında paneldeki yazışma okuma ucu EN FAZLA BİR KEZ
     * çağrılır. Uç mağaza BAŞINA 120 istek/dakika ile sınırlıdır (paylaşılan bütçe) — her
     * talebin yazışmasını satır satır çekmek yoğun bir mağazada tüm müşterilere 429 yağdırırdı.
     * Bu yüzden: EN YENİ talebin (ya da `?wpt_thread=` ile AÇIKÇA istenen ve sahipliği
     * doğrulanmış talebin) yazışması gösterilir; diğerleri tek tıklık bağlantı arkasındadır.
     * Yanıt YAZMA yolu okuma gerektirmez → panel okuması başarısız olsa bile müşteri yine
     * cevap yazabilir (kapalı döngü kesilmez).
     */
    public static function render_threads($order) {
        if (!is_a($order, 'WC_Order')) return;
        $requests = self::get_requests($order);
        if (empty($requests)) return;
        // Klon/staging: okuma yolu da kısa devre (my-account render'ıyla aynı disiplin) —
        // bu metot bağımsız da çağrılabilir, guard'ı kendisi taşımalı.
        if (Wpteslimat_Settings::is_clone()) return;

        self::print_styles();

        // Açılacak yazışma: URL'de istenen (SAHİPLİĞİ DOĞRULANMIŞ) talep, yoksa en yenisi.
        // Doğrulama şart: id yalnız site kapsamında korunuyor → doğrulamasız `?wpt_thread=`
        // başka bir müşterinin yazışmasını okutabilirdi.
        $wanted = isset($_GET['wpt_thread']) ? sanitize_text_field(wp_unslash($_GET['wpt_thread'])) : '';
        $open_id = '';
        if ($wanted !== '' && self::owns_request($order, $wanted)) {
            $open_id = $wanted; // müşteri AÇIKÇA istedi — yaşına bakılmaz
        } elseif ($requests[0]['at'] === 0 || (time() - $requests[0]['at']) <= self::AUTO_OPEN_MAX_AGE) {
            // En yeni talep GÜNCELse kendiliğinden açılır. ESKİ talep için otomatik açmak,
            // yıllar önce kapanmış bir kayıt uğruna her sipariş görüntülemesine bir panel
            // isteği eklerdi (paylaşılan 120/dk okuma bütçesi) — o durumda yalnız bağlantı kalır.
            $open_id = $requests[0]['id'];
        }

        $thread = ($open_id !== '') ? self::fetch_thread($open_id) : null;

        echo '<div class="wpt-support" id="wpt-support">';
        echo '<h3 class="wpt-support__title">' . esc_html__('Destek talepleriniz', 'wpteslimat') . '</h3>';
        echo '<p class="wpt-support__intro">' .
            esc_html__('Bu siparişle ilgili açtığınız talepler ve destek ekibimizle yazışmanız burada görünür.', 'wpteslimat') .
            '</p>';

        foreach ($requests as $r) {
            $is_open = ($r['id'] === $open_id);
            echo '<div class="wpt-ticket">';
            echo '<div class="wpt-ticket__head">';
            echo '<span class="wpt-ticket__ref">' . esc_html(sprintf(
                /* translators: %s = talep referansının kısaltılmış hâli */
                __('Talep %s', 'wpteslimat'),
                self::short_ref($r['id'])
            )) . '</span>';
            if ($r['at'] > 0) {
                echo '<span class="wpt-ticket__at">' . esc_html(Wpteslimat_My_Account::format_date(gmdate('c', $r['at']))) . '</span>';
            }
            echo '</div>';
            if ($r['reason'] !== '') {
                echo '<p class="wpt-ticket__reason">' . esc_html($r['reason']) . '</p>';
            }

            if ($is_open) {
                self::render_thread_body($thread);
                self::render_reply_form($order, $r['id']);
            } else {
                echo '<p><a href="' . esc_url(add_query_arg('wpt_thread', $r['id'], self::order_url($order)) . '#wpt-support') . '">' .
                    esc_html__('Yazışmayı aç', 'wpteslimat') . '</a></p>';
            }
            echo '</div>';
        }
        echo '</div>';
    }

    /** Talep referansının müşteriye gösterilen kısa hâli (tam uuid gürültüdür). */
    private static function short_ref($id) {
        return '#' . strtoupper(substr((string) $id, 0, 8));
    }

    /**
     * Yazışmayı panelden çeker. ASLA fırlatmaz — sipariş sayfası bu blok yüzünden DÜŞMEZ.
     *
     * @return array{ok:bool, code:int, messages:array, truncated:bool}
     */
    private static function fetch_thread($request_id) {
        // Sayfa render'ı içinde senkron: kısa timeout (5sn) — teslimat çağrısıyla aynı disiplin.
        $res = Wpteslimat_Panel_Client::get(
            '/v1/replacements/' . rawurlencode($request_id) . '/messages',
            5
        );
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $msgs = (isset($body['messages']) && is_array($body['messages'])) ? $body['messages'] : [];
        return [
            'ok'        => $code >= 200 && $code < 300,
            'code'      => $code,
            'messages'  => $msgs,
            'truncated' => !empty($body['truncated']),
        ];
    }

    /** Yazışma gövdesi + durum satırı. */
    private static function render_thread_body($thread) {
        if (!$thread['ok']) {
            // Panele ulaşılamadı / hız sınırı. YANIT FORMU YİNE BASILIR (aşağıda) — yazma yolu
            // okuma başarısızlığından bağımsızdır; müşteri cevabını yine iletebilir.
            $msg = ($thread['code'] === 429)
                ? __('Yazışma şu an yoğunluk nedeniyle görüntülenemiyor; birazdan tekrar deneyin. Aşağıdan yine de mesaj yazabilirsiniz.', 'wpteslimat')
                : __('Yazışma şu an görüntülenemiyor; birazdan tekrar deneyin. Aşağıdan yine de mesaj yazabilirsiniz.', 'wpteslimat');
            echo '<p class="wpt-ticket__state">' . esc_html($msg) . '</p>';
            return;
        }

        /*
         * SÜZME TEK NOKTADA. Durum satırı önce ham listenin SON elemanına bakıyor, gövde ise
         * süzülmüş listeyi basıyordu → aynı yazışma için iki farklı "son mesaj" tanımı vardı:
         * (savunma amaçlı elenen) bir iç not ya da boş gövdeli bir satır listeye hiç girmezken
         * durum satırını belirleyebiliyor, müşteriye "Destek ekibimiz size yazdı" denirken
         * ekranda öyle bir mesaj görünmüyordu. Liste bir kez süzülür; durum da gösterim de
         * AYNI kümeden türer.
         */
        $msgs = [];
        foreach ($thread['messages'] as $m) {
            if (!is_array($m)) continue;
            // Panel iç notları bu uçtan ZATEN dönmez (servis süzer); yine de gelirse basma.
            if (!empty($m['internal'])) continue;
            $body = (isset($m['body']) && is_scalar($m['body'])) ? (string) $m['body'] : '';
            if (trim($body) === '') continue;
            $m['body'] = $body;
            $msgs[] = $m;
        }

        /*
         * DURUM METNİ YAZIŞMADAN TÜRETİLİR, panelin `status` enum'undan DEĞİL.
         *
         * Panelin site-facing yüzeyinde talep DURUMUNU sorgulayan bir uç YOKTUR ve durum
         * değişimi (onay/ret/bilgi-iste) WP'ye webhook olarak da gelmez. Talep açılırken
         * dönen `status` saklanıp gösterilseydi kalıcı olarak BAYATLARDI ("Açık" yazarken
         * talep çoktan sonuçlanmış olurdu) — bu panelde tekrarlayan bir hata sınıfı.
         * Buna karşılık durum değişimleri yazışmaya SİSTEM satırı olarak düşer ve müşteriye
         * görünür; son mesajın yazarı da her zaman tazedir. Yani gösterilen şey her koşulda
         * DOĞRUdur: "sırada kim var".
         */
        if (empty($msgs)) {
            echo '<p class="wpt-ticket__state">' . esc_html__('Talebiniz alındı; destek ekibimiz inceliyor.', 'wpteslimat') . '</p>';
            return;
        }

        $last = $msgs[count($msgs) - 1];
        $last_type = (isset($last['authorType']) && is_scalar($last['authorType'])) ? (string) $last['authorType'] : '';
        echo '<p class="wpt-ticket__state">' . esc_html(
            $last_type === 'customer'
                ? __('Yanıtınız iletildi; destek ekibimiz en kısa sürede dönecek.', 'wpteslimat')
                : __('Destek ekibimiz size yazdı — aşağıdan yanıtlayabilirsiniz.', 'wpteslimat')
        ) . '</p>';

        // Uzun yazışmada yalnız SON mesajlar basılır (sipariş sayfası metin duvarına dönmesin).
        $hidden = 0;
        if (count($msgs) > self::THREAD_VISIBLE) {
            $hidden = count($msgs) - self::THREAD_VISIBLE;
            $msgs = array_slice($msgs, -self::THREAD_VISIBLE);
        }
        if ($thread['truncated'] || $hidden > 0) {
            echo '<p class="wpt-support__intro">' . esc_html__('Yalnız son mesajlar gösteriliyor.', 'wpteslimat') . '</p>';
        }

        echo '<ul class="wpt-thread">';
        foreach ($msgs as $m) {
            $type = (isset($m['authorType']) && is_scalar($m['authorType'])) ? (string) $m['authorType'] : '';
            $mine = ($type === 'customer');
            $body = $m['body']; // yukarıda süzüldü/normalize edildi
            // Yazar adı panelden gelir ve müşteri görünümünde nötrdür ("Destek Ekibi"); yine de
            // MÜŞTERİ İÇERİĞİ sınıfında sayılıp kaçırılır.
            $who = $mine
                ? __('Siz', 'wpteslimat')
                : ((isset($m['authorName']) && is_scalar($m['authorName']) && trim((string) $m['authorName']) !== '')
                    ? (string) $m['authorName']
                    : __('Destek Ekibi', 'wpteslimat'));
            echo '<li class="wpt-msg' . ($mine ? ' wpt-msg--customer' : '') . '">';
            echo '<div class="wpt-msg__head">';
            echo '<span class="wpt-msg__who">' . esc_html($who) . '</span>';
            if (!empty($m['createdAt']) && is_scalar($m['createdAt'])) {
                echo '<span class="wpt-msg__at">' . esc_html(Wpteslimat_My_Account::format_date((string) $m['createdAt'])) . '</span>';
            }
            echo '</div>';
            // Serbest metin: ÖNCE kaçır, SONRA satır sonlarını <br>'ye çevir (tersi XSS olurdu).
            echo '<div class="wpt-msg__body">' . nl2br(esc_html($body)) . '</div>';
            echo '</li>';
        }
        echo '</ul>';
    }

    /** Aynı talebe yanıt kutusu (yeni talep AÇMAZ — mevcut yazışmaya ekler). */
    private static function render_reply_form($order, $request_id) {
        $order_id = $order->get_id();
        $fid = 'wpt-reply-' . intval($order_id) . '-' . sanitize_html_class($request_id);
        ?>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>" class="wpt-reply">
            <input type="hidden" name="action" value="wpteslimat_reply">
            <input type="hidden" name="order_id" value="<?php echo esc_attr($order_id); ?>">
            <input type="hidden" name="request_id" value="<?php echo esc_attr($request_id); ?>">
            <?php if (!is_user_logged_in()) : ?>
            <input type="hidden" name="order_key" value="<?php echo esc_attr($order->get_order_key()); ?>">
            <?php endif; ?>
            <?php wp_nonce_field('wpteslimat_reply_' . $order_id); ?>
            <label for="<?php echo esc_attr($fid); ?>" class="wpt-report__label">
                <?php echo esc_html__('Destek ekibine yanıt yazın:', 'wpteslimat'); ?>
            </label>
            <textarea id="<?php echo esc_attr($fid); ?>" name="message" rows="3" required maxlength="2000"
                      class="input-text wpt-reply__text"></textarea><br>
            <button type="submit" class="button button-small wpt-report__submit"><?php echo esc_html__('Yanıt Gönder', 'wpteslimat'); ?></button>
        </form>
        <?php
    }
}
