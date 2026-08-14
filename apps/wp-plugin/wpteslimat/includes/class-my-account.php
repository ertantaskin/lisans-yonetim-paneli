<?php
if (!defined('ABSPATH')) exit;

/**
 * Müşteri teslimat görünümü (§7). Sipariş detayında panel'den SERVER-SIDE çekilir;
 * yalnız aktif atamalar (panel SQL seviyesinde filtreler). Sırlar tarayıcıya panel
 * API'sinden değil, WP sunucusundan gelir; no-store.
 *
 * §7 UX: tek-tık kopyala · hesap parolası GÖSTER/GİZLE · çok-adetlide TOPLU .txt indirme
 * (loglu) · CANLI TAMAMLAMA YOKLAMASI (pending/partial siparişte otomatik yenileme) ·
 * durum matrisi (pending/held/partial-İLERLEME/suspended/expired/revoked/bounce).
 */
class Wpteslimat_My_Account {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('woocommerce_order_details_after_order_table', [$this, 'render'], 10, 1);
        add_action('template_redirect', [$this, 'nocache_account']);
        // §7 canlı tamamlama yoklaması — payload'SIZ durum özeti (status/fulfilled/total/count).
        add_action('wp_ajax_wpteslimat_poll', [$this, 'ajax_poll']);
        add_action('wp_ajax_nopriv_wpteslimat_poll', [$this, 'ajax_poll']);
        // §7 çok-adetlide toplu .txt indirme (loglu) — sunucu-taraflı, sır tarayıcı JS'ine girmez.
        add_action('admin_post_wpteslimat_download', [$this, 'handle_download']);
        add_action('admin_post_nopriv_wpteslimat_download', [$this, 'handle_download']);
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

    /**
     * Sipariş sahipliği (§7 rol/erişim): giriş yapmış müşteri → view_order meta-yetki; MİSAFİR
     * (guest checkout) → sipariş anahtarı (order_key). Report-Issue ile aynı desen.
     */
    private static function can_view($order, $submitted_key = '') {
        if (!is_a($order, 'WC_Order')) return false;
        if (is_user_logged_in()) {
            return current_user_can('view_order', $order->get_id());
        }
        $submitted_key = (string) $submitted_key;
        return $submitted_key !== '' && hash_equals((string) $order->get_order_key(), $submitted_key);
    }

    public function render($order) {
        if (!is_a($order, 'WC_Order')) return;
        $panel_order_id = $order->get_meta('_wpteslimat_order_id');
        if (!$panel_order_id) return;

        // (#8 savunma-derinliği) Bu hook normalde yalnız WC'nin yetkilendirdiği sipariş
        // görünümünde tetiklenir; yine de çözülmüş key'i basmadan ÖNCE kendi yetki kapımızı +
        // no-store başlığımızı uygula. can_view: login → view_order; misafir → URL ?key= (order_key).
        // nocache_account() yalnız view-order/order-received endpoint'inde çalışır → hook başka bir
        // bağlamda tetiklenirse bu ek kat sırrı yetkisiz göze/cache'e vermez. Meşru görüntüleyici
        // (owner veya anahtarlı misafir) her zaman geçer → mevcut akış BOZULMAZ, yalnız güçlenir.
        $req_key = isset($_GET['key']) ? sanitize_text_field(wp_unslash($_GET['key'])) : '';
        if (!self::can_view($order, $req_key)) return;
        if (!defined('DONOTCACHEPAGE')) define('DONOTCACHEPAGE', true);
        if (!headers_sent()) nocache_headers();

        // (§7 klon/staging koruması) Klon canlı panelden GERÇEK (maskesiz) key çekip gösterebilir →
        // okuma yolunu da kısa devre yap (yazma yolları zaten is_clone() korumalı).
        if (Wpteslimat_Settings::is_clone()) {
            echo '<section class="wpteslimat-deliveries" style="margin-top:24px">';
            echo '<h2>' . esc_html__('Lisans Teslimatınız', 'wpteslimat') . '</h2>';
            echo '<div class="woocommerce-info">' .
                esc_html__('Lisans bilgileri bu ortamda görüntülenemez.', 'wpteslimat') . '</div>';
            echo '</section>';
            return;
        }

        // Sayfa render'ı İÇİNDE senkron: kısa timeout (5sn) — panel yavaşsa sayfa 15sn asılmasın.
        $res = Wpteslimat_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries', 5);
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $deliveries = (isset($body['deliveries']) && is_array($body['deliveries'])) ? $body['deliveries'] : [];

        $fetch_ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        $panel_held = ($fetch_ok && array_key_exists('held', $body)) ? (bool) $body['held'] : null;
        if ($panel_held === false) {
            self::clear_held($order);
        }

        $status    = isset($body['status']) ? (string) $body['status'] : '';
        $suspended = !empty($body['suspended']);
        $expired_h = !empty($body['expiredHidden']);
        $fulfilled = isset($body['fulfilled']) ? (int) $body['fulfilled'] : null;
        $total     = isset($body['total']) ? (int) $body['total'] : null;

        echo '<section class="wpteslimat-deliveries" style="margin-top:24px">';
        echo '<h2>' . esc_html__('Lisans Teslimatınız', 'wpteslimat') . '</h2>';
        Wpteslimat_Report_Issue::render_notice();

        // (#32) Teslimat maili ulaşmadıysa bilgilendirici bant (sır/sızıntı YOK).
        $mail_status = isset($body['mailStatus']) ? (string) $body['mailStatus'] : '';
        if (in_array($mail_status, ['failed', 'bounced'], true)) {
            echo '<div class="woocommerce-info" role="alert" style="margin-bottom:12px">' .
                esc_html__('Teslimat e-postanız size ulaşmamış olabilir. Lisans bilgilerinizi bu sayfadan görüntüleyebilirsiniz; sorun yaşarsanız destek ekibimizle iletişime geçin.', 'wpteslimat') .
                '</div>';
        }

        // §7 durum matrisi: suspended ('inceleme altında') ve expired-hidden ('süreniz doldu')
        // ATAMA-durum bayraklarından (order.status'a güvenmeden) çıkar — bunlar deliveries listesinde
        // görünmese de müşteriye açıklanmalı.
        if ($suspended) {
            echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                esc_html__('Lisansınız şu an inceleme altında. İnceleme tamamlanınca burada tekrar görünür olacaktır.', 'wpteslimat') .
                '</div>';
        }
        if ($expired_h) {
            echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                esc_html__('Lisans sürenizin süresi doldu. Yeni bir lisans için mağazadan tekrar satın alabilir veya destek ekibimizle iletişime geçebilirsiniz.', 'wpteslimat') .
                '</div>';
        }

        // §7 kısmi ilerleme göstergesi (partial → "X / Y teslim edildi" + çubuk).
        if ($status === 'partial' && $total !== null && $total > 0 && $fulfilled !== null) {
            $pct = max(0, min(100, (int) round($fulfilled / $total * 100)));
            echo '<div style="margin-bottom:10px">';
            echo '<small>' . esc_html(sprintf(__('%1$d / %2$d teslim edildi', 'wpteslimat'), $fulfilled, $total)) . '</small>';
            echo '<div style="height:6px;background:#e5e7eb;border-radius:3px;overflow:hidden;margin-top:3px">';
            echo '<div style="height:100%;width:' . intval($pct) . '%;background:#059669"></div></div></div>';
        }

        if (empty($deliveries)) {
            if (!$fetch_ok) {
                // Panele ULAŞILAMADI. Bunu "henüz teslimat yok" ile AYNI göstermek, teslim EDİLMİŞ
                // siparişi kalıcı "hazırlanıyor" ekranında kilitliyordu (müşteri lisansını göremiyor,
                // destek yükü). Durumu dürüstçe ayır: geçici erişim sorunu olduğunu söyle. Aşağıdaki
                // yoklama script'i bu durumda da basılır → panel toparlayınca sayfa kendini yeniler.
                // Sır CACHE'LENMEZ (§7): burada yerel kopya tutulmaz, yalnız yeniden denenir.
                echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                    esc_html__('Lisans bilgileriniz şu an görüntülenemiyor, birazdan tekrar deneyin. Bu sayfa hazır olduğunda kendiliğinden güncellenecektir.', 'wpteslimat') .
                    '</div>';
            } else {
                if (in_array($status, ['fulfilled', 'partial', 'revoked'], true)) {
                    self::clear_held($order);
                }
                $held_local = ($order->get_meta('_wpteslimat_held_for_review') === 'yes');
                $show_review = $held_local && (
                    $panel_held === true ||
                    ($panel_held === null && $status === 'pending')
                );
                // suspended/expired zaten yukarıda bant olarak gösterildi → burada tekrar genel mesaj basma.
                if ($show_review) {
                    echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                        esc_html__('Siparişiniz güvenlik incelemesindedir. Onaylandığında lisansınız burada görünecek ve e-posta ile bildirilecektir.', 'wpteslimat') .
                        '</div>';
                } elseif (!$suspended && !$expired_h) {
                    echo '<p>' . esc_html($this->status_message($status)) . '</p>';
                }
            }
        } else {
            self::clear_held($order);

            // §7 çok-adetlide TOPLU .txt indirme (loglu) — 2+ teslimatta göster.
            if (count($deliveries) >= 2) {
                // (denetim B1 deseninin tamamlanması) order_key bir BEARER token'dır: onu bilen
                // herkes siparişi (ve bu sayfadan lisansları) görebilir. GİRİŞ YAPMIŞ müşteride
                // sahiplik `current_user_can('view_order')` ile kanıtlanır (bkz. can_view) → anahtarı
                // ayrıca URL'e koymak gereksiz ifşadır (tarayıcı geçmişi, sunucu erişim logu, kopyala-
                // yapıştır ile paylaşılan bağlantı). MİSAFİR siparişte tek sahiplik kanıtı odur → orada
                // KORUNUR. Report_Issue formunda aynı karar alınmıştı; bu iki yüzey atlanmıştı.
                $dl_args = [
                    'action'   => 'wpteslimat_download',
                    'order_id' => $order->get_id(),
                ];
                if (!is_user_logged_in()) {
                    $dl_args['order_key'] = $order->get_order_key();
                }
                $dl = wp_nonce_url(
                    add_query_arg($dl_args, admin_url('admin-post.php')),
                    'wpteslimat_download_' . $order->get_id()
                );
                echo '<p><a href="' . esc_url($dl) . '" class="button button-small">' .
                    esc_html__('Tüm lisansları .txt indir', 'wpteslimat') . '</a></p>';
            }

            // (§7 çok ürünlü sipariş) Teslimatları SİPARİŞ KALEMİNE göre grupla: 3 ürünlü bir
            // siparişte müşteri düz bir anahtar listesi görüyor ve hangi anahtarın hangi ürüne ait
            // olduğunu ayırt edemiyordu (teslimat MAİLİ ve sipariş kutusu ürün adını ZATEN
            // gösteriyordu → aynı veri üç yüzeyde farklı). Ürün adı PANELDEN İSTENMEZ: `remoteLineId`
            // WooCommerce sipariş kalemi id'sidir, adı mağaza kendi kaleminden bilir (ek istek yok).
            $groups = self::group_by_line($deliveries, self::item_names($order));

            echo '<table class="woocommerce-table shop_table"><tbody>';
            foreach ($groups as $group) {
                // Başlık YALNIZ kalem gerçekten çözülebildiğinde basılır; çözülemeyen satır (eski
                // teslimat, silinmiş/bilinmeyen kalem) başlıksız ESKİ davranışa düşer — asla fatal olmaz.
                if ($group['label'] !== '') {
                    echo '<tr><td style="background:#f6f7f7;font-weight:600">' . esc_html($group['label']) . '</td></tr>';
                }
                foreach ($group['rows'] as $row) {
                    list($i, $d) = $row;
                    echo '<tr><td>';
                    $is_account = isset($d['kind']) ? ($d['kind'] === 'account') : (!empty($d['fields']));
                    if ($is_account && !empty($d['fields']) && is_array($d['fields'])) {
                        echo '<div class="wpteslimat-fields">';
                        foreach ($d['fields'] as $fi => $f) {
                            $label  = isset($f['label']) ? $f['label'] : '';
                            $value  = isset($f['value']) ? $f['value'] : '';
                            $secret = !empty($f['secret']);
                            $fid = 'wpt-f-' . intval($i) . '-' . intval($fi);
                            echo '<div style="margin:2px 0">';
                            echo '<strong>' . esc_html($label) . ':</strong> ';
                            if ($secret) {
                                // §7 parola GÖSTER/GİZLE: gerçek değer data-attr'da; görünen varsayılan maskeli.
                                echo '<code id="' . esc_attr($fid) . '" data-secret="' . esc_attr($value) . '" data-shown="0" style="user-select:all">••••••••</code> ';
                                echo '<button type="button" class="button button-small wpteslimat-toggle" data-target="' . esc_attr($fid) . '" style="margin-left:6px">' . esc_html__('Göster', 'wpteslimat') . '</button> ';
                            } else {
                                echo '<code id="' . esc_attr($fid) . '" style="user-select:all">' . esc_html($value) . '</code> ';
                            }
                            echo '<button type="button" class="button button-small wpteslimat-copy" data-target="' . esc_attr($fid) . '" style="margin-left:6px">' . esc_html__('Kopyala', 'wpteslimat') . '</button>';
                            echo '</div>';
                        }
                        echo '</div>';
                    } else {
                        // NEDEN "elseif ($is_account) → Teslimat hazırlanıyor" dalı KALDIRILDI:
                        // hesap ürününde `fields` BOŞ gelebilir ve bu "teslim edilmedi" DEMEK DEĞİLDİR —
                        // (a) ürünün payloadSchema'sı bozuksa panel bilerek {kind:'account', payload:düz
                        // metin, fields:null} döner, (b) operatör şema alan anahtarını sonradan
                        // değiştirirse eski payload'lar eşleşmez ve fields BOŞ DİZİ olur. Eski dal bu iki
                        // durumda teslim EDİLMİŞ siparişte müşteriyi KALICI "hazırlanıyor" ekranına
                        // kilitliyordu (üstelik ilerleme çubuğu "3/3 teslim edildi" diyordu — çelişki) ve
                        // ekran kendini asla düzeltmiyordu. Sipariş kutusu (metabox) ZATEN bu desende:
                        // alanlar çözülemezse ham payload gösterilir.
                        $payload = (isset($d['payload']) && is_scalar($d['payload'])) ? (string) $d['payload'] : '';
                        if ($payload === '') {
                            // Gerçekten hiçbir içerik yok → "hazırlanıyor" DEME (sipariş teslim edilmiş
                            // olabilir); müşteriye aksiyon veren, ayırt edici mesaj bas.
                            echo '<em>' . esc_html__('Lisans bilgileriniz görüntülenemedi — lütfen destek ekibimizle iletişime geçin.', 'wpteslimat') . '</em>';
                        } else {
                            $id = 'wpt-key-' . intval($i);
                            echo '<code id="' . esc_attr($id) . '" style="user-select:all">' . esc_html($payload) . '</code> ';
                            echo '<button type="button" class="button wpteslimat-copy" data-target="' . esc_attr($id) . '" style="margin-left:8px">' . esc_html__('Kopyala', 'wpteslimat') . '</button>';
                        }
                    }
                    // (§11 çok kullanımlı / MAK) Bir anahtar birden çok aktivasyon hakkı taşıyabilir.
                    // Bu bilgi mailde ("(3 adet)") ve sipariş kutusunda ("3/5 kullanım") vardı, müşteri
                    // sayfasında HİÇ yoktu → 9 aktivasyon alan müşteri 2 çıplak anahtar görüp eksik
                    // teslimat aldığını sanıyordu. Panel `units` alanını zaten döndürüyor (API değişmedi);
                    // tek kullanımlıkta (units yok/1) hiçbir şey basılmaz — gereksiz gürültü olmasın.
                    $units = isset($d['units']) ? (int) $d['units'] : 0;
                    if ($units > 1) {
                        $units_msg = $is_account
                            /* translators: %d = bu kayıttaki kullanım/aktivasyon hakkı adedi */
                            ? __('Bu hesap %d kullanım/aktivasyon hakkı içerir.', 'wpteslimat')
                            /* translators: %d = bu anahtardaki kullanım/aktivasyon hakkı adedi */
                            : __('Bu anahtar %d kullanım/aktivasyon hakkı içerir.', 'wpteslimat');
                        echo '<br><small>' . esc_html(sprintf($units_msg, $units)) . '</small>';
                    }
                    if (!empty($d['validUntil'])) {
                        $exp = !empty($d['expired']);
                        echo '<br><small' . ($exp ? ' style="color:#b45309"' : '') . '>';
                        echo esc_html($exp ? __('Süresi doldu:', 'wpteslimat') : __('Geçerlilik:', 'wpteslimat'));
                        echo ' ' . esc_html(self::format_date($d['validUntil'])) . '</small>';
                    }
                    $assignment_id = isset($d['assignmentId']) ? $d['assignmentId'] : (isset($d['id']) ? $d['id'] : '');
                    Wpteslimat_Report_Issue::render_button($order, $assignment_id);
                    echo '</td></tr>';
                }
            }
            echo '</tbody></table>';
        }

        // §7 canlı tamamlama yoklaması: sipariş HENÜZ TAMAMLANMADIYSA (pending/partial/held) küçük bir
        // script durum özetini periyodik yoklar, ilerleyince sayfayı yeniler (payload JS'e girmez).
        $incomplete = in_array($status, ['pending', 'partial', 'unmapped', ''], true) || $panel_held === true;
        // Panel erişilemezken de yokla (eskiden `$fetch_ok &&` bunu engelliyordu): teslim edilmiş
        // sipariş geçici bir kesintide "görüntülenemiyor" ekranında KİLİTLENMESİN — panel toparlayınca
        // yoklama status/count değişimini görüp sayfayı yeniler. Yoklama payload TAŞIMAZ (§7).
        if (!$fetch_ok || $incomplete) {
            $this->print_poll_script($order, count($deliveries), $status);
        }
        $this->print_ui_script();

        echo '</section>';
    }

    /** Kopyala + Göster/Gizle davranışı (enqueue yerine tek-seferlik hafif inline script). */
    private function print_ui_script() {
        static $printed = false;
        if ($printed) return;
        $printed = true;
        ?>
        <script>
        (function(){
          if (window.__wpteslimatUI) return; window.__wpteslimatUI = 1;
          document.addEventListener('click', function(e){
            var b = e.target.closest ? e.target.closest('.wpteslimat-copy,.wpteslimat-toggle') : null;
            if (!b) return;
            var el = document.getElementById(b.getAttribute('data-target'));
            if (!el) return;
            if (b.classList.contains('wpteslimat-toggle')) {
              var shown = el.getAttribute('data-shown') === '1';
              el.textContent = shown ? '••••••••' : (el.getAttribute('data-secret') || '');
              el.setAttribute('data-shown', shown ? '0' : '1');
              b.textContent = shown ? <?php echo wp_json_encode(__('Göster', 'wpteslimat')); ?> : <?php echo wp_json_encode(__('Gizle', 'wpteslimat')); ?>;
              return;
            }
            var val = (el.getAttribute('data-shown') === '0' && el.getAttribute('data-secret') !== null)
              ? el.getAttribute('data-secret') : el.textContent;
            if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(val); }
            else { var r=document.createRange(); r.selectNodeContents(el); var s=window.getSelection(); s.removeAllRanges(); s.addRange(r); try{document.execCommand('copy');}catch(_){} }
            var t=b.textContent; b.textContent=<?php echo wp_json_encode(__('Kopyalandı', 'wpteslimat')); ?>; setTimeout(function(){b.textContent=t;},1200);
          });
        })();
        </script>
        <?php
    }

    /** Canlı yoklama script'i — ajax_poll'u periyodik çağırır; teslim ilerleyince sayfayı yeniler. */
    private function print_poll_script($order, $count, $status) {
        $nonce = wp_create_nonce('wpteslimat_poll_' . $order->get_id());
        // (denetim B1 deseni) order_key YALNIZ misafir siparişinde DOM'a girer; giriş yapmış
        // müşteride sahiplik view_order yetkisiyle kanıtlanır (can_view) → boş string gönderilir ve
        // ajax_poll onu hiç okumaz. Böylece bearer token gereksiz yere sayfa kaynağına basılmaz.
        $poll_key = is_user_logged_in() ? '' : $order->get_order_key();
        ?>
        <script>
        (function(){
          var data = {
            action: 'wpteslimat_poll',
            order_id: <?php echo (int) $order->get_id(); ?>,
            order_key: <?php echo wp_json_encode($poll_key); ?>,
            _n: <?php echo wp_json_encode($nonce); ?>
          };
          var base = { count: <?php echo (int) $count; ?>, status: <?php echo wp_json_encode($status); ?> };
          var tries = 0, delay = 8000;
          function poll(){
            if (tries++ > 40) return; // ~güvenli üst sınır
            var body = Object.keys(data).map(function(k){return encodeURIComponent(k)+'='+encodeURIComponent(data[k]);}).join('&');
            fetch(<?php echo wp_json_encode(admin_url('admin-ajax.php')); ?>, {method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body,credentials:'same-origin'})
              .then(function(r){return r.json();})
              .then(function(j){
                if (!j || !j.success || !j.data) { schedule(); return; }
                var d = j.data;
                // (#7) Yeni teslimat (count arttı) VEYA durum BAŞLANGIÇTAN farklı herhangi bir
                // (boş-olmayan) yeni duruma geçtiyse yenile — özellikle held→rejected (status
                // 'revoked', webhook YOK) müşteriyi "inceleme altında" ekranında kilitlemesin.
                // Yalnız status/count okunur; payload/key sızmaz.
                if ((typeof d.count==='number' && d.count>base.count) || (d.status && d.status!==base.status)) {
                  location.reload(); return;
                }
                schedule();
              }).catch(function(){ schedule(); });
          }
          function schedule(){ delay = Math.min(delay*1.4, 60000); setTimeout(poll, delay); }
          setTimeout(poll, delay);
        })();
        </script>
        <?php
    }

    /** AJAX: payload'SIZ durum özeti (canlı yoklama). Sahiplik (login/order_key) + nonce doğrular. */
    public function ajax_poll() {
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $key = isset($_POST['order_key']) ? sanitize_text_field(wp_unslash($_POST['order_key'])) : '';
        if (!$order_id || !isset($_POST['_n']) ||
            !wp_verify_nonce(wp_unslash($_POST['_n']), 'wpteslimat_poll_' . $order_id)) {
            wp_send_json_error(['error' => 'bad_request'], 400);
        }
        // admin-ajax uçları WooCommerce'ten BAĞIMSIZ kayıtlıdır; Woo geçici olarak devre dışıyken
        // wc_get_order() tanımsız fonksiyon FATAL'i üretirdi (beyaz ekran). Dürüst geçici hata dön.
        if (!function_exists('wc_get_order')) {
            wp_send_json_error(['error' => 'unavailable'], 200);
        }
        $order = wc_get_order($order_id);
        if (!$order || !self::can_view($order, $key)) {
            wp_send_json_error(['error' => 'forbidden'], 403);
        }
        if (Wpteslimat_Settings::is_clone()) {
            wp_send_json_error(['error' => 'unavailable'], 200);
        }
        $panel_order_id = $order->get_meta('_wpteslimat_order_id');
        if (!$panel_order_id) wp_send_json_success(['status' => '', 'count' => 0]);

        $res = Wpteslimat_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries', 5);
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $deliveries = (isset($body['deliveries']) && is_array($body['deliveries'])) ? $body['deliveries'] : [];
        // PAYLOAD/KEY DÖNMEZ — yalnız sayaç + durum (canlı yoklama için yeterli).
        nocache_headers();
        wp_send_json_success([
            'status'    => isset($body['status']) ? (string) $body['status'] : '',
            'count'     => count($deliveries),
            'fulfilled' => isset($body['fulfilled']) ? (int) $body['fulfilled'] : null,
            'total'     => isset($body['total']) ? (int) $body['total'] : null,
        ]);
    }

    /**
     * §7 çok-adetlide TOPLU .txt indirme (loglu). Sahiplik + nonce doğrular; teslimatları
     * SUNUCU-TARAFLI panelden çeker, text/plain üretir (sır tarayıcı JS'ine girmez) ve indirmeyi
     * panele loglar (audit; yerel kuyruk log). Klon ortamda kısa devre.
     */
    public function handle_download() {
        $order_id = isset($_GET['order_id']) ? absint($_GET['order_id']) : 0;
        $key = isset($_GET['order_key']) ? sanitize_text_field(wp_unslash($_GET['order_key'])) : '';
        if (!$order_id || !isset($_GET['_wpnonce']) ||
            !wp_verify_nonce(wp_unslash($_GET['_wpnonce']), 'wpteslimat_download_' . $order_id)) {
            wp_die(esc_html__('Geçersiz istek.', 'wpteslimat'), '', ['response' => 403]);
        }
        // admin-post ucu WooCommerce'ten BAĞIMSIZ kayıtlıdır (nopriv dâhil) → Woo devre dışıyken
        // wc_get_order() FATAL üretirdi. Geçici hata olarak dön (müşteri tekrar deneyebilir).
        if (!function_exists('wc_get_order')) {
            wp_die(
                esc_html__('Lisans bilgileriniz şu an alınamadı, birazdan tekrar deneyin.', 'wpteslimat'),
                '',
                ['response' => 503]
            );
        }
        $order = wc_get_order($order_id);
        if (!$order || !self::can_view($order, $key)) {
            wp_die(esc_html__('Bu sipariş için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }
        if (Wpteslimat_Settings::is_clone()) {
            wp_die(esc_html__('Lisans bilgileri bu ortamda görüntülenemez.', 'wpteslimat'), '', ['response' => 403]);
        }
        $panel_order_id = $order->get_meta('_wpteslimat_order_id');
        if (!$panel_order_id) {
            wp_die(esc_html__('Teslimat bulunamadı.', 'wpteslimat'), '', ['response' => 404]);
        }
        $res = Wpteslimat_Panel_Client::get('/v1/orders/' . rawurlencode($panel_order_id) . '/deliveries', 8);
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        $deliveries = (isset($body['deliveries']) && is_array($body['deliveries'])) ? $body['deliveries'] : [];

        // Panel yanıtı 2xx DEĞİLSE (erişilemedi / 5xx / 401) elimizde teslimat YOKTUR. Eskiden bu
        // durumda BOŞ bir .txt HTTP 200 ile servis ediliyor ve siparişe "0 lisans indirdi" diye
        // YANLIŞ audit notu düşüyordu (müşteri boş dosya alıyor, operatör yanıltıcı iz görüyor).
        // Dosya ÜRETME, not YAZMA — anlaşılır Türkçe mesajla 503 dön (geçici hata, tekrar denenebilir).
        $fetch_ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        if (!$fetch_ok) {
            if (!headers_sent()) {
                header('Retry-After: 60');
            }
            wp_die(
                esc_html__('Lisans bilgileriniz şu an alınamadı, birazdan tekrar deneyin. Sorun sürerse destek ekibimizle iletişime geçin.', 'wpteslimat'),
                '',
                ['response' => 503]
            );
        }
        // 2xx ama teslimat yok (henüz atanmamış/iptal edilmiş): boş dosya + yanıltıcı not üretme.
        if (empty($deliveries)) {
            wp_die(
                esc_html__('Bu siparişte indirilebilecek lisans bulunmuyor. Teslimat hazırlandığında bu sayfada görünecektir.', 'wpteslimat'),
                '',
                ['response' => 404]
            );
        }

        // §7 "loglu" şartı: indirmeyi sipariş notuna (görünür audit izi) yaz. Panel migration'ı
        // gerektirmeden operatör timeline'da görür; sır/payload NOTA GİRMEZ (yalnız adet).
        // Not YALNIZ gerçekten teslimat varken yazılır (yukarıdaki iki kapı geçildiyse).
        $order->add_order_note(sprintf(
            /* translators: %d = indirilen lisans adedi */
            __('Müşteri %d lisansı .txt olarak indirdi.', 'wpteslimat'),
            count($deliveries)
        ));

        // Ekran render'ıyla AYNI gruplama/etiketleme: indirilen dosya da hangi anahtarın hangi
        // ürüne ait olduğunu göstermeli (iki yüzey ayrışırsa müşteri hangisine güveneceğini bilemez).
        $groups = self::group_by_line($deliveries, self::item_names($order));

        $lines = [];
        $lines[] = sprintf('# Sipariş #%d — %s', $order_id, wp_date('Y-m-d H:i'));
        $lines[] = str_repeat('-', 40);
        foreach ($groups as $group) {
            if ($group['label'] !== '') {
                $lines[] = '## ' . $group['label'];
            }
            foreach ($group['rows'] as $row) {
                $d = $row[1]; // [0] = orijinal indeks; .txt'de gerekmez (yalnız DOM id'leri için tutulur).
                $is_account = isset($d['kind']) ? ($d['kind'] === 'account') : (!empty($d['fields']));
                if ($is_account && !empty($d['fields']) && is_array($d['fields'])) {
                    foreach ($d['fields'] as $f) {
                        $lines[] = (isset($f['label']) ? $f['label'] : '') . ': ' . (isset($f['value']) ? $f['value'] : '');
                    }
                } else {
                    // Ekran dalıyla aynı NEDEN: `fields` boş gelen hesap ürününde düz payload'a düş.
                    // Eskiden bu satır (string) null → dosyaya BOŞ SATIR yazıyordu ve siparişe yine
                    // "Müşteri N lisansı .txt indirdi" notu düşüyordu (müşteri boş dosya, operatör
                    // "teslim edildi" izi görüyordu).
                    $payload = (isset($d['payload']) && is_scalar($d['payload'])) ? (string) $d['payload'] : '';
                    $lines[] = $payload !== ''
                        ? $payload
                        : __('(Lisans bilgisi görüntülenemedi — lütfen destek ekibimizle iletişime geçin.)', 'wpteslimat');
                }
                $units = isset($d['units']) ? (int) $d['units'] : 0;
                if ($units > 1) {
                    $units_msg = $is_account
                        /* translators: %d = bu kayıttaki kullanım/aktivasyon hakkı adedi */
                        ? __('Bu hesap %d kullanım/aktivasyon hakkı içerir.', 'wpteslimat')
                        /* translators: %d = bu anahtardaki kullanım/aktivasyon hakkı adedi */
                        : __('Bu anahtar %d kullanım/aktivasyon hakkı içerir.', 'wpteslimat');
                    $lines[] = sprintf($units_msg, $units);
                }
                if (!empty($d['validUntil'])) {
                    $lines[] = __('Geçerlilik:', 'wpteslimat') . ' ' . self::format_date($d['validUntil']);
                }
                $lines[] = '';
            }
        }
        nocache_headers();
        header('Content-Type: text/plain; charset=utf-8');
        header('Content-Disposition: attachment; filename="lisanslar-siparis-' . $order_id . '.txt"');
        echo implode("\n", $lines);
        exit;
    }

    /**
     * Sipariş kalemi id → görünen ad haritası.
     *
     * Ürün adı PANELDEN İSTENMEZ: mağaza kendi sipariş kalemlerini zaten bilir (ek istek/alan yok)
     * ve `$item->get_name()` varyasyon etiketini de içerir — teslimat mailindeki adla aynı kaynak.
     */
    private static function item_names($order) {
        $names = [];
        foreach ($order->get_items() as $item_id => $item) {
            $name = trim((string) $item->get_name());
            if ($name !== '') $names[(string) $item_id] = $name;
        }
        return $names;
    }

    /**
     * Panel satır kimliğini (remoteLineId) Woo sipariş kalemine çözer. İki biçim eşleşir — sipariş
     * kutusundaki `line_matches()` ile AYNI kural (iki yüzey farklı gruplama yapmasın):
     *   - "<item_id>"              → normal sipariş kalemi
     *   - "bonus:<item_id>:<uuid>" → o kaleme eklenen sentetik bonus satırı (panel bonusAssign)
     * Çözülemezse '' → çağıran BAŞLIKSIZ (eski) davranışa düşer; asla fatal olmaz.
     */
    private static function resolve_item_id($remote_line_id, $item_names) {
        $rl = (string) $remote_line_id;
        if ($rl === '') return '';
        if (isset($item_names[$rl])) return $rl;
        if (strpos($rl, 'bonus:') === 0) {
            $parts = explode(':', $rl);
            if (isset($parts[1]) && isset($item_names[$parts[1]])) return $parts[1];
        }
        return '';
    }

    /**
     * Teslimatları sipariş kalemine göre gruplar — ekran ve .txt ORTAK kullanır (iki yüzey
     * ayrışırsa müşteri hangisine güveneceğini bilemez). Bonus satırı ait olduğu ürünün grubuna
     * katılır (aynı ad iki kez başlık olmaz). Çözülemeyen satırlar kendi ham kimlikleri altında,
     * başlıksız kalır — bilinmeyen satırlar birbirine karışmasın.
     *
     * @return array<string, array{label:string, rows:array}> rows: [orijinal indeks, teslimat]
     */
    private static function group_by_line($deliveries, $item_names) {
        $groups = [];
        foreach ($deliveries as $i => $d) {
            $line_id = (isset($d['remoteLineId']) && is_scalar($d['remoteLineId'])) ? (string) $d['remoteLineId'] : '';
            $item_id = self::resolve_item_id($line_id, $item_names);
            $key = $item_id !== '' ? 'i:' . $item_id : 'x:' . $line_id;
            if (!isset($groups[$key])) {
                $groups[$key] = [
                    'label' => $item_id !== '' ? $item_names[$item_id] : '',
                    'rows'  => [],
                ];
            }
            // Orijinal indeks KORUNUR: ekrandaki DOM id'leri (wpt-key-N / wpt-f-N-M) ona dayanır,
            // gruplama sonrası yeniden numaralandırılırsa kopyala/göster düğmeleri yanlış öğeyi hedefler.
            $groups[$key]['rows'][] = [$i, $d];
        }
        return $groups;
    }

    /**
     * ISO 8601 → WP yerelleştirilmiş tarih (ham ISO string müşteriye gösterilmez).
     *
     * `wp_date()` KULLANILIR, `date_i18n()` DEĞİL: date_i18n() verilen timestamp'i ZATEN
     * yerelleştirilmiş sayar ve üstüne saat dilimi uygulamaz → panelden gelen UTC ISO değeri
     * (validUntil, değişim tarihi) mağazanın saat diliminde değil, UTC olarak basılıyordu
     * (Türkiye'de 3 saat geriden — "geçerlilik 21:00" yerine "18:00"). wp_date() timestamp'i UTC
     * kabul edip mağaza saat dilimine çevirir. Aynı dosyadaki .txt indirme başlığı (wp_date) ve
     * güncelleyicinin uyarı metni (wp_date) zaten doğrusunu kullanıyordu — bu fonksiyon sapmıştı.
     * date_i18n fallback yalnız WP < 5.3 için korunur.
     */
    public static function format_date($iso) {
        $ts = strtotime((string) $iso);
        if (!$ts) return (string) $iso;
        $fmt = get_option('date_format') . ' H:i';
        return function_exists('wp_date') ? wp_date($fmt, $ts) : date_i18n($fmt, $ts);
    }

    /** (§8) held işaretini idempotent temizler. */
    private static function clear_held($order) {
        if ($order->get_meta('_wpteslimat_held_for_review') === 'yes') {
            $order->delete_meta_data('_wpteslimat_held_for_review');
            $order->save();
        }
    }

    private function status_message($status) {
        switch ($status) {
            case 'pending':   return __('Siparişiniz hazırlanıyor, stok bekleniyor.', 'wpteslimat');
            case 'partial':   return __('Siparişinizin bir kısmı teslim edildi, kalanı hazırlanıyor.', 'wpteslimat');
            case 'revoked':   return __('Bu sipariş iade/iptal edildi.', 'wpteslimat');
            case 'unmapped':  return __('Siparişiniz inceleniyor; kısa süre içinde hazırlanacak.', 'wpteslimat');
            default:          return __('Teslimat bilgisi yükleniyor.', 'wpteslimat');
        }
    }
}
