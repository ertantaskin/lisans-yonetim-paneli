<?php
if (!defined('ABSPATH')) exit;

/**
 * (#33) Sipariş listesi (shop_order) panel-durum kolonu + toplu-aksiyon.
 *
 * Kolon: order meta `_wpteslimat_panel_status` (+ fulfilled/total) okunup gösterilir.
 * Toplu-aksiyon "Panel durumunu güncelle": seçili siparişler için
 *   POST /v1/orders/bulk-status { remoteOrderIds: [...] }  (HMAC imzalı)
 * çağrılır; dönen [{ remoteOrderId, status, fulfilled, total }] her siparişin
 * meta'sına yazılır (kolon bunu okur). Payload/sır GÖSTERİLMEZ — yalnız durum sayaçları.
 *
 * Klasik (posts) + HPOS (custom orders table) list table'larının ikisi de desteklenir.
 */
class Wpteslimat_Order_List {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Klasik posts tablosu (shop_order).
        add_filter('manage_edit-shop_order_columns', [$this, 'add_column']);
        add_action('manage_shop_order_posts_custom_column', [$this, 'render_column_classic'], 10, 2);
        add_filter('bulk_actions-edit-shop_order', [$this, 'add_bulk_action']);
        add_filter('handle_bulk_actions-edit-shop_order', [$this, 'handle_bulk'], 10, 3);

        // HPOS (custom orders table).
        add_filter('woocommerce_shop_order_list_table_columns', [$this, 'add_column']);
        add_action('woocommerce_shop_order_list_table_custom_column', [$this, 'render_column_hpos'], 10, 2);
        add_filter('bulk_actions-woocommerce_page_wc-orders', [$this, 'add_bulk_action']);
        add_filter('handle_bulk_actions-woocommerce_page_wc-orders', [$this, 'handle_bulk'], 10, 3);

        // Panel-durum filtresi (dropdown + sorgu) — klasik posts + HPOS.
        add_action('restrict_manage_posts', [$this, 'render_status_filter_classic']);
        add_action('pre_get_posts', [$this, 'filter_query_classic']);
        add_action('woocommerce_order_list_table_restrict_manage_orders', [$this, 'render_status_filter_hpos']);
        add_filter('woocommerce_order_list_table_prepare_items_query_args', [$this, 'filter_query_hpos']);

        add_action('admin_notices', [$this, 'bulk_notice']);
    }

    /** Panel Durumu kolonunu (varsa) sipariş durumundan hemen sonra ekler. */
    public function add_column($columns) {
        $new = [];
        foreach ($columns as $key => $label) {
            $new[$key] = $label;
            if ($key === 'order_status') {
                $new['wpteslimat_panel_status'] = __('Panel Durumu', 'wpteslimat');
            }
        }
        if (!isset($new['wpteslimat_panel_status'])) {
            $new['wpteslimat_panel_status'] = __('Panel Durumu', 'wpteslimat');
        }
        return $new;
    }

    /** Klasik render: ($column, $post_id). */
    public function render_column_classic($column, $post_id) {
        if ($column !== 'wpteslimat_panel_status') return;
        $order = wc_get_order($post_id);
        if ($order) $this->render_cell($order);
    }

    /** HPOS render: ($column, $order). */
    public function render_column_hpos($column, $order) {
        if ($column !== 'wpteslimat_panel_status') return;
        $this->render_cell($order);
    }

    /** Hücre içeriği — yalnız durum + teslim sayacı (payload YOK). */
    private function render_cell($order) {
        if (!is_a($order, 'WC_Order')) return;
        // Panel-poll meta'sı (`_wpteslimat_panel_status`) YALNIZ manuel toplu-poll ile yazılır ve
        // teslim sayaçlarını (fulfilled/total) taşır. Ancak gerçek-zamanlı geri-kanal webhook'lar
        // `_wpteslimat_status`'a yazar → poll'suz kolon bayat kalırdı. Poll verisini TERCİH et,
        // yoksa webhook-güdümlü `_wpteslimat_status`'a düş (metabox uzlaştırmasını aynalar).
        $panel_status = $order->get_meta('_wpteslimat_panel_status');
        $has_poll = !($panel_status === '' || $panel_status === null);
        $status = $has_poll ? $panel_status : $order->get_meta('_wpteslimat_status');
        if ($status === '' || $status === null) {
            // Henüz sorgulanmadı ve webhook durumu da yok; panele iletilip iletilmediğini göster.
            $pushed = $order->get_meta('_wpteslimat_pushed') === 'yes';
            echo $pushed
                ? '<span style="color:#888">' . esc_html__('sorgulanmadı', 'wpteslimat') . '</span>'
                : '<span style="color:#bbb">&mdash;</span>';
            return;
        }
        echo '<span>' . esc_html(self::status_label($status)) . '</span>';
        // Teslim sayacı YALNIZ panel-poll verisi varken anlamlı (webhook durumu sayaç taşımaz).
        if ($has_poll) {
            $fulfilled = (int) $order->get_meta('_wpteslimat_panel_fulfilled');
            $total     = (int) $order->get_meta('_wpteslimat_panel_total');
            if ($total > 0) {
                echo ' <small>(' . intval($fulfilled) . '/' . intval($total) . ')</small>';
            }
        }
    }

    /**
     * Panel durum kodu → sade Türkçe etiket. Ham enum (fulfilled/held/…) operatöre ÇIKMAZ;
     * sözlükte olmayan bir durum gelirse teknik kod yerine nötr "Bilinmiyor" gösterilir.
     */
    private static function status_label($status) {
        switch ($status) {
            case 'fulfilled': return __('Teslim edildi', 'wpteslimat');
            case 'partial':   return __('Kısmi', 'wpteslimat');
            case 'pending':   return __('Bekliyor', 'wpteslimat');
            case 'revoked':   return __('İptal', 'wpteslimat');
            case 'expired':   return __('Süresi doldu', 'wpteslimat');
            case 'unmapped':  return __('Eşlemesiz', 'wpteslimat');
            case 'held':      return __('İncelemede', 'wpteslimat');
            default:          return __('Bilinmiyor', 'wpteslimat');
        }
    }

    /** Toplu-aksiyon menüsüne "panel durumunu güncelle" ekle. */
    public function add_bulk_action($actions) {
        $actions['wpteslimat_refresh_status'] = __('Panel durumunu güncelle', 'wpteslimat');
        return $actions;
    }

    /**
     * Toplu-aksiyon işleyici. Nonce doğrulaması WP list table tarafından (bulk-* referer)
     * bu filtre çağrılmadan önce yapılır; ayrıca yetki kontrolü ekliyoruz.
     * @param string $redirect  Yönlendirme URL'i (query arg ile geri döner).
     * @param string $action    Seçilen bulk aksiyon.
     * @param int[]  $ids        Seçili sipariş id'leri.
     */
    public function handle_bulk($redirect, $action, $ids) {
        if ($action !== 'wpteslimat_refresh_status') return $redirect;
        if (!current_user_can('edit_shop_orders') && !current_user_can('manage_woocommerce')) {
            return $redirect;
        }
        if (!Wpteslimat_Settings::is_configured()) {
            return add_query_arg('wpteslimat_bulk', 'notconfigured', $redirect);
        }
        // (§7 klon/staging) Klon ortam CANLI panele hiç istek atmamalı ve yerel meta'yı canlı
        // veriyle güncellememeli (bayat/yanıltıcı durum + gereksiz canlı yük). Diğer panel
        // yollarıyla aynı guard — sessiz değil, operatöre dürüst bildirim.
        if (Wpteslimat_Settings::is_clone()) {
            return add_query_arg('wpteslimat_bulk', 'clone', $redirect);
        }

        $ids = array_values(array_filter(array_map('absint', (array) $ids)));
        if (empty($ids)) return $redirect;

        $remote_ids = array_map('strval', $ids);

        // (#11) Panel bulk-status şeması TEK istekte en fazla 100 remoteOrderId kabul eder;
        // >100 seçimde tüm istek 400 döner ve HİÇBİR sipariş güncellenmez. 100'lük parçalara böl,
        // her parçayı ayrı çağır, güncellenen sayısını birleştir (kolon/held-clear mantığı korunur).
        $updated = 0;
        foreach (array_chunk($remote_ids, 100) as $chunk) {
            $res = Wpteslimat_Panel_Client::post('/v1/orders/bulk-status', [
                'remoteOrderIds' => $chunk,
            ]);
            $ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
            if (!$ok || empty($res['body']) || !is_array($res['body'])) continue;
            // Yanıt düz dizi [{...}] ya da { results: [{...}] } olabilir — ikisini de karşıla.
            $rows = (isset($res['body']['results']) && is_array($res['body']['results']))
                ? $res['body']['results']
                : $res['body'];
            if (!is_array($rows)) continue;
            foreach ($rows as $row) {
                if (!is_array($row) || empty($row['remoteOrderId'])) continue;
                $oid = absint($row['remoteOrderId']);
                $order = $oid ? wc_get_order($oid) : null;
                if (!$order) continue;
                // (§8) Panel YETKİLİ `held` bayrağını bulk-status'ta ayrı alan olarak döndürür
                // (durum kolonu held siparişte 'pending' der). Operatör için ANLAMLI bilgi
                // "incelemede"dir → kolona 'held' yazılır. Bayrak hiç gelmiyorsa (eski panel
                // sürümü) ham duruma dokunulmaz. Bu satır olmadan status_label('held') dalı
                // ERİŞİLEMEZ kalıyor, inceleme rozeti listede HİÇ görünmüyordu (denetim bulgusu).
                $held = array_key_exists('held', $row) ? !empty($row['held']) : null;
                $status = isset($row['status']) ? sanitize_text_field((string) $row['status']) : '';
                if ($held === true) $status = 'held';
                $order->update_meta_data('_wpteslimat_panel_status', $status);
                $order->update_meta_data('_wpteslimat_panel_fulfilled',
                    isset($row['fulfilled']) ? (int) $row['fulfilled'] : 0);
                $order->update_meta_data('_wpteslimat_panel_total',
                    isset($row['total']) ? (int) $row['total'] : 0);
                // Yerel "inceleme bekliyor" işaretini panele göre eşitle (panel tek doğruluk kaynağı):
                // true → işaretle (metabox/my-account rozeti görünsün), false → bayat işareti TEMİZLE
                // (release/reject sonrası rozet düşsün; rejectHeld webhook atmaz, aksi halde meta
                // sipariş tek tek açılana dek 'yes' kalırdı).
                if ($held === true) {
                    if ($order->get_meta('_wpteslimat_held_for_review') !== 'yes') {
                        $order->update_meta_data('_wpteslimat_held_for_review', 'yes');
                    }
                } elseif ($held === false && $order->get_meta('_wpteslimat_held_for_review') === 'yes') {
                    $order->delete_meta_data('_wpteslimat_held_for_review');
                }
                $order->save();
                $updated++;
            }
        }

        return add_query_arg([
            'wpteslimat_bulk'   => $updated > 0 ? 'ok' : 'error',
            'wpteslimat_bulk_n' => $updated,
        ], $redirect);
    }

    // ─── Panel-durum filtresi (dropdown + sorgu) ───────────────────────────────

    /** Filtrenin izin verdiği panel-durum enum'u (whitelist) → Türkçe etiket. */
    private static function pstatus_options() {
        return [
            'unmapped'  => __('Eşlemesiz', 'wpteslimat'),
            'pending'   => __('Bekleyen', 'wpteslimat'),
            // Teslimat öncesi ayrı durum (§8 inceleme kuyruğu): handle_bulk panelin `held`
            // bayrağını 'held' olarak yazar → operatör "onay bekleyen" siparişleri süzebilir.
            'held'      => __('İncelemede', 'wpteslimat'),
            'partial'   => __('Kısmi', 'wpteslimat'),
            'fulfilled' => __('Teslim edildi', 'wpteslimat'),
            'revoked'   => __('İptal', 'wpteslimat'),
        ];
    }

    /** URL'deki filtre değerini whitelist'le; geçersizse '' (enum dışı değer yok sayılır). */
    private static function current_pstatus_filter() {
        if (!isset($_GET['wpteslimat_pstatus'])) return '';
        $val = sanitize_key(wp_unslash($_GET['wpteslimat_pstatus']));
        return array_key_exists($val, self::pstatus_options()) ? $val : '';
    }

    /** Ortak <select> dropdown'ı (klasik + HPOS). Ekran zaten yetkili (sipariş listesi). */
    private function render_status_dropdown() {
        $current = self::current_pstatus_filter();
        echo '<select name="wpteslimat_pstatus">';
        echo '<option value="">' . esc_html__('Panel durumu (tümü)', 'wpteslimat') . '</option>';
        foreach (self::pstatus_options() as $val => $label) {
            echo '<option value="' . esc_attr($val) . '"' . selected($current, $val, false) . '>'
                . esc_html($label) . '</option>';
        }
        echo '</select>';
    }

    /** Klasik (posts) shop_order liste ekranında dropdown'ı çizer. */
    public function render_status_filter_classic($post_type = '') {
        global $typenow;
        $pt = $post_type !== '' ? $post_type : $typenow;
        if ($pt !== 'shop_order') return;
        $this->render_status_dropdown();
    }

    /** HPOS sipariş liste ekranında dropdown'ı çizer. */
    public function render_status_filter_hpos($order_type = '') {
        // Aksiyon 'shop_order' tipiyle çağrılır; başka tip verilirse çizme (savunmacı).
        if ($order_type !== '' && $order_type !== 'shop_order') return;
        $this->render_status_dropdown();
    }

    /**
     * Klasik ana sorguya `_wpteslimat_panel_status = <val>` meta filtresi ekler.
     * Mevcut meta_query EZİLMEZ — yeni koşul AND ile eklenir.
     */
    public function filter_query_classic($query) {
        if (!is_admin()) return;
        if (!method_exists($query, 'is_main_query') || !$query->is_main_query()) return;
        if ($query->get('post_type') !== 'shop_order') return;
        $val = self::current_pstatus_filter();
        if ($val === '') return;
        $meta_query = $query->get('meta_query');
        if (!is_array($meta_query)) $meta_query = [];
        $meta_query[] = [
            'key'     => '_wpteslimat_panel_status',
            'value'   => $val,
            'compare' => '=',
        ];
        $query->set('meta_query', $meta_query);
    }

    /**
     * HPOS sorgu argümanlarına aynı meta filtresini ekler. HPOS OrdersTableQuery/wc_get_orders
     * meta_query'yi destekler; DESTEKLEMEZSE bu anahtar sessizce yok sayılır (graceful no-op,
     * hata YOK) — bu durumda filtre uygulanmaz ama ekran çalışmaya devam eder.
     */
    public function filter_query_hpos($query_args) {
        if (!is_array($query_args)) return $query_args;
        $val = self::current_pstatus_filter();
        if ($val === '') return $query_args;
        $meta_query = (isset($query_args['meta_query']) && is_array($query_args['meta_query']))
            ? $query_args['meta_query'] : [];
        $meta_query[] = [
            'key'     => '_wpteslimat_panel_status',
            'value'   => $val,
            'compare' => '=',
        ];
        $query_args['meta_query'] = $meta_query;
        return $query_args;
    }

    /** Toplu-aksiyon sonrası admin bildirimi. */
    public function bulk_notice() {
        if (!isset($_GET['wpteslimat_bulk'])) return;
        $flag = sanitize_key(wp_unslash($_GET['wpteslimat_bulk']));
        $n = isset($_GET['wpteslimat_bulk_n']) ? absint($_GET['wpteslimat_bulk_n']) : 0;
        if ($flag === 'ok') {
            echo '<div class="notice notice-success is-dismissible"><p>' .
                esc_html(sprintf(__('%d siparişin panel durumu güncellendi.', 'wpteslimat'), $n)) .
                '</p></div>';
        } elseif ($flag === 'notconfigured') {
            echo '<div class="notice notice-warning is-dismissible"><p>' .
                esc_html__('Teslimat paneli yapılandırılmadığı için panel durumu güncellenemedi.', 'wpteslimat') .
                '</p></div>';
        } elseif ($flag === 'clone') {
            echo '<div class="notice notice-warning is-dismissible"><p>' .
                esc_html__('Klon/staging koruması etkin — panel durumu bu ortamda güncellenmez.', 'wpteslimat') .
                '</p></div>';
        } elseif ($flag === 'error') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html__('Panel durumu güncellenemedi. Lütfen daha sonra tekrar deneyin.', 'wpteslimat') .
                '</p></div>';
        }
    }
}
