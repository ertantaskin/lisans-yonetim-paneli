<?php
if (!defined('ABSPATH')) exit;

/**
 * (§10) Mağaza ürün kataloğu senkronu — PROAKTİF eşleme için.
 *
 * Yayınlanmış WooCommerce ürünlerini (+ varyasyonları) panele TAM ANLIK GÖRÜNTÜ olarak push eder;
 * böylece operatör panelde ürünleri SİPARİŞ BEKLEMEDEN, ADIYLA eşleyebilir. Panel bu sitenin
 * kataloğunu siler+değiştirir (full snapshot). SIR GÖNDERMEZ — yalnız id/ad/sku/tip; fiyat, stok,
 * lisans, ödeme verisi TAŞINMAZ (ince istemci, §7).
 *
 * remoteProductId / remoteVariationId, order-sync collect_lines() ile BİREBİR aynı türetilir →
 * katalog satırı sipariş satırıyla eşleşir (eşleme sipariş anında çözülür):
 *   - Basit ürün → remoteProductId = ürün id,  remoteVariationId = null,          kind = simple
 *   - Varyasyonlu ürün:
 *       · PARENT satırı  → remoteProductId = parent id, remoteVariationId = null,  kind = variable
 *       · Her varyasyon  → remoteProductId = PARENT id, remoteVariationId = varyasyon id, kind = variation
 *
 * NOT (eşleşme garantisi): collect_lines() bir siparişteki varyasyon kalemi için
 *   remoteProductId = $product->get_parent_id()  (PARENT id)
 *   remoteVariationId = $product->get_id()        (varyasyon id)
 * gönderir; katalogdaki 'variation' satırları TAM AYNI çifti üretir → panel eşlemesi çözülür.
 * Basit üründe collect_lines get_parent_id() 0 döner → get_id()'e düşer; katalog da get_id() gönderir.
 */
class Wpteslimat_Catalog_Sync {
    private static $instance = null;

    /** Panel bir çağrıda en fazla 5000 ürün kabul eder (ürün + varyasyon satırları toplamı). */
    const MAX_PRODUCTS = 5000;

    /** Arka plan (Action Scheduler / wp-cron) tek-deduped senkron iş hook'u. */
    const SYNC_HOOK = 'wpteslimat_async_catalog_sync';

    /** Hızlı ard arda düzenlemeler tek push'ta birleşsin diye gecikme (saniye). */
    const SYNC_DELAY = 180; // 3 dk

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Manuel tetik (Ayarlar → "Ürünleri Panele Aktar").
        add_action('admin_post_wpteslimat_sync_catalog', [$this, 'handle_manual_sync']);

        // Otomatik senkron: ürün oluşturulunca/güncellenince/silinince tek gecikmeli push planla.
        // save_post_product yerine WooCommerce'in yüksek-seviye ürün hook'ları (varyasyon kaydını da kapsar).
        add_action('woocommerce_new_product', [$this, 'schedule_sync']);
        add_action('woocommerce_update_product', [$this, 'schedule_sync']);
        add_action('woocommerce_trash_product', [$this, 'schedule_sync']);

        // Arka plan iş işleyicisi (asıl panel çağrısı burada koşar; editör bloklanmaz).
        add_action(self::SYNC_HOOK, [$this, 'run_sync']);
    }

    /**
     * Otomatik senkronu ARKA PLANA ve TEK'e indirger: zaten bekleyen bir katalog senkronu varsa
     * yenisini eklemez → değişken bir üründe onlarca varyasyon kaydı tek push'ta birleşir. Editörü
     * ASLA senkron push ile bloklamaz. Yapılandırılmamış/klon ortamda hiç iş üretmez.
     *
     * $product_id kullanılmaz (full snapshot); yalnız hook imzası için kabul edilir.
     */
    public function schedule_sync($product_id = 0) {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;

        if (function_exists('as_schedule_single_action') && function_exists('as_next_scheduled_action')) {
            // Bekleyen katalog senkronu varsa yenisini planlama (dedupe).
            if (as_next_scheduled_action(self::SYNC_HOOK, null, 'wpteslimat')) {
                return;
            }
            as_schedule_single_action(time() + self::SYNC_DELAY, self::SYNC_HOOK, [], 'wpteslimat');
        } else {
            // Action Scheduler yok (nadir — WooCommerce onu taşır) → wp-cron tek olayı ile dedupe.
            // Yine ARKA PLAN (senkron push YOK) → editör bloklanmaz.
            if (!wp_next_scheduled(self::SYNC_HOOK)) {
                wp_schedule_single_event(time() + self::SYNC_DELAY, self::SYNC_HOOK);
            }
        }
    }

    /**
     * Arka plan iş işleyicisi: kataloğu toplar ve panele push eder. Yapılandırma/klon guard'ı burada
     * DA vardır (planlama ile çalışma arasında ortam değişebilir → çift savunma, order-sync deseni).
     */
    public function run_sync() {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;

        $products = $this->collect_products();
        if ($products === null) return; // WooCommerce yok → kataloğu YANLIŞLIKLA boşaltma.

        $res = Wpteslimat_Panel_Client::post('/v1/site-mappings/catalog', ['products' => $products]);
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        if ($code < 200 || $code >= 300) {
            // Arka plan — sessiz kalmasın ama sipariş akışını etkilemesin. Bir sonraki ürün
            // düzenlemesi yeniden planlar; kalıcı hata operatöre manuel "Ürünleri Panele Aktar"
            // butonundaki bildirimle görünür olur.
            error_log(sprintf('[wpteslimat] Katalog senkronu başarısız (HTTP %d).', $code));
        }
    }

    /**
     * Manuel tetik işleyicisi (Ayarlar → "Ürünleri Panele Aktar"). Yetki (manage_woocommerce) + nonce +
     * klon/yapılandırma guard; kataloğu toplayıp panele push eder ve sonucu bildirimle geri yönlendirir.
     */
    public function handle_manual_sync() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('Bu işlem için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }
        check_admin_referer('wpteslimat_sync_catalog');

        if (!Wpteslimat_Settings::is_configured()) {
            self::redirect('unconfigured');
        }
        // Klon/staging'den ASLA senkronlama (§7): klon panel kataloğunu ezmesin.
        if (Wpteslimat_Settings::is_clone()) {
            self::redirect('clone');
        }

        $products = $this->collect_products();
        if ($products === null) {
            self::redirect('error', __('WooCommerce bulunamadı.', 'wpteslimat'));
        }

        $res  = Wpteslimat_Panel_Client::post('/v1/site-mappings/catalog', ['products' => $products]);
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        if ($code >= 200 && $code < 300) {
            $synced = isset($res['body']['synced']) ? (int) $res['body']['synced'] : count($products);
            self::redirect('ok', (string) $synced);
        }
        // Panel gövde sınırı (1 MB) aşıldı → 413. Sessiz "HTTP 413" yerine anlamlı mesaj: katalog
        // çok büyük; operatör ürün/varyasyon sayısını azaltmalı ya da destekle görüşmeli.
        if ($code === 413) {
            self::redirect('error', sprintf(
                /* translators: %d: gönderilmeye çalışılan ürün+varyasyon satırı sayısı */
                __('Katalog çok büyük (%d ürün/varyasyon) — panel gövde sınırını aştı. Ürün sayısını azaltın veya destekle görüşün.', 'wpteslimat'),
                count($products)
            ));
        }
        $err = (isset($res['body']['error']) && $res['body']['error'] !== '')
            ? (string) $res['body']['error']
            : sprintf(__('HTTP %d', 'wpteslimat'), $code);
        self::redirect('error', $err);
    }

    /**
     * Yayınlanmış ürünlerden panel katalog satırlarını üretir. Bellek güvenli sayfalama (200'lük
     * partiler). Ürün + varyasyon satırları toplamı MAX_PRODUCTS'ta sınırlanır (aşılırsa loglanır).
     *
     * @return array|null Satır dizisi; WooCommerce yoksa null (çağıran push'u atlar → kataloğu boşaltmaz).
     */
    private function collect_products() {
        if (!function_exists('wc_get_products')) return null;

        $rows    = [];
        $page    = 1;
        $per_page = 200;
        $capped  = false;

        while (!$capped) {
            $products = wc_get_products([
                'status'  => 'publish',
                'limit'   => $per_page,
                'page'    => $page,
                'orderby' => 'ID',
                'order'   => 'ASC',
                'return'  => 'objects',
            ]);
            if (empty($products) || !is_array($products)) break;

            foreach ($products as $product) {
                if (!$product) continue;

                if ($product->is_type('variable')) {
                    // PARENT satırı (remoteVariationId = null). collect_lines varyasyon kaleminde
                    // get_parent_id() gönderir → burada da parent id.
                    $rows[] = $this->row(
                        (string) $product->get_id(),
                        null,
                        $product->get_name(),
                        $product->get_sku(),
                        'variable'
                    );
                    // Her varyasyon: remoteProductId = PARENT id, remoteVariationId = varyasyon id.
                    foreach ($product->get_children() as $vid) {
                        $variation = wc_get_product($vid);
                        if (!$variation) continue;
                        $rows[] = $this->row(
                            (string) $product->get_id(),   // PARENT id (collect_lines get_parent_id ile aynı)
                            (string) $variation->get_id(),  // varyasyon id (collect_lines get_id ile aynı)
                            $variation->get_name(),         // parent + öznitelikleri içerir
                            $variation->get_sku(),
                            'variation'
                        );
                    }
                } else {
                    // Basit (ve grouped/external gibi tekil tipler): tek satır. collect_lines'da
                    // get_parent_id() 0 → get_id()'e düşer; katalog da get_id() gönderir → eşleşir.
                    $rows[] = $this->row(
                        (string) $product->get_id(),
                        null,
                        $product->get_name(),
                        $product->get_sku(),
                        'simple'
                    );
                }

                // Sınır kontrolü ürün SINIRINDA (varyasyonlar tam eklendikten sonra) → tutarlı satırlar.
                if (count($rows) >= self::MAX_PRODUCTS) {
                    $capped = true;
                    break;
                }
            }

            if (count($products) < $per_page) break; // son sayfa
            $page++;
        }

        if ($capped) {
            if (count($rows) > self::MAX_PRODUCTS) {
                $rows = array_slice($rows, 0, self::MAX_PRODUCTS);
            }
            error_log(sprintf(
                '[wpteslimat] Katalog senkronu: satır sayısı %d sınırını aştı; katalog kesildi.',
                self::MAX_PRODUCTS
            ));
        }

        return $rows;
    }

    /** Tek katalog satırı üretir; ad 500, sku 120 karaktere kırpılır; boş sku → null. */
    private function row($product_id, $variation_id, $name, $sku, $kind) {
        $name = (string) $name;
        $sku  = ($sku === null) ? '' : (string) $sku;
        return [
            'remoteProductId'   => (string) $product_id,
            'remoteVariationId' => ($variation_id === null) ? null : (string) $variation_id,
            'name'              => self::truncate($name, 500),
            'sku'               => ($sku === '') ? null : self::truncate($sku, 120),
            'kind'              => $kind,
        ];
    }

    /** Çok-baytlı güvenli kırpma (mb_substr varsa). */
    private static function truncate($s, $max) {
        return function_exists('mb_substr') ? mb_substr($s, 0, $max) : substr($s, 0, $max);
    }

    /**
     * Ayarlar sayfasında "Ürün Kataloğu" bölümünü + sonuç bildirimini basar.
     * Settings::page() tarafından çağrılır (bağımlılık tersine değil — buton burada, sır YOK).
     */
    public static function render_settings_section() {
        // Sonuç bildirimi (redirect query arg üzerinden).
        if (isset($_GET['wpteslimat_catalog'])) {
            $flag = sanitize_key(wp_unslash($_GET['wpteslimat_catalog']));
            $msg  = isset($_GET['wpteslimat_msg']) ? sanitize_text_field(wp_unslash($_GET['wpteslimat_msg'])) : '';
            if ($flag === 'ok') {
                echo '<div class="notice notice-success is-dismissible"><p>' . esc_html(sprintf(
                    /* translators: %s: aktarılan ürün sayısı */
                    __('%s ürün panele aktarıldı.', 'wpteslimat'),
                    $msg !== '' ? $msg : '0'
                )) . '</p></div>';
            } elseif ($flag === 'error') {
                echo '<div class="notice notice-error is-dismissible"><p>' . esc_html(
                    $msg !== ''
                        ? sprintf(__('Ürünler panele aktarılamadı: %s', 'wpteslimat'), $msg)
                        : __('Ürünler panele aktarılamadı.', 'wpteslimat')
                ) . '</p></div>';
            } elseif ($flag === 'clone') {
                echo '<div class="notice notice-warning is-dismissible"><p>' .
                    esc_html__('Klon/staging koruması etkin — katalog panele aktarılmadı.', 'wpteslimat') . '</p></div>';
            } elseif ($flag === 'unconfigured') {
                echo '<div class="notice notice-error is-dismissible"><p>' .
                    esc_html__('Önce panele bağlanın; katalog aktarımı yapılandırma gerektirir.', 'wpteslimat') . '</p></div>';
            }
        }

        $configured = Wpteslimat_Settings::is_configured();
        $is_clone   = Wpteslimat_Settings::is_clone();
        ?>
        <hr>
        <h2><?php esc_html_e('Ürün Kataloğu', 'wpteslimat'); ?></h2>
        <p><?php esc_html_e('Mağazadaki yayınlanmış ürünleri (ve varyasyonlarını) panele aktarır; böylece panelde ürünleri sipariş beklemeden, adıyla proaktif olarak eşleyebilirsiniz. Yalnız ürün adı, SKU ve tip gönderilir — sır, fiyat veya lisans verisi gönderilmez. Tam anlık görüntüdür (panel bu sitenin kataloğunu değiştirir). Ürün eklendiğinde/güncellendiğinde/silindiğinde arka planda otomatik de senkronlanır.', 'wpteslimat'); ?></p>
        <?php if (!$configured): ?>
            <p><em><?php esc_html_e('Önce panele bağlanın.', 'wpteslimat'); ?></em></p>
        <?php elseif ($is_clone): ?>
            <p><em><?php esc_html_e('Klon/staging koruması etkin — bu sitede katalog aktarımı devre dışı.', 'wpteslimat'); ?></em></p>
        <?php else: ?>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="wpteslimat_sync_catalog">
                <?php wp_nonce_field('wpteslimat_sync_catalog'); ?>
                <?php submit_button(__('Ürünleri Panele Aktar', 'wpteslimat'), 'secondary', 'submit', false); ?>
            </form>
        <?php endif; ?>
        <?php
    }

    /** Ayar sayfasına sonuç bayrağıyla (ve varsa mesajla) geri yönlendirir (connect deseniyle simetrik). */
    private static function redirect($flag, $detail = '') {
        $url = add_query_arg('wpteslimat_catalog', $flag, admin_url('options-general.php?page=wpteslimat'));
        if ($detail !== '') {
            $url = add_query_arg('wpteslimat_msg', rawurlencode($detail), $url);
        }
        wp_safe_redirect($url);
        exit;
    }
}
