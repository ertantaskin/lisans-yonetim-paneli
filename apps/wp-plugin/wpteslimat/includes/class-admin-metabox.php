<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş ekranı lisans katmanı (§7) — ÜRÜN-BAĞLAMLI OPERASYON.
 *
 * Lisanslar ARTIK sağdaki metabox'ta uzun bir liste olarak DEĞİL, her ürünün KENDİ sipariş
 * kalemi (order line item) altında gösterilir (`woocommerce_after_order_itemmeta`). Böylece
 * birden çok farklı ürün alınan siparişte her ürünün anahtarları + o ürüne özel aksiyonları
 * (Göster/Değiştir/Askıya al/+1 Bonus) kendi satırının altında, bağlamında görünür.
 *
 * Sağdaki ince metabox yalnız SİPARİŞ-SEVİYESİ bilgileri taşır: durum + inceleme rozeti +
 * "Tekrar Mail" + (varsa) hiçbir güncel kaleme bağlanamayan atamalar.
 *
 * Güvenlik: tüm aksiyonlar AJAX → panele SİTE HMAC secret'ıyla; panel her hedefin çağıran siteye
 * ait olduğunu doğrular (çapraz-site 404) + audit'e wp:kullanıcı@site. reveal YALNIZ manage_options
 * (shop_manager açamaz, §7 rol→scope); diğerleri manage_woocommerce. is_clone → tüm aksiyonlar 403.
 * Panele giden admin-view TEK sefer çekilir (memoize); render içi senkron → 5sn timeout.
 */
class Wpteslimat_Admin_Metabox {
    private static $instance = null;
    /** order_id => admin-view dizisi | null (iletilmedi/klon/hata). */
    private static $view_cache = [];
    /** Script için hatırlanan sipariş (Woo id). */
    private static $script_order = null;
    private static $script_printed = false;
    /** Sipariş ekranı lisans stilleri bir kez basılır (ilk render). */
    private static $styles_printed = false;

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('add_meta_boxes', [$this, 'add'], 30, 2);
        // Ürün-bağlamlı render: her sipariş kalemi meta'sından sonra o satırın lisansları + aksiyonları.
        add_action('woocommerce_after_order_itemmeta', [$this, 'render_line'], 10, 3);
        // Aksiyon JS'i sayfada bir kez (footer'da — DOM hazır).
        add_action('admin_footer', [$this, 'print_script']);
        // AJAX uçları (yalnız oturum açmış = wp_ajax_).
        add_action('wp_ajax_wpteslimat_mb_reveal', [$this, 'ajax_reveal']);
        add_action('wp_ajax_wpteslimat_mb_replace', [$this, 'ajax_replace']);
        add_action('wp_ajax_wpteslimat_mb_suspend', [$this, 'ajax_suspend']);
        add_action('wp_ajax_wpteslimat_mb_bonus', [$this, 'ajax_bonus']);
        add_action('wp_ajax_wpteslimat_mb_resend', [$this, 'ajax_resend']);
    }

    public function add($post_type, $post) {
        $screen = class_exists('\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController')
            && function_exists('wc_get_page_screen_id')
            ? wc_get_page_screen_id('shop-order')
            : 'shop_order';
        add_meta_box('wpteslimat_deliveries', 'Lisans — Sipariş Özeti', [$this, 'render_side'], $screen, 'side', 'high');
    }

    /** Panel mask formatıyla hizalı: sabit gövde + son 4 hane. */
    private static function mask($value) {
        $value = (string) $value;
        return strlen($value) <= 4 ? '••••••' : '••••••' . substr($value, -4);
    }

    /** Yalnız administrator (manage_options) loglu reveal (§7 shop_manager açamaz). */
    private static function can_reveal() { return current_user_can('manage_options'); }
    /** Değiştir/askıya al/bonus/tekrar-mail: manage_woocommerce. */
    private static function can_operate() { return current_user_can('manage_woocommerce'); }

    private static function asg_status_label($s) {
        switch ($s) {
            case 'active':    return 'Aktif';
            case 'suspended': return 'Askıda';
            case 'revoked':   return 'İptal';
            case 'expired':   return 'Süresi doldu';
            case 'replaced':  return 'Değiştirildi';
            default:          return $s;
        }
    }

    private static function order_status_label($s) {
        switch ($s) {
            case 'pending':   return 'Bekliyor';
            case 'partial':   return 'Kısmi teslim';
            case 'fulfilled': return 'Tamamlandı';
            case 'revoked':   return 'İptal';
            case 'held':      return 'İncelemede';
            default:          return $s ?: 'bilinmiyor';
        }
    }

    /**
     * Sipariş için panel admin-view'ini TEK sefer çeker (memoize). Klon/iletilmemiş/hata → null.
     * Panel remoteOrderId = Woo sipariş id'si (push'ta böyle gönderilir).
     */
    private function get_view($order) {
        if (!is_a($order, 'WC_Order')) return null;
        $oid = $order->get_id();
        if (array_key_exists($oid, self::$view_cache)) return self::$view_cache[$oid];

        if (Wpteslimat_Settings::is_clone()) { self::$view_cache[$oid] = null; return null; }
        if (!$order->get_meta('_wpteslimat_order_id')) { self::$view_cache[$oid] = null; return null; }

        $res = Wpteslimat_Panel_Client::get('/v1/orders/' . rawurlencode($oid) . '/admin-view', 5);
        $ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        $view = ($ok && isset($res['body']) && is_array($res['body'])) ? $res['body'] : null;
        self::$view_cache[$oid] = $view;
        if ($view !== null) self::$script_order = (string) $oid; // JS bu siparişe kilitlenir
        return $view;
    }

    /** Bu atamalar bu Woo kalemine mi ait? remoteLineId == item_id VEYA bonus:<item_id>:… */
    private static function assignments_for_line($view, $item_id) {
        $out = [];
        $items = (isset($view['assignments']) && is_array($view['assignments'])) ? $view['assignments'] : [];
        $needle = 'bonus:' . $item_id . ':';
        foreach ($items as $a) {
            $rl = isset($a['remoteLineId']) ? (string) $a['remoteLineId'] : '';
            if ($rl === (string) $item_id || strpos($rl, $needle) === 0) {
                $out[] = $a;
            }
        }
        return $out;
    }

    /** Durum → renkli pill CSS sınıfı (bilinmeyen → nötr). */
    private static function pill_class($status) {
        $known = ['active', 'suspended', 'revoked', 'expired', 'replaced'];
        return 'wpt-pill--' . (in_array($status, $known, true) ? $status : 'replaced');
    }

    /**
     * Sipariş ekranı lisans katmanı stilleri — sayfada BİR kez (ilk render_line/render_side).
     * Sınıf tabanlı (satır-içi stil dağınıklığı yok); hover/durum renkleri, kaydırma, buton hiyerarşisi.
     * WP admin dashicons her zaman kayıtlı → ikonlar ek yükleme gerektirmez.
     */
    private static function maybe_print_styles() {
        if (self::$styles_printed) return;
        self::$styles_printed = true;
        ?>
        <style id="wpteslimat-mb-styles">
        .wpt-line{margin:8px 0 2px;border:1px solid #dcdcde;border-radius:6px;background:#fff;overflow:hidden;font-size:13px;line-height:1.5}
        .wpt-line-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;background:#f6f7f7;border-bottom:1px solid #f0f0f1}
        .wpt-line-head__title{display:inline-flex;align-items:center;gap:6px;font-weight:600;color:#1d2327;font-size:12px}
        .wpt-line-head__title .dashicons{font-size:16px;width:16px;height:16px;color:#787c82}
        .wpt-line-head__count{font-size:11px;color:#646970;white-space:nowrap}
        .wpt-keys{list-style:none;margin:0;padding:0}
        .wpt-keys--scroll{max-height:232px;overflow-y:auto}
        .wpt-key{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:8px 10px;border-top:1px solid #f0f0f1}
        .wpt-keys>.wpt-key:first-child{border-top:0}
        .wpt-key__main{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:1 1 200px;min-width:0}
        .wpt-key__val{min-width:0}
        .wpt-key__val code{display:inline-block;background:#f0f6fc;border:1px solid #dae4ee;border-radius:4px;padding:2px 7px;font-size:12px;color:#0a4b78;word-break:break-all}
        .wpt-key__val>div{margin:1px 0}
        .wpt-key__actions{display:flex;gap:5px;flex-wrap:wrap}
        .wpt-pill{display:inline-flex;align-items:center;font-size:11px;font-weight:600;line-height:1;padding:3px 8px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
        .wpt-pill--active{background:#edfaef;color:#0a7d2c;border-color:#b8e6c4}
        .wpt-pill--suspended{background:#fcf6e6;color:#8a6d0b;border-color:#f0dfa8}
        .wpt-pill--revoked,.wpt-pill--expired{background:#fcf0f1;color:#b32d2e;border-color:#f2c7c9}
        .wpt-pill--replaced{background:#f0f0f1;color:#646970;border-color:#dcdcde}
        .wpt-meta{font-size:11px;color:#646970;white-space:nowrap}
        .wpt-meta--bonus{color:#2271b1;font-weight:600}
        .wpt-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font-size:12px;line-height:1.7;border:1px solid #c3c4c7;border-radius:4px;background:#fff;color:#2c3338;cursor:pointer;transition:background .1s,border-color .1s,color .1s}
        .wpt-btn .dashicons{font-size:14px;width:14px;height:14px;line-height:1}
        .wpt-btn:hover{background:#f6f7f7;border-color:#8c8f94}
        .wpt-btn:disabled{opacity:.55;cursor:default}
        .wpt-btn--replace:hover{border-color:#2271b1;color:#2271b1;background:#f0f6fc}
        .wpt-btn--suspend .dashicons{color:#996800}
        .wpt-btn--suspend:hover{border-color:#dba617;background:#fcf9e8;color:#8a6d0b}
        .wpt-btn--resume .dashicons{color:#0a7d2c}
        .wpt-btn--resume:hover{border-color:#00a32a;background:#edfaef;color:#0a7d2c}
        .wpt-btn.is-done{background:#edfaef;border-color:#b8e6c4;color:#0a7d2c}
        .wpt-btn.is-done .dashicons{color:#0a7d2c}
        .wpt-line-foot{display:flex;justify-content:flex-end;padding:7px 10px;background:#fbfbfc;border-top:1px solid #f0f0f1}
        .wpt-btn--bonus{border-color:#2271b1;color:#2271b1;background:#f0f6fc;font-weight:500}
        .wpt-btn--bonus:hover{background:#2271b1;color:#fff;border-color:#2271b1}
        .wpt-btn--bonus:hover .dashicons{color:#fff}
        .wpt-empty{padding:12px 10px;font-size:12px;color:#787c82;text-align:center}
        .wpt-history{border-top:1px solid #f0f0f1;background:#fbfbfc}
        .wpt-history>summary{padding:6px 10px;font-size:11px;color:#646970;cursor:pointer}
        .wpt-history ul{margin:0;padding:0 10px 8px 26px;font-size:11px;color:#646970}
        .wpt-history li{margin:2px 0}
        .wpt-history code{background:#f0f0f1;border-radius:3px;padding:0 4px}
        .wpt-side-status{display:inline-flex;align-items:center;font-size:11px;font-weight:600;line-height:1;padding:3px 9px;border-radius:999px;border:1px solid #dcdcde;background:#f6f7f7;color:#3c434a}
        </style>
        <?php
    }

    /** Tek atama satırı (maskeli değer + durum pill + key-bazlı aksiyonlar). */
    private static function render_asg_row($a, $can_reveal, $can_op) {
        $aid = isset($a['id']) ? (string) $a['id'] : '';
        if ($aid === '') return;
        $status = isset($a['status']) ? (string) $a['status'] : '';
        $is_active = ($status === 'active');
        $is_suspended = ($status === 'suspended');
        $is_bonus = isset($a['remoteLineId']) && strpos((string) $a['remoteLineId'], 'bonus:') === 0;
        $is_account = isset($a['kind']) ? ($a['kind'] === 'account') : (!empty($a['maskedFields']));

        echo '<li class="wpteslimat-asg-row wpt-key" data-assignment="' . esc_attr($aid) . '">';

        // Sol blok: değer + durum pill + meta çipleri.
        echo '<div class="wpt-key__main">';
        echo '<div class="wpteslimat-val wpt-key__val">';
        if ($is_account && !empty($a['maskedFields']) && is_array($a['maskedFields'])) {
            foreach ($a['maskedFields'] as $f) {
                $label = isset($f['label']) ? $f['label'] : '';
                $val = isset($f['value']) ? $f['value'] : '';
                echo '<div><strong>' . esc_html($label) . ':</strong> <code>' . esc_html($val) . '</code></div>';
            }
        } else {
            echo '<code>' . esc_html(isset($a['maskedPayload']) ? $a['maskedPayload'] : '') . '</code>';
        }
        echo '</div>';

        echo '<span class="wpt-pill ' . esc_attr(self::pill_class($status)) . '">' . esc_html(self::asg_status_label($status)) . '</span>';
        if ($is_bonus) echo '<span class="wpt-meta wpt-meta--bonus">bonus</span>';
        if (!empty($a['maxUses']) && (int) $a['maxUses'] > 1) {
            echo '<span class="wpt-meta">' . esc_html((int) ($a['useCount'] ?? 0)) . '/' . esc_html((int) $a['maxUses']) . ' kullanım</span>';
        }
        if (!empty($a['validUntil'])) {
            echo '<span class="wpt-meta">' . esc_html__('Geçerlilik:', 'wpteslimat') . ' ' . esc_html(Wpteslimat_My_Account::format_date($a['validUntil'])) . '</span>';
        }
        echo '</div>';

        // Sağ blok: key-bazlı aksiyonlar (ikonlu, hiyerarşik).
        echo '<div class="wpteslimat-actions wpt-key__actions">';
        if ($can_reveal && ($is_active || $is_suspended)) {
            echo '<button type="button" class="wpteslimat-op wpt-btn wpt-btn--reveal" data-op="reveal" title="' . esc_attr__('Anahtarı göster (loglanır)', 'wpteslimat') . '">'
                . '<span class="dashicons dashicons-visibility"></span><span class="wpt-btn__label">' . esc_html__('Göster', 'wpteslimat') . '</span></button>';
        }
        if ($can_op && $is_active) {
            echo '<button type="button" class="wpteslimat-op wpt-btn wpt-btn--replace" data-op="replace" title="' . esc_attr__('Bu anahtarı taze biriyle değiştir', 'wpteslimat') . '">'
                . '<span class="dashicons dashicons-update"></span><span class="wpt-btn__label">' . esc_html__('Değiştir', 'wpteslimat') . '</span></button>';
        }
        if ($can_op && ($is_active || $is_suspended)) {
            $sv = $is_suspended ? '0' : '1';
            $cls = $is_suspended ? 'wpt-btn--resume' : 'wpt-btn--suspend';
            $icon = $is_suspended ? 'dashicons-controls-play' : 'dashicons-controls-pause';
            $slabel = $is_suspended ? __('Geri aç', 'wpteslimat') : __('Askıya al', 'wpteslimat');
            echo '<button type="button" class="wpteslimat-op wpt-btn ' . $cls . '" data-op="suspend" data-suspend="' . esc_attr($sv) . '">'
                . '<span class="dashicons ' . $icon . '"></span><span class="wpt-btn__label">' . esc_html($slabel) . '</span></button>';
        }
        echo '</div>';
        echo '</li>';
    }

    /**
     * ÜRÜN-BAĞLAMLI render — her sipariş kaleminin (line_item) altına o ürünün lisansları +
     * aksiyonları (+1 Bonus dahil). Bonus, o ürüne (bu satıra) eklenir ve `bonus:<item_id>:` önekiyle
     * yine bu satırın altında görünür (Woo kalemi şişmez, reconcile/iade dokunmaz).
     *
     * Kart düzeni: başlık (özet sayaç) + kaydırılabilir key listesi (çok anahtarda sayfa uzamaz) +
     * (varsa) katlanır değişim geçmişi + ürün-bazlı "Bonus Ekle" alt aksiyonu.
     */
    public function render_line($item_id, $item, $product) {
        if (!is_a($item, 'WC_Order_Item') || $item->get_type() !== 'line_item') return;
        $order = wc_get_order($item->get_order_id());
        if (!$order) return;
        $view = $this->get_view($order);
        if (!$view) return; // iletilmemiş/klon/hata → sessiz (yan metabox durumu gösterir)

        self::maybe_print_styles();
        $can_reveal = self::can_reveal();
        $can_op = self::can_operate();
        $mine = self::assignments_for_line($view, $item_id);

        // Özet sayaç: toplam + aktif/askıda (bir bakışta durum).
        $total = count($mine);
        $active = 0; $suspended = 0;
        foreach ($mine as $a) {
            $s = isset($a['status']) ? $a['status'] : '';
            if ($s === 'active') $active++;
            elseif ($s === 'suspended') $suspended++;
        }
        $summary = $total . ' ' . esc_html__('lisans', 'wpteslimat');
        if ($active > 0)    $summary .= ' · ' . $active . ' ' . esc_html__('aktif', 'wpteslimat');
        if ($suspended > 0) $summary .= ' · ' . $suspended . ' ' . esc_html__('askıda', 'wpteslimat');

        echo '<div class="wpt-line" data-line="' . esc_attr($item_id) . '">';
        echo '<div class="wpt-line-head">';
        echo '<span class="wpt-line-head__title"><span class="dashicons dashicons-admin-network"></span>' . esc_html__('Panel Lisansları', 'wpteslimat') . '</span>';
        echo '<span class="wpt-line-head__count">' . $summary . '</span>';
        echo '</div>';

        if (!empty($mine)) {
            // 5+ anahtarda kaydır → sipariş ekranı sonsuz uzamaz.
            $scroll = $total > 5 ? ' wpt-keys--scroll' : '';
            echo '<ul class="wpt-keys' . $scroll . '">';
            foreach ($mine as $a) self::render_asg_row($a, $can_reveal, $can_op);
            echo '</ul>';
        } else {
            echo '<div class="wpt-empty">' . esc_html__('Bu ürün için henüz teslim edilmiş lisans yok.', 'wpteslimat') . '</div>';
        }

        // Bu satıra ait değişim geçmişi (eski anahtarlar) — katlanır (varsayılan kapalı, yer kaplamaz).
        $hist = [];
        if (isset($view['history']) && is_array($view['history'])) {
            foreach ($view['history'] as $h) {
                if (isset($h['remoteLineId']) && (string) $h['remoteLineId'] === (string) $item_id) $hist[] = $h;
            }
        }
        if (!empty($hist)) {
            echo '<details class="wpt-history"><summary>' . esc_html__('Değişim geçmişi', 'wpteslimat') . ' (' . count($hist) . ')</summary>';
            echo '<ul>';
            foreach ($hist as $h) {
                $old = isset($h['oldMasked']) ? $h['oldMasked'] : '—';
                $reason = isset($h['reason']) ? $h['reason'] : '';
                echo '<li><code>' . esc_html($old) . '</code>' . ($reason !== '' ? ' — ' . esc_html($reason) : '') . '</li>';
            }
            echo '</ul></details>';
        }

        // Ürün-bazlı "Bonus Ekle" — kartın alt aksiyonu (key-bazlı aksiyonlardan görsel olarak ayrı).
        if ($can_op) {
            echo '<div class="wpt-line-foot"><button type="button" class="wpteslimat-op wpt-btn wpt-btn--bonus" data-op="bonus" data-line="' . esc_attr($item_id) . '" title="' . esc_attr__('Bu ürüne ücretsiz ek lisans ata', 'wpteslimat') . '">'
                . '<span class="dashicons dashicons-plus-alt2"></span><span class="wpt-btn__label">' . esc_html__('Bonus Ekle', 'wpteslimat') . '</span></button></div>';
        }
        echo '</div>';
    }

    /** Sağdaki İNCE kutu: yalnız sipariş-seviyesi (durum + Tekrar Mail + bağlanmayan atamalar). */
    public function render_side($post_or_order) {
        $order = ($post_or_order instanceof WC_Order) ? $post_or_order : wc_get_order($post_or_order->ID);
        if (!$order) return;

        self::maybe_print_styles();

        if (Wpteslimat_Settings::is_clone()) {
            echo '<p><em>' . esc_html__('Bu ortam (klon/staging) lisans işlemlerini yürütemez.', 'wpteslimat') . '</em></p>';
            return;
        }
        $local_status = $order->get_meta('_wpteslimat_status');
        if (!$order->get_meta('_wpteslimat_order_id')) {
            echo '<p><strong>Durum:</strong> ' . esc_html($local_status ?: 'bilinmiyor') . '</p>';
            echo '<p><em>Henüz panele iletilmedi.</em></p>';
            return;
        }

        $view = $this->get_view($order);
        if (!$view) {
            echo '<p><strong>Durum:</strong> ' . esc_html($local_status ?: 'bilinmiyor') . '</p>';
            echo '<p><em>' . esc_html__('Panel görünümü şu an alınamadı.', 'wpteslimat') . '</em></p>';
            return;
        }

        $live_status = isset($view['status']) ? (string) $view['status'] : '';
        $panel_held = !empty($view['held']);
        $display = $live_status !== '' ? self::order_status_label($live_status) : ($local_status ?: 'bilinmiyor');
        echo '<p><strong>Durum:</strong> ' . esc_html($display) . '</p>';

        // held meta idempotent temizle/göster.
        if ($order->get_meta('_wpteslimat_held_for_review') === 'yes') {
            $terminal = in_array($live_status, ['revoked', 'fulfilled', 'partial'], true);
            if (!$panel_held || $terminal) {
                $order->delete_meta_data('_wpteslimat_held_for_review');
                $order->save();
            } else {
                echo '<p><strong style="color:#b45309">' . esc_html__('İnceleme bekliyor', 'wpteslimat') . '</strong></p>';
            }
        }

        echo '<p style="color:#787c82;font-size:12px">' . esc_html__('Lisanslar ve işlemler her ürünün altında (sipariş kalemleri) görünür.', 'wpteslimat') . '</p>';

        // Güncel Woo kalemlerine bağlanamayan atamalar (ör. kalem Woo\'dan silinmiş) — burada göster ki kaybolmasın.
        $item_ids = array_map('strval', array_keys($order->get_items('line_item')));
        $orphans = [];
        $asgs = (isset($view['assignments']) && is_array($view['assignments'])) ? $view['assignments'] : [];
        foreach ($asgs as $a) {
            $rl = isset($a['remoteLineId']) ? (string) $a['remoteLineId'] : '';
            $matched = in_array($rl, $item_ids, true);
            if (!$matched && strpos($rl, 'bonus:') === 0) {
                foreach ($item_ids as $iid) {
                    if (strpos($rl, 'bonus:' . $iid . ':') === 0) { $matched = true; break; }
                }
            }
            if (!$matched) $orphans[] = $a;
        }
        if (!empty($orphans)) {
            echo '<div style="margin-top:8px;border-top:1px solid #ddd;padding-top:6px"><strong style="font-size:12px">' . esc_html__('Bağlanmayan lisanslar', 'wpteslimat') . '</strong>';
            echo '<ul style="margin:4px 0 0;padding:0">';
            foreach ($orphans as $a) self::render_asg_row($a, self::can_reveal(), self::can_operate());
            echo '</ul></div>';
        }

        // Sipariş-seviyesi: Tekrar Mail.
        if (self::can_operate()) {
            echo '<p style="margin-top:8px"><button type="button" class="wpteslimat-op wpt-btn wpt-btn--resend" data-op="resend">'
                . '<span class="dashicons dashicons-email-alt"></span><span class="wpt-btn__label">' . esc_html__('Teslimat Mailini Tekrar Gönder', 'wpteslimat') . '</span></button></p>';
        }

        $panel = Wpteslimat_Settings::panel_url();
        if ($panel) {
            echo '<p style="margin-top:6px;font-size:11px"><em>' . esc_html__('Farklı ürünle değişim / iptal için panel arayüzünü kullanın.', 'wpteslimat') . '</em></p>';
        }
    }

    /** Aksiyon JS'i + sipariş/nonce global — sayfada bir kez (yalnız bir sipariş render edildiyse). */
    public function print_script() {
        if (self::$script_printed || self::$script_order === null) return;
        self::$script_printed = true;
        $order = self::$script_order;
        $nonce = wp_create_nonce('wpteslimat_mb');
        ?>
        <script>
        (function () {
            var ORDER = <?php echo wp_json_encode($order); ?>;
            var NONCE = <?php echo wp_json_encode($nonce); ?>;
            function post(action, extra, done) {
                var fd = new FormData();
                fd.append('action', action); fd.append('nonce', NONCE); fd.append('order_id', ORDER);
                for (var k in extra) fd.append(k, extra[k]);
                fetch(ajaxurl, { method: 'POST', credentials: 'same-origin', body: fd })
                    .then(function (r) { return r.json().catch(function () { return { success: false, data: { message: 'Geçersiz yanıt' } }; }); })
                    .then(done).catch(function () { done({ success: false, data: { message: 'Ağ hatası' } }); });
            }
            function fail(j) { window.alert((j && j.data && j.data.message) ? j.data.message : 'İşlem başarısız'); }
            function markDone(btn, text) {
                var lab = btn.querySelector('.wpt-btn__label');
                if (lab) lab.textContent = text; else btn.textContent = text;
                btn.classList.add('is-done'); btn.disabled = true;
            }
            function escapeHtml(s) {
                return String(s).replace(/[&<>"']/g, function (c) {
                    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
                });
            }
            document.addEventListener('click', function (e) {
                var btn = e.target.closest('.wpteslimat-op');
                if (!btn || btn.disabled) return;
                e.preventDefault();
                var op = btn.getAttribute('data-op');
                var row = btn.closest('.wpteslimat-asg-row');
                var aid = row ? row.getAttribute('data-assignment') : '';

                if (op === 'reveal') {
                    btn.disabled = true;
                    post('wpteslimat_mb_reveal', { assignment_id: aid }, function (j) {
                        btn.disabled = false;
                        if (!j || !j.success) return fail(j);
                        var d = j.data || {}, valEl = row.querySelector('.wpteslimat-val');
                        if (!valEl) return;
                        if (d.fields && d.fields.length) {
                            valEl.innerHTML = d.fields.map(function (f) {
                                return '<div><strong>' + escapeHtml(f.label || '') + ':</strong> <code>' + escapeHtml(f.value || '') + '</code></div>';
                            }).join('');
                        } else if (typeof d.payload === 'string') {
                            valEl.innerHTML = '<code>' + escapeHtml(d.payload) + '</code>';
                        }
                        markDone(btn, 'Gösterildi');
                    });
                    return;
                }
                if (op === 'replace') {
                    var reason = window.prompt('Değişim sebebi:');
                    if (reason === null || reason.trim() === '') return;
                    btn.disabled = true;
                    post('wpteslimat_mb_replace', { assignment_id: aid, reason: reason }, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }
                if (op === 'suspend') {
                    btn.disabled = true;
                    post('wpteslimat_mb_suspend', { assignment_id: aid, suspend: btn.getAttribute('data-suspend') }, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }
                if (op === 'bonus') {
                    if (!window.confirm('Bu ürüne ek (bonus) bir lisans atansın mı?')) return;
                    btn.disabled = true;
                    post('wpteslimat_mb_bonus', { remote_line_id: btn.getAttribute('data-line') }, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }
                if (op === 'resend') {
                    btn.disabled = true;
                    post('wpteslimat_mb_resend', {}, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        markDone(btn, 'Gönderildi');
                    });
                    return;
                }
            });
        })();
        </script>
        <?php
    }

    // ─── AJAX işleyicileri — nonce + capability + is_clone; panele site-HMAC ile ───────

    private function guard_request($require_operate = true) {
        check_ajax_referer('wpteslimat_mb', 'nonce');
        if (Wpteslimat_Settings::is_clone()) {
            wp_send_json_error(['message' => 'Klon/staging ortamında işlem yapılamaz.'], 403);
        }
        $cap_ok = $require_operate ? self::can_operate() : self::can_reveal();
        if (!$cap_ok) {
            wp_send_json_error(['message' => 'Bu işlem için yetkiniz yok.'], 403);
        }
        $order_id = isset($_POST['order_id']) ? absint($_POST['order_id']) : 0;
        $order = $order_id ? wc_get_order($order_id) : null;
        if (!$order || !$order->get_meta('_wpteslimat_order_id')) {
            wp_send_json_error(['message' => 'Sipariş bulunamadı veya panele iletilmemiş.'], 404);
        }
        return (string) $order->get_id();
    }

    private function relay($res) {
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        if ($code >= 200 && $code < 300) {
            wp_send_json_success($body);
        }
        $msg = isset($body['message']) ? $body['message'] : ('Panel hatası (' . $code . ')');
        wp_send_json_error(['message' => $msg, 'code' => $code], 200);
    }

    private static function sanitize_aid($raw) {
        return preg_replace('/[^A-Za-z0-9\-]/', '', (string) $raw);
    }

    public function ajax_reveal() {
        $remote = $this->guard_request(false); // reveal = manage_options
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/reveal', []);
        $this->relay($res);
    }

    public function ajax_replace() {
        $remote = $this->guard_request(true);
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        $reason = isset($_POST['reason']) ? sanitize_text_field(wp_unslash($_POST['reason'])) : '';
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        if ($reason === '') wp_send_json_error(['message' => 'Değişim sebebi gerekli.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/replace', ['reason' => $reason]);
        $this->relay($res);
    }

    public function ajax_suspend() {
        $remote = $this->guard_request(true);
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $suspend = isset($_POST['suspend']) && $_POST['suspend'] === '1';
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/suspend', ['suspend' => $suspend]);
        $this->relay($res);
    }

    public function ajax_bonus() {
        $remote = $this->guard_request(true);
        // Bonus per-LINE: Woo item id (sanitize — sadece rakam/harf; sentetik bonus id gönderilmez).
        $line = preg_replace('/[^A-Za-z0-9:_\-]/', '', (string) ($_POST['remote_line_id'] ?? ''));
        if ($line === '') wp_send_json_error(['message' => 'Geçersiz ürün satırı.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/lines/' . rawurlencode($line) . '/bonus', []);
        $this->relay($res);
    }

    public function ajax_resend() {
        $remote = $this->guard_request(true);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/resend', []);
        $this->relay($res);
    }
}
