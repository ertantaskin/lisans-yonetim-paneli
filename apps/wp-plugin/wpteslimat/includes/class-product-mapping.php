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
    /** Zarf değiştiği için `_v2`: eski anahtarda düz dizi vardı, yeni kod onu okuyamazdı. */
    const CATALOG_CACHE_KEY = 'wpteslimat_catalog_v2';
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

    /**
     * Panelin `active` alanı — teslimatta kullanılıp kullanılmadığının TEK ölçütü.
     *
     * Alan HİÇ gelmiyorsa (alanı döndürmeyen ESKİ panel sürümü) AKTİF varsayılır: o sürümlerde
     * pasifleştirme özelliği zaten yoktu, yokluğu "pasif" saymak mevcut kurulumlarda yanlış
     * alarm üretirdi. Alan gelip false ise KESİN pasiftir.
     */
    private static function is_active($mapping) {
        if (!is_array($mapping)) return false;
        return !array_key_exists('active', $mapping) || !empty($mapping['active']);
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

        // 1) Bu Woo ürünü için panelde KAYITLI TÜM eşlemeler (ürün-seviyesi + varyasyon-özel).
        //    Sayfa render'ı içinde senkron: 5sn timeout (panel yavaşsa ürün ekranı asılmasın).
        $map_res = Wpteslimat_Panel_Client::get(
            '/v1/site-mappings?remoteProductId=' . rawurlencode((string) $remote_product_id),
            5
        );
        $map_ok  = isset($map_res['code']) && $map_res['code'] >= 200 && $map_res['code'] < 300;

        /*
         * PANELİN YETKİLİ ALANLARI (eklenti ince istemcidir → yeniden TÜRETMEZ, olduğu gibi okur):
         *
         * [a] `active` — teslimat çözümlemesi PASİF eşlemeyi YOK SAYAR: `products.service`
         *     `resolveMapping` her iki dalında da `active = true` şartını taşır. Bu kutu eskiden
         *     alanı HİÇ okumuyor ve koşulsuz "Eşli: X" basıyordu → operatör panelden eşlemeyi
         *     pasifleştirdiğinde mağaza ekranı hâlâ "eşli" diyor, gelen siparişler ise eşlenmemiş
         *     (pending) kalıyordu; mağaza tarafında SIFIR sinyal vardı.
         *
         * [b] `remoteVariationId` — çözümlemede varyasyon-özel eşleme ürün-seviyesinden
         *     ÖNCELİKLİDİR (`resolveMapping` 1. dal varyasyon, 2. dal fallback). Bu kutu ürün
         *     düzenleme ekranındadır ve YALNIZ ürün-seviyesi (varyasyonsuz) satırı yazar/siler —
         *     `ajax_save`/`ajax_delete` bilerek `remoteVariationId` GÖNDERMEZ.
         *
         *     Eski davranış sessiz YANLIŞ TESLİMAT üretiyordu: ürün-seviyesi satır yokken listedeki
         *     İLK VARYASYON satırı "mevcut eşleme" gibi gösteriliyordu; operatör seçimi değiştirip
         *     kaydedince panel AYRI bir ürün-seviyesi satır açıyor, varyasyon satırı olduğu gibi
         *     kalıyordu → kutu yeni ürünü gösterirken o varyasyonun siparişleri hâlâ ESKİ ürünü
         *     teslim ediyordu. "Kaldır" da yalnız varyasyonsuz satırı sildiği için sessiz no-op oluyordu.
         *
         *     KARAR (kapsam): varyasyon-özel eşlemeler burada SALT OKUNUR listelenir. Bu ekran
         *     WooCommerce varyasyon listesini taşımaz (varyasyonlar ayrı sekmede, ayrı ID'lerle) ve
         *     dar yan kutuda varyasyon başına yazma arayüzü kurmak, panelin /mappings ekranının
         *     (site kataloğu + varyasyon satırları + tek-tık eşleme) işini EKSİK kopyalamak olurdu.
         *     Kutu bunun yerine ne GÖSTERDİĞİNİ ve neyi DEĞİŞTİRDİĞİNİ açıkça söyler; varyasyon
         *     yönetimi panele yönlendirilir.
         */
        $level_map      = null; // ürün-seviyesi (varyasyonsuz) eşleme — bu kutunun yönettiği TEK satır
        $variation_maps = [];   // varyasyon-özel eşlemeler — salt okunur (yukarıdaki [b] kararı)
        if ($map_ok && isset($map_res['body']) && is_array($map_res['body'])) {
            foreach ($map_res['body'] as $m) {
                if (!is_array($m) || empty($m['productId'])) continue;
                $var = (isset($m['remoteVariationId']) && is_scalar($m['remoteVariationId']))
                    ? trim((string) $m['remoteVariationId'])
                    : '';
                // '0'/boş = "varyasyon yok" — panelin `resolveMapping` normalizasyonuyla BİREBİR aynı.
                if ($var === '' || $var === '0') {
                    // Panel listeyi (remoteProductId, id) sırasında döndürür; `resolveMapping` de
                    // (createdAt, id) ile "en eski"i seçer → İLK satır teslimatta kullanılan satırdır.
                    if ($level_map === null) $level_map = $m;
                } else {
                    $variation_maps[] = $m;
                }
            }
        }

        // 2) Panel ürün kataloğu (dropdown). Alınamazsa graceful — ekranı BLOKLAMA.
        //    (#15) Katalog SIR DEĞİL → kısa transient ile önbelleğe al: her ürün ekranı açılışında
        //    ikinci senkron panel çağrısı (5sn blok) yapılmaz. Mevcut-eşleme sorgusu (yukarıda,
        //    ürüne ÖZEL) önbeklenmez. Önbellek yoksa panelden çek; başarıysa cache'le. Panel
        //    erişilemezken önbellek de yoksa null → "Panel görünümü alınamadı" (mevcut graceful davranış).
        /*
         * `?meta=1` — KIRPMA SİNYALİ (panel denetim bulgusu). Panel katalog listesini 500 ürünle
         * sınırlıyor ve eskiden bunu SÖYLEMİYORDU: 500'den fazla panel ürünü olan bir kurulumda
         * aradığı ürünü dropdown'da bulamayan operatör hiçbir uyarı görmüyor, "panelde yok"
         * sanıyordu. Zarf OPT-IN (`{items, truncated, limit}`); eski düz-dizi biçimi de
         * okunmaya devam eder → panel ile eklenti farklı sürümlerde olsa da liste boşalmaz.
         *
         * ÖNBELLEK ANAHTARI DEĞİŞTİ (`_v2`): eski anahtar düz diziyi tutuyordu; yeni kod onu
         * okusaydı `items` bulunamaz ve liste SESSİZCE boşalırdı (bu projede tekrarlayan
         * "zarf değişti, okuyucu güncellenmedi" sınıfı).
         */
        $cached = get_transient(self::CATALOG_CACHE_KEY);
        $catalog = null;
        $truncated = false;
        if (is_array($cached) && isset($cached['items']) && is_array($cached['items'])) {
            $catalog = $cached['items'];
            $truncated = !empty($cached['truncated']);
        } else {
            $cat_res = Wpteslimat_Panel_Client::get('/v1/site-mappings/products?meta=1', 5);
            $cat_ok  = isset($cat_res['code']) && $cat_res['code'] >= 200 && $cat_res['code'] < 300;
            $body    = ($cat_ok && isset($cat_res['body'])) ? $cat_res['body'] : null;
            if (is_array($body) && isset($body['items']) && is_array($body['items'])) {
                $catalog   = $body['items'];
                $truncated = !empty($body['truncated']);
            } elseif (is_array($body)) {
                // Zarfı bilmeyen eski panel sürümü: düz dizi. Kırpma bilgisi YOK → iddia etme.
                $catalog = $body;
            }
            if (is_array($catalog)) {
                set_transient(
                    self::CATALOG_CACHE_KEY,
                    array('items' => $catalog, 'truncated' => $truncated),
                    self::CATALOG_CACHE_TTL
                );
            }
        }

        $current_pid = ($level_map && isset($level_map['productId'])) ? (string) $level_map['productId'] : '';
        $current_qty = ($level_map && isset($level_map['bundleQty'])) ? (int) $level_map['bundleQty'] : 1;
        if ($current_qty < 1) $current_qty = 1;
        $level_active = $level_map ? self::is_active($level_map) : false;

        $nonce = wp_create_nonce('wpteslimat_map');

        echo '<div class="wpteslimat-map" data-remote-product="' . esc_attr($remote_product_id)
            . '" data-nonce="' . esc_attr($nonce) . '">';

        // Mevcut ürün-seviyesi eşleme özeti.
        if (!$map_ok) {
            // DÜRÜSTLÜK: eşleme sorgusu başarısızken "Henüz eşlenmedi." basmak YANLIŞTI — panelde
            // eşleme DURUYOR olabilir; operatör "yok" sanıp ikinci bir eşleme kurabilir ya da
            // gerçekten eksik olan eşlemeyi fark etmez. Bilinmiyorsa bilinmiyor denir.
            echo '<p style="margin:0 0 8px"><em>'
                . esc_html__('Panel eşleme durumu alınamadı — mevcut eşleme gösterilemiyor.', 'wpteslimat')
                . '</em></p>';
        } elseif ($level_map) {
            $pname = isset($level_map['productName']) ? (string) $level_map['productName'] : '';
            $psku  = isset($level_map['productSku']) ? (string) $level_map['productSku'] : '';
            echo '<p style="margin:0 0 4px">';
            if ($level_active) {
                echo '<strong>' . esc_html__('Eşli:', 'wpteslimat') . '</strong> ';
            } else {
                echo '<strong style="color:#b32d2e">' . esc_html__('Eşleme PASİF:', 'wpteslimat') . '</strong> ';
            }
            echo esc_html($pname);
            if ($psku !== '') echo ' (' . esc_html($psku) . ')';
            // Terminoloji (§ sunum): panel yalnız "key" satmıyor (hesap/kod/özel ürün de var) ve
            // ham İngilizce sözcük operatöre çıkmamalı. Çeviri fonksiyonundan geçen tek metin.
            echo ' · ' . esc_html(sprintf(
                /* translators: %d: adet başına düşen panel kalemi sayısı */
                _n('%d kalem', '%d kalem', $current_qty, 'wpteslimat'),
                $current_qty
            )) . '</p>';
            if (!$level_active) {
                echo '<p style="margin:0 0 8px;color:#8a6d0b"><em>'
                    . esc_html__('Pasif eşleme teslimatta KULLANILMAZ — bu üründen gelen siparişler "eşlenmemiş" kalır. Aşağıdan "Kaydet" demek eşlemeyi yeniden etkinleştirir.', 'wpteslimat')
                    . '</em></p>';
            }
        } else {
            echo '<p style="margin:0 0 8px"><em>'
                . esc_html__('Ürün seviyesinde henüz eşlenmedi.', 'wpteslimat') . '</em></p>';
        }

        // Varyasyon-özel eşlemeler — SALT OKUNUR. Kutu bunları yazmaz/silmez ama teslimatta
        // ÖNCELİKLİ oldukları için gizlemek yanıltıcı olurdu (bkz. yukarıdaki [b] kararı).
        if (!empty($variation_maps)) {
            echo '<div style="margin:0 0 8px;padding:6px 8px;background:#fcf6e6;border:1px solid #f0dfa8;border-radius:3px">';
            echo '<p style="margin:0 0 4px"><strong>'
                . esc_html__('Varyasyon-özel eşlemeler (öncelikli)', 'wpteslimat') . '</strong></p>';
            echo '<ul style="margin:0 0 4px 18px;list-style:disc">';
            foreach ($variation_maps as $m) {
                $vid   = (isset($m['remoteVariationId']) && is_scalar($m['remoteVariationId']))
                    ? trim((string) $m['remoteVariationId'])
                    : '';
                $vname = isset($m['productName']) ? (string) $m['productName'] : '';
                $vsku  = isset($m['productSku']) ? (string) $m['productSku'] : '';
                echo '<li>#' . esc_html($vid) . ' → ' . esc_html($vname);
                if ($vsku !== '') echo ' (' . esc_html($vsku) . ')';
                if (!self::is_active($m)) {
                    echo ' — <span style="color:#b32d2e">' . esc_html__('pasif', 'wpteslimat') . '</span>';
                }
                echo '</li>';
            }
            echo '</ul>';
            echo '<p style="margin:0"><em>'
                . esc_html__('Bu kutu YALNIZ ürün seviyesi eşlemeyi değiştirir. Varyasyon-özel eşlemesi olan varyasyonun siparişleri o eşlemeyle teslim edilir; değiştirmek/kaldırmak için panelde "Ürün Eşleştirme" ekranını kullanın.', 'wpteslimat')
                . '</em></p>';
            echo '</div>';
        }

        if ($catalog === null) {
            // Katalog alınamadı: mevcut eşlemeyi (varsa yukarıda) gösterdik; yönetim yapılamıyor.
            echo '<p><em>' . esc_html__('Panel görünümü alınamadı.', 'wpteslimat') . '</em></p>';
            echo '</div>';
            return;
        }

        // Panel ürünü seçimi. Etiket AÇIKÇA "ürün seviyesi" der: kaydetme yolu varyasyon
        // GÖNDERMEZ (ajax_save), yani buradaki seçim varyasyon-özel eşlemeleri DEĞİŞTİRMEZ.
        echo '<p><label for="wpteslimat-map-pid"><strong>'
            . esc_html__('Panel ürünü (ürün seviyesi)', 'wpteslimat')
            . '</strong></label><br>';
        if ($truncated) {
            // SESSİZ KIRPMA YASAK: liste eksikse operatör "ürün panelde yok" sanmamalı.
            echo '<p style="color:#8a6d00;margin:.25em 0 .5em"><strong>'
                . esc_html__('Uyarı:', 'wpteslimat') . '</strong> '
                . esc_html__(
                    'Panelde bu listeye sığmayacak kadar çok ürün var — aşağıdaki liste EKSİK. '
                        . 'Aradığınız ürün görünmüyorsa eşlemeyi panelin Ürün Eşleştirme ekranından yapın.',
                    'wpteslimat'
                )
                . '</p>';
        }
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

        // Butonlar. "Kaldır" YALNIZ ürün-seviyesi satır GERÇEKTEN varsa gösterilir: silme çağrısı
        // varyasyon göndermediği için varyasyon satırı varken basılan düğme sessiz no-op olurdu
        // (panel 200 döner, hiçbir şey silinmez → operatör "kaldırdım" sanır).
        echo '<p style="margin-bottom:0">';
        echo '<button type="button" class="button button-primary wpteslimat-map-save">'
            . esc_html__('Kaydet', 'wpteslimat') . '</button>';
        if ($level_map) {
            echo ' <button type="button" class="button wpteslimat-map-delete" title="'
                . esc_attr__('Yalnız ürün seviyesi eşlemeyi kaldırır; varyasyon-özel eşlemeler etkilenmez.', 'wpteslimat')
                . '">' . esc_html__('Kaldır', 'wpteslimat') . '</button>';
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
                    if (!window.confirm('Bu ürünün ÜRÜN SEVİYESİ panel eşlemesi kaldırılsın mı? Varyasyon-özel eşlemeler etkilenmez.')) return;
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
        // BİLİNÇLİ: `remoteVariationId` GÖNDERİLMEZ → panel varyasyonsuz (ürün-seviyesi) satırda
        // upsert eder ve o satırı `active=true` yapar (pasifleştirilmiş eşleme yeniden etkinleşir).
        // Varyasyon-özel eşlemeler bu çağrıdan ETKİLENMEZ ve teslimatta ÖNCELİKLİ kalır — kutu
        // bunu artık ekranda da söyler (render()'daki [b] kararı).
        $res = Wpteslimat_Panel_Client::post('/v1/site-mappings', [
            'remoteProductId' => $rpid,
            'productId'       => $product_id,
            'bundleQty'       => $bundle_qty,
        ]);
        $this->relay($res);
    }

    public function ajax_delete() {
        $rpid = $this->guard();
        // BİLİNÇLİ: varyasyon göndermez → YALNIZ ürün-seviyesi satır silinir. Düğme de yalnız o
        // satır varken gösterilir (aksi halde panel 200 döner ama hiçbir şey silinmez).
        $res = Wpteslimat_Panel_Client::post('/v1/site-mappings/delete', [
            'remoteProductId' => $rpid,
        ]);
        $this->relay($res);
    }
}
