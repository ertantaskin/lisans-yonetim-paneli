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

        /*
         * §7 durum matrisi: suspended ('inceleme altında') ve expired-hidden ('süreniz doldu')
         * ATAMA-durum bayraklarından (order.status'a güvenmeden) çıkar — bunlar deliveries
         * listesinde görünmese de müşteriye açıklanmalı.
         *
         * KAPSAM DÜZELTMESİ: bu iki bant SİPARİŞ DÜZEYİNDE basılıyor ama koşul ATAMA
         * düzeyinde oluşuyordu. Windows anahtarı (süresiz) + Office 365 (365 gün) taşıyan bir
         * siparişte, bir yıl sonra sayfanın ÜSTÜNDE "Lisans sürenizin süresi doldu, tekrar
         * satın alın" yazarken hemen ALTINDA Windows anahtarı canlı duruyordu (aynısı askıya
         * almada). Panel `expiredProductNames` ile süre nedeniyle GİZLENEN atamaların ürün
         * adlarını döndürüyor → bant o ürünlerle sınırlandırılır. Alan YOKSA (admin/api ayrı
         * dağıtılır; dağıtım sapması olağandır) eski genel metne düşülür — hata verilmez.
         */
        $expired_names = self::string_list(isset($body['expiredProductNames']) ? $body['expiredProductNames'] : null);
        $has_live = !empty($deliveries);

        if ($suspended) {
            echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                esc_html(
                    // Ekranda hâlâ canlı lisans varsa "Lisansınız inceleme altında" cümlesi
                    // siparişin TAMAMINI kapsıyormuş gibi okunur → kapsamı daralt.
                    $has_live
                        ? __('Bu siparişteki bazı lisanslar şu an inceleme altında. İnceleme tamamlanınca burada tekrar görünür olacaktır.', 'wpteslimat')
                        : __('Lisansınız şu an inceleme altında. İnceleme tamamlanınca burada tekrar görünür olacaktır.', 'wpteslimat')
                ) .
                '</div>';
        }
        if ($expired_h) {
            if (!empty($expired_names)) {
                // Adet DEĞİL, ÜRÜN ADI yazılır: gelen liste tekilleştirilmiş ürün adlarıdır;
                // "N lisansın süresi doldu" demek yanlış bir sayı iddia etmek olurdu.
                $shown = array_slice($expired_names, 0, 6);
                $more  = count($expired_names) - count($shown);
                $names = implode(', ', $shown);
                if ($more > 0) {
                    $names .= ' ' . sprintf(
                        /* translators: %d = listede gösterilmeyen ürün adedi */
                        __('ve %d ürün daha', 'wpteslimat'),
                        $more
                    );
                }
                $msg = sprintf(
                    /* translators: %s = süresi dolan ürün adları */
                    __('Şu ürünlerin lisans süresi doldu: %s. Yeni bir lisans için mağazadan tekrar satın alabilir veya destek ekibimizle iletişime geçebilirsiniz.', 'wpteslimat'),
                    $names
                );
            } else {
                $msg = __('Lisans sürenizin süresi doldu. Yeni bir lisans için mağazadan tekrar satın alabilir veya destek ekibimizle iletişime geçebilirsiniz.', 'wpteslimat');
            }
            echo '<div class="woocommerce-info" role="status" style="margin-bottom:12px">' .
                esc_html($msg) . '</div>';
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

            /*
             * "Sorun Bildir" BOŞ/HATA dallarında da basılır.
             *
             * Buton yalnız teslimat DÖNGÜSÜNÜN İÇİNDE render ediliyordu → stok beklerken,
             * `unmapped`'ta, `revoked`'da, panel erişilemezken ve süre dolup lisans gizlendiğinde
             * ekranda HİÇBİR aksiyon kalmıyordu; üstelik bu dallardaki iki mesaj "destek
             * ekibimizle iletişime geçin" derken bir bağlantı vermiyordu (çıkmaz sokak). Panel
             * atamasız talebi ZATEN destekliyor (`assignmentId` opsiyonel) → boş atama kimliğiyle
             * tek bir buton yeter. Tüm boş dalları kapsasın diye blok SONUNDA, tek yerde basılır.
             */
            Wpteslimat_Report_Issue::render_button($order, '');
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
            $guides = self::guide_map($body);
            $this->print_styles();

            /*
             * ÜRÜN BAŞINA KART (§7 teslimat deneyimi). Eskiden tüm teslimatlar tek bir
             * `shop_table` içinde düz satırlar hâlinde basılıyordu: çok ürünlü siparişte
             * hangi anahtarın hangi ürüne ait olduğu ancak gri bir ara satırdan anlaşılıyor,
             * kurulum talimatı ise hiç yer almıyordu. Kart yapısı ürünü, anahtarlarını ve
             * o ürünün rehberini TEK bloğa toplar.
             */
            foreach ($groups as $group) {
                echo '<div class="wpt-card">';
                // Başlık YALNIZ kalem gerçekten çözülebildiğinde basılır; çözülemeyen satır (eski
                // teslimat, silinmiş/bilinmeyen kalem) başlıksız ESKİ davranışa düşer — asla fatal olmaz.
                if ($group['label'] !== '') {
                    /*
                     * (§11 MAK / çok kullanımlı) Sayaç YALNIZ KAYIT sayıyordu: MAK'ta qty=5 tek
                     * atamaya düşer (units=5) → müşteri kartında "1 lisans" yazarken sipariş
                     * kutusu "1 lisans (toplam 5 kullanım hakkı)", mail ise "(5 adet)" diyordu.
                     * Aynı veri üç yüzeyde üç farklı sayı → müşteri eksik teslimat sanıyordu.
                     * v1.0.7'de sipariş kutusu düzeltilmişti, MÜŞTERİ kartı atlanmıştı; artık
                     * sipariş kutusuyla BİREBİR aynı dil kullanılıyor. Tek kullanımlık üründe
                     * (tüm units=1) metin AYNEN eski hâlinde kalır — gereksiz gürültü eklenmez.
                     *
                     * MAK KAPISI: eski `units_total > rows_count` ölçütü, MAK siparişinin toplamı
                     * kayıt sayısına EŞİT olduğu durumda (ör. qty=1 → tek anahtardan 1 birim)
                     * hiçbir şey basmıyordu → müşteri paylaşımlı anahtarı sınırsız sanıyordu.
                     * Artık kalemlerden biri MAK ise toplam HER ZAMAN yazılır.
                     */
                    $rows_count  = count($group['rows']);
                    $units_total = 0;
                    $has_multi   = false;
                    foreach ($group['rows'] as $gr) {
                        $units_total += isset($gr[1]['units']) ? max(1, (int) $gr[1]['units']) : 1;
                        if (self::is_multi_usage($gr[1])) $has_multi = true;
                    }
                    // `_n()` KULLANILMIYOR: Türkçede sayıdan sonra çoğul eki gelmez ("3 lisans"),
                    // iki özdeş biçim yazmak çeviri dosyasına anlamsız bir çoğul kuralı sokardı.
                    $count_txt = sprintf(
                        /* translators: %d = bu üründe teslim edilen lisans kaydı adedi */
                        __('%d lisans', 'wpteslimat'),
                        $rows_count
                    );
                    if ($has_multi || $units_total > $rows_count) {
                        $count_txt .= ' ' . sprintf(
                            /* translators: %d = kayıtların taşıdığı toplam kullanım/aktivasyon hakkı */
                            __('(toplam %d kullanım hakkı)', 'wpteslimat'),
                            $units_total
                        );
                    }
                    echo '<div class="wpt-card__head">';
                    echo '<span class="wpt-card__title">' . esc_html($group['label']) . '</span>';
                    echo '<span class="wpt-card__count">' . esc_html($count_txt) . '</span>';
                    echo '</div>';
                }
                echo '<div class="wpt-card__body">';
                foreach ($group['rows'] as $row) {
                    list($i, $d) = $row;
                    echo '<div class="wpt-item">';
                    $is_account = isset($d['kind']) ? ($d['kind'] === 'account') : (!empty($d['fields']));
                    if ($is_account && !empty($d['fields']) && is_array($d['fields'])) {
                        echo '<div class="wpteslimat-fields">';
                        foreach ($d['fields'] as $fi => $f) {
                            $label  = isset($f['label']) ? $f['label'] : '';
                            $value  = isset($f['value']) ? $f['value'] : '';
                            $secret = !empty($f['secret']);
                            $fid = 'wpt-f-' . intval($i) . '-' . intval($fi);
                            echo '<div class="wpt-field">';
                            echo '<span class="wpt-field__label">' . esc_html($label) . '</span>';
                            echo '<span class="wpt-field__value">';
                            if ($secret) {
                                // §7 parola GÖSTER/GİZLE: gerçek değer data-attr'da; görünen varsayılan maskeli.
                                echo '<code id="' . esc_attr($fid) . '" class="wpt-code" data-secret="' . esc_attr($value) . '" data-shown="0">••••••••</code>';
                                echo '<button type="button" class="button button-small wpteslimat-toggle" data-target="' . esc_attr($fid) . '">' . esc_html__('Göster', 'wpteslimat') . '</button>';
                            } else {
                                echo '<code id="' . esc_attr($fid) . '" class="wpt-code">' . esc_html($value) . '</code>';
                            }
                            echo '<button type="button" class="button button-small wpteslimat-copy" data-target="' . esc_attr($fid) . '">' . esc_html__('Kopyala', 'wpteslimat') . '</button>';
                            echo '</span></div>';
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
                            echo '<div class="wpt-field__value">';
                            echo '<code id="' . esc_attr($id) . '" class="wpt-code wpt-code--key">' . esc_html($payload) . '</code>';
                            echo '<button type="button" class="button wpteslimat-copy" data-target="' . esc_attr($id) . '">' . esc_html__('Kopyala', 'wpteslimat') . '</button>';
                            echo '</div>';
                        }
                    }
                    // (§11 çok kullanımlı / MAK) Bir anahtar birden çok aktivasyon hakkı taşıyabilir.
                    // Kapı ve metin TEK KAYNAKTA (units_note): MAK'ta units=1 olsa bile basılır,
                    // çünkü paylaşımlı anahtarda "1" de anlamlı bilgidir (bkz. is_multi_usage notu).
                    $units_note = self::units_note($d, $is_account);
                    if ($units_note !== '') {
                        echo '<p class="wpt-note">' . esc_html($units_note) . '</p>';
                    }
                    if (!empty($d['validUntil'])) {
                        $exp = !empty($d['expired']);
                        echo '<p class="wpt-note' . ($exp ? ' wpt-note--warn' : '') . '">';
                        echo esc_html($exp ? __('Süresi doldu:', 'wpteslimat') : __('Geçerlilik:', 'wpteslimat'));
                        echo ' ' . esc_html(self::format_date($d['validUntil'])) . '</p>';
                    }
                    $assignment_id = isset($d['assignmentId']) ? $d['assignmentId'] : (isset($d['id']) ? $d['id'] : '');
                    Wpteslimat_Report_Issue::render_button($order, $assignment_id);
                    echo '</div>';
                }
                echo '</div>'; // .wpt-card__body

                /*
                 * §7 KURULUM / ETKİNLEŞTİRME REHBERİ — anahtarın hemen altında, o ürünün
                 * kartının içinde. Katlanır (`<details>`) çünkü çok ürünlü siparişte açık
                 * duran üç rehber sayfayı metin duvarına çevirir; tek ürünlü siparişte
                 * varsayılan AÇIK gelir (müşterinin arayacağı ilk şey odur).
                 *
                 * HTML paneldeki TEK render'dan gelir (packages/shared) ve burada `wp_kses`
                 * ile İKİNCİ kez süzülür: eklenti panelden gelen işaretlemeye körü körüne
                 * güvenmez (savunma derinliği — panel bir gün başka bir sürüme geçse bile
                 * mağaza sayfasına script giremez).
                 */
                $guide = self::guide_for_group($group, $guides);
                if ($guide !== null) {
                    $open = (count($groups) === 1) ? ' open' : '';
                    echo '<details class="wpt-guide"' . $open . '>';
                    echo '<summary class="wpt-guide__summary">' . esc_html(
                        $guide['title'] !== ''
                            ? $guide['title']
                            : __('Kurulum ve etkinleştirme rehberi', 'wpteslimat')
                    ) . '</summary>';
                    echo '<div class="wpt-guide__body">' . wp_kses($guide['html'], self::guide_allowed_html(), ['http', 'https']) . '</div>';
                    echo '</details>';
                }
                echo '</div>'; // .wpt-card
            }
        }

        /*
         * §13 DESTEK YAZIŞMASI — teslimat listesinin altında, her dalda (teslimat olsun olmasın).
         *
         * Operatör panelden "Ek bilgi iste" dediğinde müşteriye mail gidiyor ama müşterinin
         * CEVAP VERECEK hiçbir yolu yoktu: tek çıkış "Sorun Bildir"e tekrar basmaktı, o da YENİ
         * talep açıp 24 saatlik bütçeyi yiyordu ve eski talep sonsuza dek `info_requested`
         * kalıyordu. Blok kendi hatalarını içeride yutar (panel erişilemezse sayfa DÜŞMEZ).
         */
        Wpteslimat_Report_Issue::render_threads($order);

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

    /**
     * Panel yanıtındaki rehber listesini id → rehber haritasına çevirir (§7).
     *
     * Panel rehberi TEKRARSIZ gönderir ve teslimat kalemleri ona `guideId` ile bağlanır;
     * aynı rehber 10 anahtara bağlıysa metin bir kez taşınır. Alan HİÇ GELMEYEBİLİR
     * (eski panel sürümü / dağıtım sapması) → boş harita, ekran kırılmaz.
     */
    private static function guide_map($body) {
        $out = [];
        if (!isset($body['guides']) || !is_array($body['guides'])) return $out;
        foreach ($body['guides'] as $g) {
            if (!is_array($g) || empty($g['id'])) continue;
            $html = isset($g['html']) && is_scalar($g['html']) ? (string) $g['html'] : '';
            if (trim($html) === '') continue; // boş rehber = başlıksız boş kutu; hiç basma
            $out[(string) $g['id']] = [
                'title' => isset($g['title']) && is_scalar($g['title']) ? (string) $g['title'] : '',
                'html'  => $html,
                'text'  => isset($g['text']) && is_scalar($g['text']) ? (string) $g['text'] : '',
            ];
        }
        return $out;
    }

    /**
     * Bir ürün grubunun rehberi. Gruptaki tüm kayıtlar AYNI ürüne aittir, dolayısıyla aynı
     * rehberi taşır; yine de İLK boş olmayan kimlik aranır (bonus satırı gibi sentetik
     * kayıtlar teoride rehbersiz gelebilir — grup o yüzden rehbersiz sayılmamalı).
     */
    private static function guide_for_group($group, $guides) {
        if (empty($guides)) return null;
        foreach ($group['rows'] as $row) {
            $d = $row[1];
            $gid = (isset($d['guideId']) && is_scalar($d['guideId'])) ? (string) $d['guideId'] : '';
            if ($gid !== '' && isset($guides[$gid])) return $guides[$gid];
        }
        return null;
    }

    /**
     * Rehber HTML'i için izin verilen etiketler — panelin ürettiği kümenin ÜST KÜMESİ.
     *
     * Panel (packages/shared → renderGuideHtml) bugün yalnız şunları üretir:
     * h4 / p / br / strong / ol[start] / ul / li / a[href,target,rel].
     * Buradaki liste ayrıca `code` ve `em` içerir — panelde karşılığı YOKTUR (biçimleme
     * grameri `**kalın**` üretir, italik/kod yoktur). Güvenlik etkisi yok (ikisi de zararsız
     * satır-içi etiket) ama liste "BİREBİR aynı" DEĞİLDİR; bu yorum eskiden öyle diyordu ve
     * yanlış güvence veriyordu.
     *
     * Panel metni zaten kaçırıp yalnız kendi etiketlerini üretiyor; bu liste İKİNCİ savunma
     * hattıdır (üst küme olması o hattı zayıflatmaz — kses yine yalnız bu kümeyi geçirir).
     * Panele YENİ bir etiket eklenirse burası da güncellenmeli, aksi halde etiket sessizce
     * silinir (kses tanımadığını atar). Liste GENİŞLETİLMEZ — yalnız panelin ürettiği kadar.
     */
    private static function guide_allowed_html() {
        return [
            'h4'     => [],
            'p'      => [],
            'br'     => [],
            'strong' => [],
            'em'     => [],
            // `start`: paneldeki render, adımlar arasına boş satır konduğunda numaranın
            // 1'den yeniden başlamasını `start` ile engelliyor. İzin verilmezse kses onu
            // SESSİZCE siler ve müşteri "1. 1. 1." görür (panel doğru üretmiş olmasına rağmen).
            'ol'     => ['start' => []],
            'ul'     => [],
            'li'     => [],
            'code'   => [],
            'a'      => ['href' => [], 'target' => [], 'rel' => []],
        ];
    }

    /**
     * Teslimat kartlarının stili — sayfada BİR KEZ basılır (sipariş kutusundaki deseni izler).
     *
     * Renkler TEMA-NÖTR seçildi: sabit beyaz/siyah yerine yarı saydam gri katmanlar
     * (`rgba(128,128,128,…)`) kullanılıyor. Böylece hem açık hem koyu WooCommerce
     * temalarında okunur kalır — sabit `#f6f7f7` zemin koyu temada metni yutuyordu.
     */
    private function print_styles() {
        static $printed = false;
        if ($printed) return;
        $printed = true;
        ?>
        <style>
        .wpteslimat-deliveries .wpt-card{border:1px solid rgba(128,128,128,.32);border-radius:10px;margin:0 0 14px;overflow:hidden}
        .wpteslimat-deliveries .wpt-card__head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 14px;background:rgba(128,128,128,.10);border-bottom:1px solid rgba(128,128,128,.22)}
        .wpteslimat-deliveries .wpt-card__title{font-weight:600}
        .wpteslimat-deliveries .wpt-card__count{font-size:.85em;opacity:.75}
        .wpteslimat-deliveries .wpt-card__body{padding:4px 14px}
        .wpteslimat-deliveries .wpt-item{padding:10px 0}
        .wpteslimat-deliveries .wpt-item + .wpt-item{border-top:1px dashed rgba(128,128,128,.28)}
        .wpteslimat-deliveries .wpt-field{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:4px 0}
        .wpteslimat-deliveries .wpt-field__label{min-width:120px;font-weight:600;font-size:.92em}
        .wpteslimat-deliveries .wpt-field__value{display:flex;flex-wrap:wrap;align-items:center;gap:6px;min-width:0}
        /* Anahtar TAM görünmeli: kırpma yerine sarma (son haneler kalemi ayırt eden kısımdır). */
        .wpteslimat-deliveries .wpt-code{user-select:all;word-break:break-all;background:rgba(128,128,128,.14);border-radius:6px;padding:3px 8px;font-size:.95em}
        .wpteslimat-deliveries .wpt-code--key{font-size:1.02em;letter-spacing:.02em}
        .wpteslimat-deliveries .wpt-note{margin:4px 0 0;font-size:.85em;opacity:.8}
        /*
         * "Süresi doldu" vurgusu TEMA-NÖTR. Eskiden sabit `color:#b45309` idi: koyu zeminde
         * ≈3,7:1 kontrast veriyor, üstelik `.wpt-note`ın `.85em` puntosuyla birleşince
         * okunmuyordu. Renk artık temadan MİRAS ALINIR (currentColor) — ayrım kalınlık,
         * tam opaklık, biraz daha büyük punto ve yarı saydam gri katmanla yapılır. Yeni
         * sabit renk EKLENMEZ (kart stillerinin tema-nötr yaklaşımının aynısı).
         */
        .wpteslimat-deliveries .wpt-note--warn{opacity:1;font-size:.9em;font-weight:600;display:inline-block;background:rgba(128,128,128,.18);border-radius:6px;padding:2px 8px}
        .wpteslimat-deliveries .wpt-guide{border-top:1px solid rgba(128,128,128,.22);background:rgba(128,128,128,.05)}
        .wpteslimat-deliveries .wpt-guide__summary{cursor:pointer;padding:10px 14px;font-weight:600;font-size:.95em;list-style:none}
        .wpteslimat-deliveries .wpt-guide__summary::-webkit-details-marker{display:none}
        .wpteslimat-deliveries .wpt-guide__summary::before{content:"\203A";display:inline-block;margin-right:8px;transition:transform .15s}
        .wpteslimat-deliveries .wpt-guide[open] .wpt-guide__summary::before{transform:rotate(90deg)}
        .wpteslimat-deliveries .wpt-guide__body{padding:0 14px 12px;font-size:.95em;line-height:1.6}
        .wpteslimat-deliveries .wpt-guide__body ol,.wpteslimat-deliveries .wpt-guide__body ul{margin:.6em 0;padding-left:1.4em}
        .wpteslimat-deliveries .wpt-guide__body li{margin:.3em 0}
        .wpteslimat-deliveries .wpt-guide__body h4{margin:.8em 0 .3em;font-size:1em}
        @media (prefers-reduced-motion:reduce){.wpteslimat-deliveries .wpt-guide__summary::before{transition:none}}
        </style>
        <?php
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
        $guides = self::guide_map($body);

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
                // Ekranla AYNI kaynak (units_note): müşterinin SAKLADIĞI dosya, paylaşımlı anahtarın
                // kaç etkinleştirme taşıdığını ekranla aynı cümleyle söylemelidir — iki yüzey çelişemez.
                $units_note = self::units_note($d, $is_account);
                if ($units_note !== '') {
                    $lines[] = $units_note;
                }
                if (!empty($d['validUntil'])) {
                    // Ekranla AYNI ayrım: süresi DOLMUŞ lisans "Geçerlilik:" diye yazılırsa
                    // müşterinin SAKLADIĞI dosya ölü lisansı geçerliymiş gibi gösterir (ekran
                    // "Süresi doldu:" derken dosya tersini söylüyordu — iki yüzey çelişemez).
                    $lines[] = (!empty($d['expired'])
                        ? __('Süresi doldu:', 'wpteslimat')
                        : __('Geçerlilik:', 'wpteslimat')) . ' ' . self::format_date($d['validUntil']);
                }
                $lines[] = '';
            }

            /*
             * §7 kurulum rehberi — indirilen dosyaya da yazılır. Müşteri çoğu zaman bu .txt'yi
             * saklıyor ve yeniden kurulum gerektiğinde ona bakıyor; talimat yalnız web sayfasında
             * kalsaydı dosya tek başına işe yaramazdı. DÜZ METİN sürümü kullanılır (panel HTML'i
             * değil) — üç yüzey de aynı kaynaktan beslenir, ayrışamaz.
             */
            $guide = self::guide_for_group($group, $guides);
            if ($guide !== null && trim($guide['text']) !== '') {
                $lines[] = $guide['title'] !== ''
                    ? '--- ' . $guide['title'] . ' ---'
                    : '--- ' . __('Kurulum ve etkinleştirme rehberi', 'wpteslimat') . ' ---';
                $lines[] = $guide['text'];
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
     * Panel satır kimliğini (remoteLineId) Woo sipariş kalemine çözer.
     *
     * TEK KAYNAK ($origin): panel bonus satırının ait olduğu mağaza kalemini ZATEN çözer
     * (`resolveOriginRemoteLineId` → yanıtta `originRemoteLineId`) ve sipariş kutusu bu alanı
     * kullanır. Bu yüzey de alan GELDİĞİNDE onu kullanır — kural iki yerde ayrı ayrı
     * ayrıştırılmasın (aynı kuralın iki uygulaması bu projede defalarca sapma üretti).
     *
     * FALLBACK (aşağıdaki önek ayrıştırması) BUGÜN HÂLÂ ASIL YOLDUR: `/deliveries` ucu (bu ekranın
     * beslendiği uç) `originRemoteLineId` DÖNDÜRMEZ — alanı yalnız site-scoped `admin-view`
     * (sipariş kutusu) döndürür. Uç ileride alanı eklerse burası kendiliğinden yetkili değere
     * geçer; eklenmezse davranış AYNEN korunur. Eşleşen biçimler:
     *   - "<item_id>"              → normal sipariş kalemi
     *   - "bonus:<item_id>:<uuid>" → o kaleme eklenen sentetik bonus satırı (panel bonusAssign)
     * Çözülemezse '' → çağıran BAŞLIKSIZ (eski) davranışa düşer; asla fatal olmaz.
     */
    private static function resolve_item_id($remote_line_id, $item_names, $origin = null) {
        $origin = is_scalar($origin) ? (string) $origin : '';
        if ($origin !== '') return isset($item_names[$origin]) ? $origin : '';

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
            // Panel yetkili orijin kalemini döndürdüyse onu kullan (bkz. resolve_item_id notu);
            // döndürmezse yerel önek ayrıştırmasına düşülür.
            $origin = isset($d['originRemoteLineId']) ? $d['originRemoteLineId'] : null;
            $item_id = self::resolve_item_id($line_id, $item_names, $origin);
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
     * Bu teslimat kalemi ÇOK KULLANIMLI (MAK) bir üründen mi geliyor?
     *
     * NEDEN GEREKLİ: birim bilgisi eskiden YALNIZ `units > 1` iken basılıyordu. MAK'ta tek bir
     * sipariş satırı birden çok anahtara bölünebilir (ölçülen gerçek sipariş: qty=6 → A
     * anahtarından 5 birim + B anahtarından 1 birim). B satırı `units=1` olduğu için hiçbir
     * açıklama almıyordu → müşteri o anahtarın TAMAMEN kendisine ait olduğunu sanıyor, oysa
     * yalnız 1 etkinleştirme hakkı var (anahtar başka müşterilerle PAYLAŞIMLI). Bu sessiz hata
     * ancak ürünün kullanım kipi bilinerek kapanır: MAK'ta "1" de anlamlı bilgidir.
     *
     * GERİYE DÖNÜK UYUM: `usageMode` panelin EKLEMELİ yeni alanıdır. Eski panel imajı (dağıtım
     * sapması) onu döndürmez → burada `false` döner ve çağıran taraf ESKİ `units > 1` kapısına
     * düşer. Yani alan gelmezse davranış bugünküyle birebir aynıdır (sessiz kırılma yok).
     */
    private static function is_multi_usage($d) {
        return isset($d['usageMode']) && $d['usageMode'] === 'multi';
    }

    /**
     * Bir teslimat kaleminin birim (kullanım hakkı) notu — boş dize = not basma.
     *
     * TEK KAYNAK: aynı cümle hem ekranda hem indirilen .txt'de kullanılır. İki yüzeyde ayrı ayrı
     * yazılsaydı biri güncellenip diğeri geride kalırdı (bu projede tekrarlayan hata sınıfı).
     *
     * Kapı: MAK ise HER ZAMAN (units=1 dahil) · aksi hâlde yalnız `units > 1` (eski davranış;
     * `usageMode` gelmeyen eski panel sürümünde tek geçerli sinyal budur). Tek kullanımlık üründe
     * `units` zaten hep 1'dir → hiçbir şey basılmaz, gereksiz gürültü eklenmez.
     */
    private static function units_note($d, $is_account) {
        $units = isset($d['units']) ? max(1, (int) $d['units']) : 1;
        // Panel AÇIKÇA 'single' diyorsa metin BASILMAZ — ürünün modu yetkilidir, `units`
        // sayısı değil. (Panelin mail tarafındaki `unitLabel` kuralıyla BİREBİR aynı: iki
        // yüzey aynı kalemi farklı anlatamaz.) Tek kullanımlıkta units zaten daima 1'dir;
        // bir gün olmazsa da müşteriye "anahtar paylaşımlıdır" demek YANLIŞ olurdu.
        if (isset($d['usageMode']) && $d['usageMode'] === 'single') {
            return '';
        }
        if (!self::is_multi_usage($d) && $units < 2) {
            return '';
        }
        // Metin KİPE göre değil TÜRE göre seçilir (tek dizge/tür → çeviri sapması olmaz):
        // `units > 1` yalnız MAK ürününde oluşabildiği için `usageMode` gelmeyen eski panelde de
        // aynı cümle doğrudur.
        $msg = $is_account
            /* translators: %d = bu siparişin bu hesapta kullanabileceği etkinleştirme adedi */
            ? __('Bu hesap %d kullanım/aktivasyon hakkı içerir.', 'wpteslimat')
            /* translators: %d = bu siparişin bu anahtarda kullanabileceği etkinleştirme adedi */
            // "BU SİPARİŞTE" → "BU ANAHTARDA": panel artık ürün bazında "her birimi ayrı
            // anahtardan ver" politikasını destekliyor. O politikada müşteri birden çok satır
            // görür ve her satırda "bu siparişte 1 hak" yazsaydı "toplam 1 hak mı var?" diye
            // okunurdu. Hakkın sahibi sipariş değil ANAHTARDIR. (Panelin mail tarafındaki
            // `unitLabel` ile BİREBİR aynı cümle — iki yüzey aynı kalemi farklı anlatamaz.)
            : __('Bu anahtarda %d etkinleştirme hakkınız var (anahtar paylaşımlıdır — yalnız bu kadar kez etkinleştirebilirsiniz).', 'wpteslimat');
        return sprintf($msg, $units);
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
            /*
             * 'revoked' İADE İDDİA ETMEZ.
             *
             * Bu durum yalnız iade/iptalde değil, İNCELEME REDDİNDE de oluşur (§8): ödeme
             * alınmıştır, WooCommerce siparişi hâlâ "İşleniyor" görünür. Eski metin ("Bu sipariş
             * iade/iptal edildi.") müşteriyi olmayan bir para iadesini beklemeye itiyordu.
             * Doğru olan tek şey lisansların geri alındığıdır; ticari sonucu (iade yapıldıysa)
             * müşteri WooCommerce'in KENDİ sipariş durumundan zaten görür. Destek yolu hemen
             * altındaki "Sorun Bildir" ile verilir.
             */
            case 'revoked':   return __('Bu siparişteki lisanslar geri alındı ve artık kullanılamıyor. Sorunuz varsa aşağıdan destek ekibimize yazabilirsiniz.', 'wpteslimat');
            case 'unmapped':  return __('Siparişiniz inceleniyor; kısa süre içinde hazırlanacak.', 'wpteslimat');
            default:          return __('Teslimat bilgisi yükleniyor.', 'wpteslimat');
        }
    }

    /**
     * Panelden gelen serbest dizinin güvenli string listesi (boşlar elenir, tekilleştirilir).
     * Alan hiç gelmeyebilir (dağıtım sapması) → boş dizi; çağıran eski metne düşer.
     *
     * @return array<int, string>
     */
    private static function string_list($raw) {
        if (!is_array($raw)) return [];
        $out = [];
        foreach ($raw as $v) {
            if (!is_scalar($v)) continue;
            $v = trim((string) $v);
            if ($v !== '') $out[] = $v;
        }
        return array_values(array_unique($out));
    }
}
