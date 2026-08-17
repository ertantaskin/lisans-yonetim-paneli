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

    /**
     * Ekrana basılacak serbest metni güvenle kısaltır.
     *
     * Ham `substr()` BAYT keser; çok baytlı (UTF-8) bir karakterin ortasından bölerse `esc_html()`
     * geçersiz diziyi BOŞ string'e çevirir → operatör bomboş bir çip görür (değişim sebebi kaybolur).
     * mbstring varsa karakter bazında kesilir; yoksa bayt kesiminin bozuk kuyruğu WP'nin kendi
     * `wp_check_invalid_utf8(..., true)` süzgeciyle atılır (class-updater.php `truncate_url()`
     * ile AYNI desen — tek çözüm, iki uygulama değil).
     *
     * NOT: burada MASKELEME YAPILMAZ. Maske biçiminin TEK kaynağı paneldir (`maskedPayload` /
     * `maskedFields` hazır gelir); eklentide ikinci bir maske tanımı tutmak bu projede sapma
     * üretmişti (hesap ürününde biçim ayrışması).
     */
    private static function truncate_text($s, $limit) {
        $s = (string) $s;
        $limit = (int) $limit;
        if ($limit <= 0) return '';
        if (function_exists('mb_strlen') && function_exists('mb_substr')) {
            if (mb_strlen($s, 'UTF-8') <= $limit) return $s;
            return mb_substr($s, 0, $limit, 'UTF-8');
        }
        if (strlen($s) <= $limit) return $s;
        $cut = substr($s, 0, $limit);
        return function_exists('wp_check_invalid_utf8') ? wp_check_invalid_utf8($cut, true) : $cut;
    }

    /** Yalnız administrator (manage_options) loglu reveal (§7 shop_manager açamaz). */
    private static function can_reveal() { return current_user_can('manage_options'); }
    /** Değiştir/askıya al/bonus/tekrar-mail: manage_woocommerce. */
    private static function can_operate() { return current_user_can('manage_woocommerce'); }

    /**
     * Atama durumu → Türkçe etiket. HAM enum (active/revoked/…) kullanıcıya ASLA çıkmaz;
     * bilinmeyen/yeni bir durum gelirse teknik kod yerine nötr "Bilinmiyor" gösterilir.
     */
    private static function asg_status_label($s) {
        switch ($s) {
            case 'active':      return 'Aktif';
            case 'suspended':   return 'Askıda';
            case 'revoked':     return 'İptal';
            case 'expired':     return 'Süresi doldu';
            case 'replaced':    return 'Değiştirildi';
            case 'quarantined': return 'Değiştirildi';
            default:            return 'Bilinmiyor';
        }
    }

    private static function order_status_label($s) {
        switch ($s) {
            case 'pending':   return 'Bekliyor';
            case 'partial':   return 'Kısmi teslim';
            case 'fulfilled': return 'Tamamlandı';
            case 'revoked':   return 'İptal';
            case 'expired':   return 'Süresi doldu';
            case 'held':      return 'İncelemede';
            case 'unmapped':  return 'Ürün eşlenmemiş';
            default:          return 'Bilinmiyor';
        }
    }

    /**
     * Panel audit aktörünü ("wp:ahmet@magaza.com", "admin", "system") operatöre okunur hâle getirir.
     * Panel yanıt şekli değişirse ham değere düşer (asla PHP hatası vermez).
     */
    private static function actor_label($actor) {
        $actor = is_scalar($actor) ? trim((string) $actor) : '';
        if ($actor === '') return '';
        if (strpos($actor, 'wp:') === 0) {
            $rest = substr($actor, 3);
            $at = strrpos($rest, '@');
            $user = ($at !== false) ? substr($rest, 0, $at) : $rest;
            $user = trim((string) $user);
            if ($user === 'system' || $user === '') return __('otomatik işlem', 'wpteslimat');
            /* translators: %s = mağaza (WordPress) kullanıcı adı */
            return sprintf(__('%s (mağaza)', 'wpteslimat'), $user);
        }
        if ($actor === 'system') return __('otomatik işlem', 'wpteslimat');
        if ($actor === 'admin')  return __('panel yöneticisi', 'wpteslimat');
        return $actor;
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

    /**
     * Panel satır kimliği (remoteLineId) bu Woo sipariş kalemine mi ait?
     *
     * İki biçim eşleşir:
     *   - "<item_id>"                 → normal sipariş kalemi
     *   - "bonus:<item_id>:<uuid>"    → o kaleme eklenen sentetik bonus satırı (panel bonusAssign)
     *
     * ATAMALAR ve DEĞİŞİM GEÇMİŞİ bu TEK fonksiyondan geçer. Daha önce geçmiş tam eşitlikle
     * (`=== $item_id`) süzülüyordu; bonus satırının kimliği hiçbir Woo kalemiyle birebir
     * eşleşmediği için BONUS bir lisans değiştirildiğinde eski anahtar kartta "İptal" görünüyor
     * ama değişim geçmişine HİÇ düşmüyordu (kullanıcı hata bildirimi). Ortak eşleştirme bunu kapatır.
     *
     * TEK KAYNAK ($origin): panel (`siteAdminView`) her atama/geçmiş satırında `originRemoteLineId`
     * DÖNDÜRÜR — sentetik bonus satırının ait olduğu mağaza kalemini panel zaten çözmüştür
     * (`resolveOriginRemoteLineId`). Eklenti ince istemcidir: aynı kuralı YENİDEN TÜRETMEZ,
     * panelin çözdüğünü kullanır. Aşağıdaki önek ayrıştırması YALNIZ alan hiç gelmediğinde
     * (ESKİ panel sürümü / dağıtım sapması) devreye giren geriye dönük fallback'tir.
     */
    private static function line_matches($remote_line_id, $item_id, $origin = null) {
        $iid = (string) $item_id;
        if ($iid === '') return false;

        $origin = is_scalar($origin) ? (string) $origin : '';
        if ($origin !== '') return $origin === $iid;

        // FALLBACK (eski panel sürümü): öneki yerel ayrıştır. Eski `bonus:<uuid>` biçiminde kalem
        // kimliği gömülü DEĞİLDİR → hiçbir kaleme bağlanmaz (yan kutuda "bağlanmayan" listelenir).
        $rl = (string) $remote_line_id;
        return $rl === $iid || strpos($rl, 'bonus:' . $iid . ':') === 0;
    }

    /** Panel satırından (atama/geçmiş) yetkili orijin kalem kimliği; alan yoksa null → fallback. */
    private static function origin_of($row) {
        return (is_array($row) && isset($row['originRemoteLineId'])) ? $row['originRemoteLineId'] : null;
    }

    /** Bu atamalar bu Woo kalemine mi ait? (normal satır + o kalemin bonus satırları) */
    private static function assignments_for_line($view, $item_id) {
        $out = [];
        $items = (isset($view['assignments']) && is_array($view['assignments'])) ? $view['assignments'] : [];
        foreach ($items as $a) {
            if (!is_array($a)) continue;
            if (self::line_matches(
                isset($a['remoteLineId']) ? $a['remoteLineId'] : '',
                $item_id,
                self::origin_of($a)
            )) {
                $out[] = $a;
            }
        }
        return $out;
    }

    /**
     * Bu Woo kalemine ait değişim geçmişi (bonus satırların geçmişi DÂHİL — assignments ile
     * aynı eşleştirme). Panel `history` alanını hiç döndürmezse boş dizi (savunmacı).
     */
    private static function history_for_line($view, $item_id) {
        $out = [];
        $rows = (isset($view['history']) && is_array($view['history'])) ? $view['history'] : [];
        foreach ($rows as $h) {
            if (!is_array($h)) continue;
            if (self::line_matches(
                isset($h['remoteLineId']) ? $h['remoteLineId'] : '',
                $item_id,
                self::origin_of($h)
            )) {
                $out[] = $h;
            }
        }
        return $out;
    }

    /**
     * GERİYE DÖNÜK FALLBACK — panelin `replaced` bayrağını döndürmediği ESKİ sürümler için.
     *
     * Panel (siteAdminView) artık her atamada YETKİLİ `replaced` (bool) + `replaceReason` döndürür;
     * normal yolda bu heuristik HİÇ çalışmaz (bkz. render_asg_row). Heuristik maskeli METİN
     * karşılaştırmasına dayanır ve HESAP (account) tipi üründe çalışmaz: orada panel `maskedPayload`
     * yerine alan-alan `maskedFields` döndürür, `oldMasked` ise tek satırlık maskedir → eşleşme
     * tutmaz ve değiştirilen anahtar yanlışlıkla "İptal" görünürdü (denetim bulgusu).
     *
     * Eşleştirme sırası: 1) `oldAssignmentId` (varsa KESİN), 2) `oldMasked` ↔ `maskedPayload`.
     * Eşleşme bulunamazsa hiçbir şey değişmez ("İptal" etiketi korunur) — güvenli düşüş.
     *
     * @return array{ids:array<string,true>, masked:array<string,true>} arama kümeleri
     */
    private static function replaced_lookup($history) {
        $ids = [];
        $masked = [];
        foreach ((array) $history as $h) {
            if (!is_array($h)) continue;
            $oid = isset($h['oldAssignmentId']) ? (string) $h['oldAssignmentId'] : '';
            if ($oid !== '') $ids[$oid] = true;
            $om = isset($h['oldMasked']) ? (string) $h['oldMasked'] : '';
            if ($om !== '' && $om !== '—') $masked[$om] = true;
        }
        return ['ids' => $ids, 'masked' => $masked];
    }

    /**
     * Atama bir DEĞİŞİM sonucu mu öldü (iade değil)? — YALNIZ eski panel sürümü fallback'i
     * (panel `replaced` alanını döndürüyorsa çağrılmaz). replaced_lookup kümelerine bakar.
     */
    private static function is_replaced($a, $lookup) {
        $status = isset($a['status']) ? (string) $a['status'] : '';
        if ($status !== 'revoked' && $status !== 'quarantined') return false;
        $aid = isset($a['id']) ? (string) $a['id'] : '';
        if ($aid !== '' && !empty($lookup['ids'][$aid])) return true;
        $mp = isset($a['maskedPayload']) ? (string) $a['maskedPayload'] : '';
        return $mp !== '' && !empty($lookup['masked'][$mp]);
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
        /* Değişim sebebi serbest metindir → nowrap TAŞIRIRDI; sarmasına izin ver, ayrımı italikle ver
           (renk düşürmek kontrastı bozardı). */
        .wpt-meta--reason{white-space:normal;font-style:italic;overflow-wrap:anywhere}
        .wpt-btn{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;font-size:12px;line-height:1.7;border:1px solid #c3c4c7;border-radius:4px;background:#fff;color:#2c3338;cursor:pointer;transition:background .1s,border-color .1s,color .1s}
        .wpt-btn .dashicons{font-size:14px;width:14px;height:14px;line-height:1}
        /* Hover YALNIZ etkin düğmede: MAK'ta "Değiştir" sebebiyle disabled gösterilir ve hover
           vurgusu kalsaydı tıklanabilir gibi görünürdü (yanlış afordans). */
        .wpt-btn:not(:disabled):hover{background:#f6f7f7;border-color:#8c8f94}
        .wpt-btn:disabled{opacity:.55;cursor:not-allowed}
        .wpt-btn--replace:not(:disabled):hover{border-color:#2271b1;color:#2271b1;background:#f0f6fc}
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
        .wpt-history--scroll ul{max-height:150px;overflow-y:auto}
        .wpt-history li{margin:2px 0}
        .wpt-history code{background:#f0f0f1;border-radius:3px;padding:0 4px}
        /* Kontrast (WCAG AA): 11px ikincil metin en az 4.5:1 olmalı — #8c8f94 beyaz zeminde 3.1:1
           kalıyordu. #646970 (WP admin ikincil gri) 5.35:1 sağlar; görsel ayrım rengi düşürmek
           yerine italik ile verilir. */
        .wpt-history__meta{color:#646970;font-style:italic}
        .wpt-side-status{display:inline-flex;align-items:center;font-size:11px;font-weight:600;line-height:1;padding:3px 9px;border-radius:999px;border:1px solid #dcdcde;background:#f6f7f7;color:#3c434a}
        </style>
        <?php
    }

    /**
     * Bu atama ÇOK KULLANIMLI (MAK) bir üründen mi geliyor?
     *
     * Kaynak panelin YETKİLİ `usageMode` alanıdır (`siteAdminView` EKLEMELİ olarak döndürür) —
     * eklenti ince istemcidir, bu bilgiyi kendi kapasitesinden TÜRETMEZ.
     *
     * @param array $a        atama kaydı
     * @param bool  $fallback alan gelmezse (eski panel imajı / dağıtım sapması) kullanılacak değer.
     *                        Çağıranlar bilinçli olarak farklı fallback verir: yetki/aksiyon
     *                        kapılarında fail-safe çıkarım (`maxUses > 1`), yeni GÖSTERİM
     *                        kapılarında `false` — böylece eski panelde davranış AYNEN korunur.
     */
    private static function is_multi_usage($a, $fallback = false) {
        if (isset($a['usageMode']) && is_string($a['usageMode']) && $a['usageMode'] !== '') {
            return $a['usageMode'] === 'multi';
        }
        return (bool) $fallback;
    }

    /**
     * Tek atama satırı (maskeli değer + durum pill + key-bazlı aksiyonlar).
     *
     * Değişimle ölen anahtar "İptal" yerine "Değiştirildi" gösterilir; kaynak PANELİN `replaced`
     * bayrağıdır (+ `replaceReason` çipi).
     *
     * @param array|null $lookup replaced_lookup() çıktısı — YALNIZ panel `replaced` alanını hiç
     *                           döndürmezse (eski sürüm) kullanılan geriye dönük fallback.
     */
    private static function render_asg_row($a, $can_reveal, $can_op, $lookup = null) {
        $aid = isset($a['id']) ? (string) $a['id'] : '';
        if ($aid === '') return;
        $status = isset($a['status']) ? (string) $a['status'] : '';
        // Değişimle ölen anahtar iade DEĞİLDİR → operatöre "Değiştirildi" olarak göster.
        // Kaynak: PANELİN YETKİLİ `replaced` bayrağı (siteAdminView her atamada döndürür). Eklenti
        // ince istemcidir → bu bilgiyi YENİDEN TÜRETMEZ. Eski heuristik maskeli metin karşılaştırması
        // yapıyordu ve hesap (account) tipi üründe maske biçimi farklı olduğu için etiket HİÇ
        // çıkmıyordu; artık yalnız panel alanı hiç gelmezse (eski panel sürümü) devreye girer.
        $replaced = array_key_exists('replaced', $a)
            ? !empty($a['replaced'])
            : (is_array($lookup) && self::is_replaced($a, $lookup));
        $is_active = ($status === 'active');
        $is_suspended = ($status === 'suspended');
        // Bonus işareti PANELİN yetkili `isBonus` alanından okunur (siteAdminView döndürür);
        // önek ayrıştırması yalnız alan hiç gelmediğinde (eski panel sürümü) fallback'tir.
        $is_bonus = array_key_exists('isBonus', $a)
            ? !empty($a['isBonus'])
            : (isset($a['remoteLineId']) && strpos((string) $a['remoteLineId'], 'bonus:') === 0);
        $is_account = isset($a['kind']) ? ($a['kind'] === 'account') : (!empty($a['maskedFields']));

        /*
         * MAK/çok-kullanımlı (paylaşımlı) anahtar → "Değiştir" panelde GARANTİLİ reddedilir:
         * `admin-orders.service.replaceAssignment` `usage_mode='multi'` gördüğünde 400 verir
         * ("Çok-kullanımlı (MAK) üründe otomatik değişim desteklenmez — elle işleyin"); gerekçe
         * §2'dir: geri alınan kapasite AYNI paylaşımlı anahtara döner, yani taze anahtar yerine
         * yine kusurlu anahtar seçilirdi. Panelin KENDİ ekranları (sipariş detayı, destek kuyruğu,
         * envanter) düğmeyi bu sebeple KAPATIYOR; mağaza yüzeyi açık kalmıştı → operatör tıklıyor
         * ve 400 alıyordu. Bu projede "tıklanıp hata veren düğme, hiç sunulmayandan kötüdür".
         *
         * ÖLÇÜT ARTIK DOĞRUDAN `usageMode` (panel `siteAdminView`'a EKLEMELİ olarak ekledi) —
         * panelin red ölçütüyle BİREBİR aynı alan. Eskiden en yakın sinyal olan `maxUses > 1`
         * kullanılıyordu ve yanlış-pozitif üretebiliyordu (tek-kullanımlık üründe kapasite>1
         * taşıyan bir kalem bulunursa düğme gereksiz kapanırdı).
         *
         * GERİYE DÖNÜK UYUM: alan gelmezse (eski panel imajı / dağıtım sapması) ESKİ `maxUses > 1`
         * çıkarımına düşülür — yanlış-negatif YOK, çünkü multi ürünlerde kapasite her zaman >1
         * (ürün oluşturmada `multi ⇒ maxUses>1` refine'ı + stok import guard'ı).
         */
        $max_uses     = isset($a['maxUses']) ? (int) $a['maxUses'] : 1;
        $is_multi_key = self::is_multi_usage($a, $max_uses > 1);

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

        $pill_status = $replaced ? 'replaced' : $status;
        echo '<span class="wpt-pill ' . esc_attr(self::pill_class($pill_status)) . '">'
            . esc_html(self::asg_status_label($pill_status)) . '</span>';
        // Değişim sebebi (panel `replaceReason`): "neden değişti" bilgisi anahtarın yanında dursun.
        // Uzun sebep kartı taşırmasın → kısaltılır, tamamı title'da (ikisi de kaçışlı).
        if ($replaced) {
            $rreason = (isset($a['replaceReason']) && is_scalar($a['replaceReason']))
                ? trim((string) $a['replaceReason'])
                : '';
            if ($rreason !== '') {
                $short = self::truncate_text($rreason, 60);
                if ($short !== $rreason) $short .= '…';
                echo '<span class="wpt-meta wpt-meta--reason" title="' . esc_attr($rreason) . '">'
                    . esc_html($short) . '</span>';
            }
        }
        if ($is_bonus) echo '<span class="wpt-meta wpt-meta--bonus">' . esc_html__('Bonus', 'wpteslimat') . '</span>';

        // Bu ATAMANIN bu siparişe verdiği kullanım hakkı (birim). MAK'ta tek atama birden çok
        // aktivasyon taşır (qty=3 → tek satır, 3 hak) — satırda yazmazsa operatör "1 lisans"
        // görüp eksik teslimat sanıyor ve bedava "+1 Bonus" veriyordu.
        //
        // KAPI MAK'ta KOŞULSUZ: eski `units > 1` ölçütü, aynı siparişin bir MAK anahtarından
        // yalnız 1 birim aldığı satırı (ölçülen gerçek sipariş: 5 birim A + 1 birim B) açıklamasız
        // bırakıyordu → operatör o anahtarın tamamının bu siparişe ait olduğunu sanıyordu.
        // Paylaşımlı anahtarda "1" de anlamlı bilgidir.
        //
        // Burada `$is_multi_key` DEĞİL, fallback'siz kip (`usageMode==='multi'`) sorulur: eski panel
        // sürümünde (alan yok) davranış AYNEN eski hâlinde kalmalı, `maxUses` çıkarımıyla yeni çip
        // basılmamalıdır. Değiştir-düğmesi kapısı ise fail-safe yönde fallback kullanmaya devam eder.
        $units = isset($a['units']) ? max(1, (int) $a['units']) : 1;
        if (self::is_multi_usage($a, false) || $units > 1) {
            echo '<span class="wpt-meta">'
                . sprintf(esc_html__('Bu siparişte %d kullanım hakkı', 'wpteslimat'), $units)
                . '</span>';
        }
        if ($max_uses > 1) {
            // O11: bu sayaç ANAHTARIN GENELİDİR (tüm siparişler/müşteriler toplamı), bu
            // siparişin harcaması DEĞİL. Etiketsiz "12/500 kullanım" çipi "bu müşteri 12
            // kullanım harcadı" diye okunuyordu → anlamı çipin İÇİNE yazıldı.
            //
            // Kapı `$is_multi_key` DEĞİL doğrudan kapasitedir: bu çip anahtarın SAYACINI anlatır,
            // ürünün kipini değil — kapasite 1 ise sayaç zaten anlamsızdır, >1 ise (kip ne olursa
            // olsun) operatörün görmesi gerekir.
            echo '<span class="wpt-meta" title="'
                . esc_attr__('Bu sayaç anahtarın tüm siparişlerdeki toplam kullanımıdır; yalnız bu siparişe ait değildir.', 'wpteslimat')
                . '">'
                . sprintf(
                    esc_html__('Anahtar geneli: %1$d/%2$d kullanım', 'wpteslimat'),
                    (int) ($a['useCount'] ?? 0),
                    $max_uses
                )
                . '</span>';
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
            if ($is_multi_key) {
                // MAK: düğme SEBEBİYLE kapalı (yukarıdaki gerekçe). `wpteslimat-op` sınıfı YOK →
                // JS işleyicisi bu düğmeyi hiç görmez; `disabled` ile klavye/fare de erişemez.
                echo '<button type="button" class="wpt-btn wpt-btn--replace" disabled title="'
                    . esc_attr__('Çok kullanımlı (MAK) anahtarda otomatik değişim yapılamaz: geri alınan kullanım hakkı aynı paylaşımlı anahtara döner. Panelden elle işleyin.', 'wpteslimat') . '">'
                    . '<span class="dashicons dashicons-update"></span><span class="wpt-btn__label">'
                    . esc_html__('Değiştir', 'wpteslimat') . '</span></button>';
            } else {
                echo '<button type="button" class="wpteslimat-op wpt-btn wpt-btn--replace" data-op="replace" title="' . esc_attr__('Bu anahtarı taze biriyle değiştir', 'wpteslimat') . '">'
                    . '<span class="dashicons dashicons-update"></span><span class="wpt-btn__label">' . esc_html__('Değiştir', 'wpteslimat') . '</span></button>';
            }
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
     * Değişim geçmişi bloğu — "hangi eski anahtar, neden, KİM tarafından, ne zaman değiştirildi".
     * Varsayılan AÇIK (operatör tıklamadan görsün); 5'ten fazla kayıtta kendi içinde kaydırılır,
     * böylece sipariş ekranı uzamaz. Panel yanıtındaki her alan opsiyonel kabul edilir (eksik
     * alan PHP hatası üretmez; yalnız o parça gösterilmez).
     */
    private static function render_history($hist) {
        if (empty($hist) || !is_array($hist)) return;
        $n = count($hist);
        $scroll = $n > 5 ? ' wpt-history--scroll' : '';
        echo '<details class="wpt-history' . $scroll . '" open><summary>'
            . esc_html__('Değişim geçmişi', 'wpteslimat') . ' (' . intval($n) . ')</summary>';
        echo '<ul>';
        foreach ($hist as $h) {
            if (!is_array($h)) continue;
            $old    = isset($h['oldMasked']) ? (string) $h['oldMasked'] : '—';
            $reason = isset($h['reason']) ? trim((string) $h['reason']) : '';
            $who    = self::actor_label(isset($h['actor']) ? $h['actor'] : '');
            $when   = !empty($h['createdAt']) ? Wpteslimat_My_Account::format_date($h['createdAt']) : '';

            echo '<li><code>' . esc_html($old) . '</code>';
            if ($reason !== '') echo ' — ' . esc_html($reason);
            $meta = [];
            if ($who !== '')  $meta[] = $who;
            if ($when !== '') $meta[] = $when;
            if (!empty($meta)) {
                echo ' <span class="wpt-history__meta">· ' . esc_html(implode(' · ', $meta)) . '</span>';
            }
            echo '</li>';
        }
        echo '</ul></details>';
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
        //
        // O11 (units semantiği): sayaç YALNIZ KALEM sayıyordu. MAK'ta qty=3 tek atamaya
        // düşer (units=3) → mağaza operatörü "1 lisans" görüyor, müşteri ise mailde
        // "(3 adet)" ve hesabında "3 kullanım hakkı" görüyordu. Operatör eksik teslimat
        // sanıp "+1 Bonus" verdiğinde BEDAVA lisans çıkıyordu. Artık birim toplamı da
        // sayılır; tek kullanımlık üründe (tüm units=1) metin AYNEN eski hâlinde kalır
        // (gürültü eklenmez).
        //
        // MAK KAPISI: eski `units_total > total` ölçütü, MAK siparişinin birim toplamı kayıt
        // sayısına EŞİT olduğu durumda (ör. qty=1 → tek anahtardan 1 birim) hiçbir şey basmıyordu →
        // operatör paylaşımlı anahtarı "tamamı bu siparişin" sanıyordu. Artık atamalardan biri MAK
        // ise toplam HER ZAMAN yazılır. `usageMode` gelmezse (eski panel) eski ölçüt aynen geçerli.
        $total = count($mine);
        $active = 0; $suspended = 0; $units_total = 0; $has_multi = false;
        foreach ($mine as $a) {
            $s = isset($a['status']) ? $a['status'] : '';
            if ($s === 'active') $active++;
            elseif ($s === 'suspended') $suspended++;
            $units_total += isset($a['units']) ? max(1, (int) $a['units']) : 1;
            if (self::is_multi_usage($a, false)) $has_multi = true;
        }
        $summary = intval($total) . ' ' . esc_html__('lisans', 'wpteslimat');
        if ($has_multi || $units_total > $total) {
            $summary .= ' ' . sprintf(esc_html__('(toplam %d kullanım hakkı)', 'wpteslimat'), $units_total);
        }
        if ($active > 0)    $summary .= ' · ' . $active . ' ' . esc_html__('aktif', 'wpteslimat');
        if ($suspended > 0) $summary .= ' · ' . $suspended . ' ' . esc_html__('askıda', 'wpteslimat');

        echo '<div class="wpt-line" data-line="' . esc_attr($item_id) . '">';
        echo '<div class="wpt-line-head">';
        echo '<span class="wpt-line-head__title"><span class="dashicons dashicons-admin-network"></span>' . esc_html__('Panel Lisansları', 'wpteslimat') . '</span>';
        echo '<span class="wpt-line-head__count">' . $summary . '</span>';
        echo '</div>';

        // Bu satıra ait değişim geçmişi (bonus satırların geçmişi de DÂHİL — ortak eşleştirme).
        $hist = self::history_for_line($view, $item_id);
        $lookup = self::replaced_lookup($hist);

        if (!empty($mine)) {
            // 5+ anahtarda kaydır → sipariş ekranı sonsuz uzamaz.
            $scroll = $total > 5 ? ' wpt-keys--scroll' : '';
            echo '<ul class="wpt-keys' . $scroll . '">';
            foreach ($mine as $a) self::render_asg_row($a, $can_reveal, $can_op, $lookup);
            echo '</ul>';
        } else {
            echo '<div class="wpt-empty">' . esc_html__('Bu ürün için henüz teslim edilmiş lisans yok.', 'wpteslimat') . '</div>';
        }

        self::render_history($hist);

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
        $local_status = (string) $order->get_meta('_wpteslimat_status');
        if (!$order->get_meta('_wpteslimat_order_id')) {
            // Henüz iletilmemiş siparişte "Durum: Bilinmiyor" satırı bilgi taşımaz → tek net cümle.
            if ($local_status !== '') {
                echo '<p><strong>Durum:</strong> ' . esc_html(self::order_status_label($local_status)) . '</p>';
            }
            echo '<p><em>' . esc_html__('Henüz panele iletilmedi.', 'wpteslimat') . '</em></p>';
            return;
        }

        $view = $this->get_view($order);
        if (!$view) {
            echo '<p><strong>Durum:</strong> ' . esc_html(self::order_status_label($local_status)) . '</p>';
            echo '<p><em>' . esc_html__('Panel görünümü şu an alınamadı.', 'wpteslimat') . '</em></p>';
            return;
        }

        $live_status = isset($view['status']) ? (string) $view['status'] : '';
        $panel_held = !empty($view['held']);
        // Ham enum (fulfilled/partial/…) operatöre ASLA çıkmaz — canlı durum yoksa yerel meta da
        // aynı Türkçe sözlükten geçer.
        $display = self::order_status_label($live_status !== '' ? $live_status : (string) $local_status);
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

        // Güncel Woo kalemlerine bağlanamayan atamalar (ör. kalem Woo'dan silinmiş, ya da ESKİ
        // biçimli `bonus:<uuid>` satırı — içinde kalem id'si yok) — burada göster ki kaybolmasın.
        // Geçmişleri de aynı ölçütle burada listelenir; aksi halde hiçbir kartta görünmezlerdi.
        $item_ids = array_map('strval', array_keys($order->get_items('line_item')));
        // Kart render'ıyla AYNI eşleştirme (line_matches) — panelin `originRemoteLineId`'si varsa o
        // kullanılır. İki yüzey ayrışırsa aynı atama hem kartta hem "bağlanmayan"da (ya da hiçbirinde)
        // görünürdü.
        $matches_any = static function ($row) use ($item_ids) {
            $remote_line_id = isset($row['remoteLineId']) ? $row['remoteLineId'] : '';
            $origin = self::origin_of($row);
            foreach ($item_ids as $iid) {
                if (self::line_matches($remote_line_id, $iid, $origin)) return true;
            }
            return false;
        };

        $orphans = [];
        $asgs = (isset($view['assignments']) && is_array($view['assignments'])) ? $view['assignments'] : [];
        foreach ($asgs as $a) {
            if (!is_array($a)) continue;
            if (!$matches_any($a)) $orphans[] = $a;
        }
        $orphan_hist = [];
        $hist_rows = (isset($view['history']) && is_array($view['history'])) ? $view['history'] : [];
        foreach ($hist_rows as $h) {
            if (!is_array($h)) continue;
            if (!$matches_any($h)) $orphan_hist[] = $h;
        }

        if (!empty($orphans) || !empty($orphan_hist)) {
            $lookup = self::replaced_lookup($orphan_hist);
            echo '<div style="margin-top:8px;border-top:1px solid #ddd;padding-top:6px"><strong style="font-size:12px">' . esc_html__('Bağlanmayan lisanslar', 'wpteslimat') . '</strong>';
            if (!empty($orphans)) {
                echo '<ul class="wpt-keys" style="margin:4px 0 0;padding:0">';
                foreach ($orphans as $a) self::render_asg_row($a, self::can_reveal(), self::can_operate(), $lookup);
                echo '</ul>';
            }
            self::render_history($orphan_hist);
            echo '</div>';
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

    /**
     * Ortak ön-kontrol — üçlü güvenlik kapısı (§7): nonce + capability + klon/staging guard.
     * @return WC_Order Panele iletilmiş sipariş (aksi halde JSON hata ile sonlanır).
     */
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
        return $order;
    }

    /** Panel yanıtı başarılı mı (2xx)? */
    private static function is_ok($res) {
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        return $code >= 200 && $code < 300;
    }

    /** Bu isteği yapan WP kullanıcısının görünen adı (sipariş notu için). */
    private static function who() {
        $u = wp_get_current_user();
        if ($u && $u->exists() && $u->user_login) return (string) $u->user_login;
        return __('bilinmeyen kullanıcı', 'wpteslimat');
    }

    /**
     * MAĞAZA TARAFI LOGU (§7 "kim yaptı"): panelde başarıyla tamamlanan işlemi WooCommerce
     * sipariş notuna da yazar → operatör paneli açmadan kimin ne yaptığını görür. Mevcut
     * "Teslimat:" önek düzeni korunur. Salt-okuma (reveal) NOT ÜRETMEZ — gürültü olurdu.
     */
    private static function note($order, $text) {
        if (!is_a($order, 'WC_Order')) return;
        $order->add_order_note('Teslimat: ' . $text);
    }

    /**
     * Panel yanıtını istemciye ilet. Hata durumunda kullanıcıya HAM HTTP kodu değil, anlamlı
     * Türkçe mesaj gider (panel kendi mesajını döndürdüyse o tercih edilir).
     */
    private function relay($res) {
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];
        if (self::is_ok($res)) {
            wp_send_json_success($body);
        }
        wp_send_json_error(['message' => self::error_message($code, $body), 'code' => $code], 200);
    }

    /**
     * Panel/HTTP hatasını sade Türkçeye çevirir.
     *
     * SIRA ÖNEMLİ (denetim bulgusu): önce KOD bazlı çeviri, sonra panelin kendi metni. Ağ
     * hatasında (code=0) panel istemcisi gövdeye panelin değil, WP_Error'ın HAM İNGİLİZCE metnini
     * koyar ("cURL error 28: Operation timed out"); gövde önce okunduğu için kod-0 dalı ERİŞİLEMEZ
     * kalıyor ve operatöre Türkçe açıklama yerine bu teknik metin gidiyordu. Panelin kendi
     * açıklaması yalnız GERÇEK HTTP hata yanıtında (>=400) anlamlıdır — orada en doğrusu odur.
     *
     * PUBLIC (tek kaynak): ürün-eşleme kutusu (class-product-mapping) da AYNI panel yanıt şeklini
     * alır ve kendi kopyasını taşıdığında ayrışıyordu — `message` DİZİ geldiğinde (Nest doğrulama
     * hatası) `alert()`'e ham dizi verip parçalı/anlamsız metin basıyordu. Kural TEK yerde durur.
     */
    public static function error_message($code, $body) {
        $code = (int) $code;
        $body = is_array($body) ? $body : [];

        // [1] Panele hiç ulaşılamadı (ağ/zaman aşımı) — gövde panelden GELMEZ, kullanma.
        if ($code === 0) {
            return __('Panele ulaşılamadı (ağ hatası veya zaman aşımı). Lütfen tekrar deneyin.', 'wpteslimat');
        }

        // [2] Panelin kendi açıklaması (Nest `message` dizi de olabilir) — yalnız HTTP hata yanıtında.
        if ($code >= 400) {
            // Zod gövde doğrulaması `{error:'validation_error', issues:[{path,message}]}` döner —
            // `error` alanı burada HAM ENUM'dur, operatöre gösterilmemeli; okunur bilgi `issues`
            // içindedir (hangi alan neden reddedildi). Alan adı zaten teknikdir ama "geçersiz istek"
            // demekten çok daha eyleme dönüktür.
            if (self::field($body, 'error') === 'validation_error') {
                $parts = [];
                if (isset($body['issues']) && is_array($body['issues'])) {
                    foreach ($body['issues'] as $i) {
                        if (!is_array($i)) continue;
                        $p = self::field($i, 'path');
                        $m = self::field($i, 'message');
                        if ($m === '') continue;
                        $parts[] = ($p !== '') ? ($p . ': ' . $m) : $m;
                    }
                }
                if (!empty($parts)) {
                    /* translators: %s = panelin reddettiği alan(lar) ve sebebi */
                    return sprintf(__('Panel isteği doğrulayamadı — %s', 'wpteslimat'), implode(' · ', $parts));
                }
                return __('Panel isteği doğrulayamadı (gönderilen bilgiler geçersiz).', 'wpteslimat');
            }

            $msg = isset($body['message']) ? $body['message'] : (isset($body['error']) ? $body['error'] : '');
            if (is_array($msg)) $msg = implode(' ', array_map('strval', $msg));
            $msg = is_scalar($msg) ? trim((string) $msg) : '';
            if ($msg !== '') return $msg;
        }

        // [3] Panel anlamlı metin döndürmediyse koda göre sabit çeviri.
        switch (true) {
            case $code === 401:
            case $code === 403:
                return __('Panel isteği reddetti (kimlik/imza doğrulanamadı). Ayarlar → Tanılama ile bağlantıyı kontrol edin.', 'wpteslimat');
            case $code === 404:
                return __('Kayıt panelde bulunamadı (sipariş veya lisans silinmiş olabilir).', 'wpteslimat');
            case $code === 409:
                return __('İşlem şu an yapılamıyor — uygun stok yok ya da kayıt başka bir işlemle değişmiş.', 'wpteslimat');
            case $code === 429:
                return __('Çok sık istek gönderildi. Lütfen biraz bekleyip tekrar deneyin.', 'wpteslimat');
            case $code >= 500:
                return __('Panelde beklenmeyen bir hata oluştu. Lütfen daha sonra tekrar deneyin.', 'wpteslimat');
        }
        return __('İşlem tamamlanamadı. Lütfen tekrar deneyin.', 'wpteslimat');
    }

    /** Panel yanıtından skaler bir alanı güvenle okur (dizi/nesne → ''). */
    private static function field($arr, $key) {
        if (!is_array($arr) || !isset($arr[$key]) || !is_scalar($arr[$key])) return '';
        return trim((string) $arr[$key]);
    }

    private static function sanitize_aid($raw) {
        return preg_replace('/[^A-Za-z0-9\-]/', '', (string) $raw);
    }

    /** Woo sipariş kaleminin ürün adı (sipariş notu için okunur bağlam); bulunamazsa boş. */
    private static function line_name($order, $item_id) {
        if (!is_a($order, 'WC_Order')) return '';
        $item = $order->get_item(absint($item_id));
        return ($item && method_exists($item, 'get_name')) ? (string) $item->get_name() : '';
    }

    public function ajax_reveal() {
        $order = $this->guard_request(false); // reveal = manage_options
        $remote = (string) $order->get_id();
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/reveal', []);
        // Sipariş notu YAZILMAZ: her görüntüleme not üretse sipariş geçmişi gürültüye boğulurdu.
        // İzlenebilirlik korunur — panel reveal'ı audit_log'a "wp:<kullanıcı>@<site>" ile yazar.
        $this->relay($res);
    }

    public function ajax_replace() {
        $order = $this->guard_request(true);
        $remote = (string) $order->get_id();
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        $reason = isset($_POST['reason']) ? sanitize_text_field(wp_unslash($_POST['reason'])) : '';
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        if ($reason === '') wp_send_json_error(['message' => 'Değişim sebebi gerekli.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/replace', ['reason' => $reason]);
        if (self::is_ok($res)) {
            self::note($order, sprintf(
                /* translators: 1: WP kullanıcı adı, 2: değişim sebebi */
                __('%1$s bir lisansı yeni bir anahtarla değiştirdi. Sebep: %2$s', 'wpteslimat'),
                self::who(),
                $reason
            ));
        }
        $this->relay($res);
    }

    public function ajax_suspend() {
        $order = $this->guard_request(true);
        $remote = (string) $order->get_id();
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $suspend = isset($_POST['suspend']) && $_POST['suspend'] === '1';
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/suspend', ['suspend' => $suspend]);
        if (self::is_ok($res)) {
            self::note($order, sprintf(
                $suspend
                    /* translators: %s = WP kullanıcı adı */
                    ? __('%s bir lisansı askıya aldı (müşteri geçici olarak göremez).', 'wpteslimat')
                    : __('%s askıdaki lisansı yeniden aktif etti.', 'wpteslimat'),
                self::who()
            ));
        }
        $this->relay($res);
    }

    public function ajax_bonus() {
        $order = $this->guard_request(true);
        $remote = (string) $order->get_id();
        // Bonus per-LINE: Woo item id (sanitize — sadece rakam/harf; sentetik bonus id gönderilmez).
        $line = preg_replace('/[^A-Za-z0-9:_\-]/', '', (string) ($_POST['remote_line_id'] ?? ''));
        if ($line === '') wp_send_json_error(['message' => 'Geçersiz ürün satırı.'], 400);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/lines/' . rawurlencode($line) . '/bonus', []);
        if (self::is_ok($res)) {
            $pname = self::line_name($order, $line);
            self::note($order, $pname !== ''
                ? sprintf(
                    /* translators: 1: WP kullanıcı adı, 2: ürün adı */
                    __('%1$s "%2$s" ürününe ücretsiz (bonus) bir lisans ekledi.', 'wpteslimat'),
                    self::who(),
                    $pname
                )
                : sprintf(
                    /* translators: %s = WP kullanıcı adı */
                    __('%s siparişe ücretsiz (bonus) bir lisans ekledi.', 'wpteslimat'),
                    self::who()
                ));
        }
        $this->relay($res);
    }

    public function ajax_resend() {
        $order = $this->guard_request(true);
        $remote = (string) $order->get_id();
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/resend', []);
        if (self::is_ok($res)) {
            self::note($order, sprintf(
                /* translators: %s = WP kullanıcı adı */
                __('%s teslimat e-postasını tekrar gönderdi.', 'wpteslimat'),
                self::who()
            ));
        }
        $this->relay($res);
    }
}
