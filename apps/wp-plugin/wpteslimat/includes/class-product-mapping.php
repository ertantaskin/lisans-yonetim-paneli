<?php
if (!defined('ABSPATH')) exit;

/**
 * (§7) WooCommerce ÜRÜN düzenleme ekranında "Panel Eşlemesi" meta box.
 *
 * Woo ürününü (remoteProductId = post ID) panel ürün kataloğundaki bir ürüne (uuid) eşler.
 * Operatör, ürünü panele gitmeden bu kutudan eşleyebilir. Site-scoped uçlar HMAC ile imzalanır;
 * panel her eşlemenin çağıran siteye ait olduğunu doğrular. Lisans verisi / sır GÖSTERİLMEZ —
 * yalnız katalog metası (ad/sku/tür) + eşleme sayaçları.
 *
 * Güvenlik modeli (metabox deseniyle aynı):
 *  - Yazma AJAX → panele SİTE HMAC secret'iyle (panel-client) gider; yetki manage_woocommerce.
 *  - Klon/staging koruması: is_clone() ise kutu pasif + AJAX 403 (canlı eşlemeye dokunulmaz).
 *  - Panel yavaş/erişilemez → 5sn timeout + graceful mesaj; ürün ekranı BLOKLANMAZ.
 */
class Wpteslimat_Product_Mapping {
    private static $instance = null;

    /**
     * (#15) Panel ürün kataloğu (ad/sku/tür — SIR DEĞİL) kısa önbellek anahtarı + TTL.
     * Her ürün düzenleme ekranı açılışında panele ikinci senkron çağrı (5sn blok) yapılmasını önler.
     * "Cache yok — sır" kuralı yalnız gizli payload içindir; katalog metası için geçerli değildir.
     */
    const CATALOG_CACHE_KEY = 'wpteslimat_catalog';
    const CATALOG_CACHE_TTL = 90; // saniye

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('add_meta_boxes', [$this, 'add']);
        // Eşleme yazma AJAX uçları (yalnız oturum açmış = wp_ajax_, nopriv YOK).
        add_action('wp_ajax_wpteslimat_map_save', [$this, 'ajax_save']);
        add_action('wp_ajax_wpteslimat_map_delete', [$this, 'ajax_delete']);
    }

    public function add() {
        add_meta_box(
            'wpteslimat_mapping',
            __('Panel Eşlemesi', 'wpteslimat'),
            [$this, 'render'],
            'product',
            'side',
            'default'
        );
    }

    /** Panel ürün türünü (kind) Türkçeleştir (ham enum kullanıcıya çıkmaz). */
    private static function kind_label($kind) {
        switch ($kind) {
            case 'key':     return __('Anahtar', 'wpteslimat');
            case 'account': return __('Hesap', 'wpteslimat');
            case 'code':    return __('Kod', 'wpteslimat');
            case 'custom':  return __('Özel', 'wpteslimat');
            default:        return __('Diğer', 'wpteslimat');
        }
    }

    /** Eşleme yönetimi: mağaza yöneticisi + admin (manage_woocommerce). */
    private static function can_manage() {
        return current_user_can('manage_woocommerce');
    }

    public function render($post) {
        if (!$post || !isset($post->ID)) return;

        // (#16) Yazma yolundaki (guard()) yetki ile simetrik: yalnız manage_woocommerce yetkilisi
        // eşleme kutusunu görsün. Yalnız edit_products yetkili editöre işlevsiz kutu + panel
        // kataloğunun (ad/sku/tür) gereksiz ifşası olmasın.
        if (!self::can_manage()) return;

        if (!Wpteslimat_Settings::is_configured()) {
            echo '<p><em>' . esc_html__('Önce eklentiyi yapılandırın.', 'wpteslimat') . '</em></p>';
            echo '<p><a href="' . esc_url(admin_url('options-general.php?page=wpteslimat')) . '">'
                . esc_html__('Ayarlar', 'wpteslimat') . '</a></p>';
            return;
        }
        if (Wpteslimat_Settings::is_clone()) {
            echo '<p><em>' . esc_html__('Bu ortam (klon/staging) eşleme yönetemez.', 'wpteslimat') . '</em></p>';
            return;
        }

        $remote_product_id = (int) $post->ID;

        // 1) Bu Woo ürünü için MEVCUT eşleme (ürün-seviyesi = varyasyonsuz tercih edilir).
        //    Sayfa render'ı içinde senkron: 5sn timeout (panel yavaşsa ürün ekranı asılmasın).
        $map_res = Wpteslimat_Panel_Client::get(
            '/v1/site-mappings?remoteProductId=' . rawurlencode((string) $remote_product_id),
            5
        );
        $map_ok  = isset($map_res['code']) && $map_res['code'] >= 200 && $map_res['code'] < 300;
        $current = null;
        if ($map_ok && isset($map_res['body']) && is_array($map_res['body'])) {
            foreach ($map_res['body'] as $m) {
                if (!is_array($m) || empty($m['productId'])) continue;
                $var = isset($m['remoteVariationId']) ? $m['remoteVariationId'] : null;
                // Ürün-seviyesi (varyasyonsuz) eşlemeyi seç.
                if ($var === null || $var === '' || (int) $var === 0) {
                    $current = $m;
                    break;
                }
                // İlk (varyasyonlu olsa da) eşlemeyi gösterim için yedekte tut.
                if ($current === null) $current = $m;
            }
        }

        // 2) Panel ürün kataloğu (dropdown). Alınamazsa graceful — ekranı BLOKLAMA.
        //    (#15) Katalog SIR DEĞİL → kısa transient ile önbelleğe al: her ürün ekranı açılışında
        //    ikinci senkron panel çağrısı (5sn blok) yapılmaz. Mevcut-eşleme sorgusu (yukarıda,
        //    ürüne ÖZEL) önbeklenmez. Önbellek yoksa panelden çek; başarıysa cache'le. Panel
        //    erişilemezken önbellek de yoksa null → "Panel görünümü alınamadı" (mevcut graceful davranış).
        $catalog = get_transient(self::CATALOG_CACHE_KEY);
        if (!is_array($catalog)) {
            $cat_res = Wpteslimat_Panel_Client::get('/v1/site-mappings/products', 5);
            $cat_ok  = isset($cat_res['code']) && $cat_res['code'] >= 200 && $cat_res['code'] < 300;
            $catalog = ($cat_ok && isset($cat_res['body']) && is_array($cat_res['body'])) ? $cat_res['body'] : null;
            if (is_array($catalog)) {
                set_transient(self::CATALOG_CACHE_KEY, $catalog, self::CATALOG_CACHE_TTL);
            }
        }

        $current_pid = ($current && isset($current['productId'])) ? (string) $current['productId'] : '';
        $current_qty = ($current && isset($current['bundleQty'])) ? (int) $current['bundleQty'] : 1;
        if ($current_qty < 1) $current_qty = 1;

        $nonce = wp_create_nonce('wpteslimat_map');

        echo '<div class="wpteslimat-map" data-remote-product="' . esc_attr($remote_product_id)
            . '" data-nonce="' . esc_attr($nonce) . '">';

        // Mevcut eşleme özeti.
        if ($current) {
            $pname = isset($current['productName']) ? (string) $current['productName'] : '';
            $psku  = isset($current['productSku']) ? (string) $current['productSku'] : '';
            echo '<p style="margin:0 0 8px"><strong>' . esc_html__('Eşli:', 'wpteslimat') . '</strong> '
                . esc_html($pname);
            if ($psku !== '') echo ' (' . esc_html($psku) . ')';
            // Terminoloji (§ sunum): panel yalnız "key" satmıyor (hesap/kod/özel ürün de var) ve
            // ham İngilizce sözcük operatöre çıkmamalı. Çeviri fonksiyonundan geçen tek metin.
            echo ' · ' . esc_html(sprintf(
                /* translators: %d: adet başına düşen panel kalemi sayısı */
                _n('%d kalem', '%d kalem', $current_qty, 'wpteslimat'),
                $current_qty
            )) . '</p>';
        } else {
            echo '<p style="margin:0 0 8px"><em>' . esc_html__('Henüz eşlenmedi.', 'wpteslimat') . '</em></p>';
        }

        if ($catalog === null) {
            // Katalog alınamadı: mevcut eşlemeyi (varsa yukarıda) gösterdik; yönetim yapılamıyor.
            echo '<p><em>' . esc_html__('Panel görünümü alınamadı.', 'wpteslimat') . '</em></p>';
            echo '</div>';
            return;
        }

        // Panel ürünü seçimi.
        echo '<p><label for="wpteslimat-map-pid"><strong>' . esc_html__('Panel ürünü', 'wpteslimat')
            . '</strong></label><br>';
        echo '<select id="wpteslimat-map-pid" class="wpteslimat-map-pid" style="width:100%">';
        echo '<option value="">' . esc_html__('— Seçin —', 'wpteslimat') . '</option>';
        foreach ($catalog as $p) {
            if (!is_array($p) || empty($p['id'])) continue;
            $pid  = (string) $p['id'];
            $name = isset($p['name']) ? (string) $p['name'] : '';
            $sku  = isset($p['sku']) ? (string) $p['sku'] : '';
            $kind = isset($p['kind']) ? (string) $p['kind'] : '';
            $text = $name;
            if ($sku !== '')  $text .= ' — ' . $sku;
            if ($kind !== '') $text .= ' (' . self::kind_label($kind) . ')';
            echo '<option value="' . esc_attr($pid) . '"' . selected($pid, $current_pid, false) . '>'
                . esc_html($text) . '</option>';
        }
        echo '</select></p>';

        // Adet başına panel kalemi (bundleQty). Etiketler platform-bağımsız + Türkçe: panel
        // WooCommerce'e sabit değildir ("Woo" yerine "mağaza") ve kalem her zaman anahtar değildir.
        echo '<p><label for="wpteslimat-map-qty"><strong>' . esc_html__('Adet başına kalem', 'wpteslimat')
            . '</strong></label><br>';
        echo '<input type="number" id="wpteslimat-map-qty" class="wpteslimat-map-qty" min="1" step="1" value="'
            . esc_attr($current_qty) . '" style="width:80px">';
        echo '<br><small>' . esc_html__('Mağazadaki 1 adet, panelde kaç kaleme (anahtar/hesap/kod) denk gelir (varsayılan 1).', 'wpteslimat')
            . '</small></p>';

        // Butonlar.
        echo '<p style="margin-bottom:0">';
        echo '<button type="button" class="button button-primary wpteslimat-map-save">'
            . esc_html__('Kaydet', 'wpteslimat') . '</button>';
        if ($current) {
            echo ' <button type="button" class="button wpteslimat-map-delete">'
                . esc_html__('Kaldır', 'wpteslimat') . '</button>';
        }
        echo '</p>';

        echo '</div>';
        $this->print_script();
    }

    /** Eşleme kutusu JS'i — delegated click; her aksiyon panele AJAX ile gider. */
    private function print_script() {
        static $printed = false;
        if ($printed) return;
        $printed = true;
        ?>
        <script>
        (function () {
            var box = document.querySelector('.wpteslimat-map');
            if (!box) return;
            var remote = box.getAttribute('data-remote-product');
            var nonce = box.getAttribute('data-nonce');

            function post(action, extra, done) {
                var fd = new FormData();
                fd.append('action', action);
                fd.append('nonce', nonce);
                fd.append('remote_product_id', remote);
                for (var k in extra) fd.append(k, extra[k]);
                fetch(ajaxurl, { method: 'POST', credentials: 'same-origin', body: fd })
                    .then(function (r) { return r.json().catch(function () { return { success: false, data: { message: 'Geçersiz yanıt' } }; }); })
                    .then(function (j) { done(j); })
                    .catch(function () { done({ success: false, data: { message: 'Ağ hatası' } }); });
            }

            function fail(j) {
                var m = (j && j.data && j.data.message) ? j.data.message : 'İşlem başarısız';
                window.alert(m);
            }

            box.addEventListener('click', function (e) {
                var saveBtn = e.target.closest('.wpteslimat-map-save');
                if (saveBtn) {
                    e.preventDefault();
                    if (saveBtn.disabled) return;
                    var pidEl = box.querySelector('.wpteslimat-map-pid');
                    var qtyEl = box.querySelector('.wpteslimat-map-qty');
                    var pid = pidEl ? pidEl.value : '';
                    var qty = qtyEl ? qtyEl.value : '1';
                    if (!pid) { window.alert('Lütfen bir panel ürünü seçin.'); return; }
                    saveBtn.disabled = true;
                    post('wpteslimat_map_save', { product_id: pid, bundle_qty: qty }, function (j) {
                        if (!j || !j.success) { saveBtn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }

                var delBtn = e.target.closest('.wpteslimat-map-delete');
                if (delBtn) {
                    e.preventDefault();
                    if (delBtn.disabled) return;
                    if (!window.confirm('Bu ürünün panel eşlemesi kaldırılsın mı?')) return;
                    delBtn.disabled = true;
                    post('wpteslimat_map_delete', {}, function (j) {
                        if (!j || !j.success) { delBtn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }
            });

            function escapeHtml(s) {
                return String(s).replace(/[&<>"']/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
                });
            }
        })();
        </script>
        <?php
    }

    // ─── AJAX işleyicileri (§7) — nonce + capability + is_clone; panele site-HMAC ile ───────

    /** Ortak ön-kontrol: nonce + yetki + klon guard + geçerli ürün id. Woo ürün id'sini (string) döner. */
    private function guard() {
        check_ajax_referer('wpteslimat_map', 'nonce');
        if (!self::can_manage()) {
            wp_send_json_error(['message' => 'Bu işlem için yetkiniz yok.'], 403);
        }
        if (Wpteslimat_Settings::is_clone()) {
            wp_send_json_error(['message' => 'Klon/staging ortamında işlem yapılamaz.'], 403);
        }
        $rpid = isset($_POST['remote_product_id']) ? absint(wp_unslash($_POST['remote_product_id'])) : 0;
        if ($rpid <= 0) {
            wp_send_json_error(['message' => 'Geçersiz ürün.'], 400);
        }
        return (string) $rpid;
    }

    /**
     * Panel yanıtını istemciye ilet (2xx → success, aksi → error + okunur mesaj).
     *
     * Hata metni sipariş kutusundaki TEK kaynaktan (`Wpteslimat_Admin_Metabox::error_message`)
     * üretilir. Buradaki eski kopya `$body['message']`'i HAM iletiyordu; oysa Nest doğrulama
     * hatasında bu alan DİZİ döner (["productId must be a UUID", …]) ve dizi `alert()`'e verilince
     * operatör parçalı/anlamsız metin görüyordu. Ayrıca ağ hatasında (code=0) panel istemcisi
     * gövdeye WP_Error'ın ham İngilizce metnini koyar — ortak fonksiyon bunu da Türkçeye çevirir.
     */
    private function relay($res) {
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        if ($code >= 200 && $code < 300) {
            wp_send_json_success($body);
        }
        wp_send_json_error([
            'message' => Wpteslimat_Admin_Metabox::error_message($code, $body),
            'code'    => $code,
        ], 200);
    }

    public function ajax_save() {
        $rpid = $this->guard();
        $product_id = isset($_POST['product_id']) ? sanitize_text_field(wp_unslash($_POST['product_id'])) : '';
        $bundle_qty = isset($_POST['bundle_qty']) ? absint(wp_unslash($_POST['bundle_qty'])) : 1;
        if ($bundle_qty < 1) $bundle_qty = 1;
        if ($product_id === '') {
            wp_send_json_error(['message' => 'Panel ürünü seçilmedi.'], 400);
        }
        $res = Wpteslimat_Panel_Client::post('/v1/site-mappings', [
            'remoteProductId' => $rpid,
            'productId'       => $product_id,
            'bundleQty'       => $bundle_qty,
        ]);
        $this->relay($res);
    }

    public function ajax_delete() {
        $rpid = $this->guard();
        $res = Wpteslimat_Panel_Client::post('/v1/site-mappings/delete', [
            'remoteProductId' => $rpid,
        ]);
        $this->relay($res);
    }
}
