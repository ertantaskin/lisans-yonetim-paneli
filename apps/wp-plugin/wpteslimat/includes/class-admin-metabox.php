<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş ekranı meta box (§7) — OPERASYON KATMANI. Panel durumu + teslim edilen lisanslar
 * (site-scoped, maskeli) + key-bazında aksiyonlar: Göster (loglu reveal), Değiştir (sebepli),
 * Tekrar Mail (60sn debounce), Askıya al/Geri aç, +1 Bonus. Değişim geçmişi (eski anahtarlar) altta.
 *
 * Güvenlik modeli:
 *  - Tüm yazma/gösterme aksiyonları AJAX → panele SİTE HMAC secret'ıyla (panel-client) gider; panel
 *    her uçta hedefin bu siteye ait olduğunu doğrular (çapraz-site = 404) + audit'e wp:kullanıcı@site.
 *  - WP rol→scope (§7 "shop_manager key açamaz"): reveal YALNIZ manage_options (administrator);
 *    diğer operasyonlar manage_woocommerce. Hem UI (buton gizli) hem AJAX handler (403) zorlar.
 *  - Klon/staging koruması: is_clone() ise tüm operasyonlar 403 (canlı lisansa dokunulmaz).
 * HPOS + klasik uyumlu.
 */
class Wpteslimat_Admin_Metabox {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('add_meta_boxes', [$this, 'add'], 30, 2);
        // Meta box operasyon AJAX uçları (yalnız oturum açmış = wp_ajax_, nopriv YOK).
        add_action('wp_ajax_wpteslimat_mb_reveal', [$this, 'ajax_reveal']);
        add_action('wp_ajax_wpteslimat_mb_replace', [$this, 'ajax_replace']);
        add_action('wp_ajax_wpteslimat_mb_suspend', [$this, 'ajax_suspend']);
        add_action('wp_ajax_wpteslimat_mb_bonus', [$this, 'ajax_bonus']);
        add_action('wp_ajax_wpteslimat_mb_resend', [$this, 'ajax_resend']);
    }

    public function add($post_type, $post) {
        // HPOS ekran id'si veya klasik 'shop_order'.
        $screen = class_exists('\Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController')
            && function_exists('wc_get_page_screen_id')
            ? wc_get_page_screen_id('shop-order')
            : 'shop_order';
        add_meta_box('wpteslimat_deliveries', 'Lisans Teslimatı', [$this, 'render'], $screen, 'side', 'high');
    }

    /** Panel mask formatıyla hizalı: sabit gövde + son 4 hane (uzunluk/yapı sızmaz). */
    private static function mask($value) {
        $value = (string) $value;
        return strlen($value) <= 4 ? '••••••' : '••••••' . substr($value, -4);
    }

    /** Yalnız administrator (manage_options) loglu reveal yapabilir (§7 shop_manager açamaz). */
    private static function can_reveal() {
        return current_user_can('manage_options');
    }

    /** Değiştir/askıya al/bonus/tekrar-mail: mağaza yöneticisi + admin (manage_woocommerce). */
    private static function can_operate() {
        return current_user_can('manage_woocommerce');
    }

    /** Atama durumunu Türkçeleştir (ham enum kullanıcıya çıkmaz). */
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

    /** Sipariş durumunu Türkçeleştir. */
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

    public function render($post_or_order) {
        $order = ($post_or_order instanceof WC_Order) ? $post_or_order : wc_get_order($post_or_order->ID);
        if (!$order) return;

        // Klon/staging: canlı panelden GERÇEK (maskesiz) veriye erişip operasyon YAPMASINI önle.
        if (Wpteslimat_Settings::is_clone()) {
            echo '<p><em>' . esc_html__('Bu ortam (klon/staging) lisans işlemlerini yürütemez.', 'wpteslimat') . '</em></p>';
            return;
        }

        $local_status = $order->get_meta('_wpteslimat_status');
        $panel_order_id = $order->get_meta('_wpteslimat_order_id');
        // Panel remoteOrderId = Woo sipariş id'si (push'ta böyle gönderilir). Aksiyon uçları bunu kullanır.
        $remote_id = $order->get_id();

        // Panele hiç iletilmemiş sipariş → canlı sorgu yapılamaz; yerel durumu göster ve çık.
        if (!$panel_order_id) {
            echo '<p><strong>Durum:</strong> ' . esc_html($local_status ?: 'bilinmiyor') . '</p>';
            echo '<p><em>Henüz panele iletilmedi.</em></p>';
            return;
        }

        // Canlı meta box görünümü (§7): maskeli atamalar (assignmentId + status) + değişim geçmişi.
        // wp-admin sipariş ekranı render'ı içinde senkron: kısa timeout (5sn) — panel yavaşsa
        // yönetici ekranı 15sn asılmasın (fetch başarısızsa yerel meta'ya düşülür).
        $res = Wpteslimat_Panel_Client::get('/v1/orders/' . rawurlencode($remote_id) . '/admin-view', 5);
        $fetch_ok = isset($res['code']) && $res['code'] >= 200 && $res['code'] < 300;
        $body = ($fetch_ok && is_array($res['body'])) ? $res['body'] : [];

        if (!$fetch_ok) {
            echo '<p><strong>Durum:</strong> ' . esc_html($local_status ?: 'bilinmiyor') . '</p>';
            echo '<p><em>' . esc_html__('Panel görünümü şu an alınamadı.', 'wpteslimat')
                . ' (' . esc_html((string) ($res['code'] ?? 0)) . ')</em></p>';
            return;
        }

        $live_status = isset($body['status']) ? (string) $body['status'] : '';
        $panel_held = array_key_exists('held', $body) ? (bool) $body['held'] : false;
        $assignments = (isset($body['assignments']) && is_array($body['assignments'])) ? $body['assignments'] : [];
        $history = (isset($body['history']) && is_array($body['history'])) ? $body['history'] : [];

        // "Durum:" — canlı durumu tercih et (bayat 'pending' okumasın); yoksa yerel meta'ya düş.
        $display_status = $live_status !== '' ? self::order_status_label($live_status) : ($local_status ?: 'bilinmiyor');
        echo '<p><strong>Durum:</strong> ' . esc_html($display_status) . '</p>';

        // (§8 held staleness) held meta'yı canlı held + duruma göre idempotent temizle/göster.
        if ($order->get_meta('_wpteslimat_held_for_review') === 'yes') {
            $terminal = in_array($live_status, ['revoked', 'fulfilled', 'partial'], true);
            if (!$panel_held || $terminal) {
                $order->delete_meta_data('_wpteslimat_held_for_review');
                $order->save();
            } else {
                echo '<p><strong style="color:#b45309">' . esc_html__('İnceleme bekliyor', 'wpteslimat') . '</strong></p>';
            }
        }

        $can_reveal = self::can_reveal();
        $can_op = self::can_operate();
        $nonce = wp_create_nonce('wpteslimat_mb');

        echo '<div class="wpteslimat-mb" data-order="' . esc_attr($remote_id) . '" data-nonce="' . esc_attr($nonce) . '">';

        if (empty($assignments)) {
            echo '<p><em>Aktif teslimat yok.</em></p>';
        } else {
            echo '<ul class="wpteslimat-asg" style="margin:0;padding:0;list-style:none">';
            foreach ($assignments as $a) {
                $aid = isset($a['id']) ? (string) $a['id'] : '';
                if ($aid === '') continue;
                $status = isset($a['status']) ? (string) $a['status'] : '';
                $is_active = ($status === 'active');
                $is_suspended = ($status === 'suspended');
                $is_account = isset($a['kind']) ? ($a['kind'] === 'account') : (!empty($a['maskedFields']));

                echo '<li class="wpteslimat-asg-row" data-assignment="' . esc_attr($aid) . '" style="padding:6px 0;border-top:1px solid #eee">';

                // Maskeli gösterim (reveal ile inline değişecek alan: .wpteslimat-val).
                echo '<div class="wpteslimat-val">';
                if ($is_account && !empty($a['maskedFields']) && is_array($a['maskedFields'])) {
                    foreach ($a['maskedFields'] as $f) {
                        $label = isset($f['label']) ? $f['label'] : '';
                        $val = isset($f['value']) ? $f['value'] : '';
                        echo '<div><strong>' . esc_html($label) . ':</strong> <code>' . esc_html($val) . '</code></div>';
                    }
                } else {
                    $mp = isset($a['maskedPayload']) ? $a['maskedPayload'] : '';
                    echo '<code>' . esc_html($mp) . '</code>';
                }
                echo '</div>';

                // Durum rozeti + kapasite (MAK).
                echo '<div style="font-size:11px;color:#555;margin:2px 0">'
                    . esc_html(self::asg_status_label($status));
                if (!empty($a['maxUses']) && (int) $a['maxUses'] > 1) {
                    echo ' · ' . esc_html((int) ($a['useCount'] ?? 0)) . '/' . esc_html((int) $a['maxUses']) . ' kullanım';
                }
                if (!empty($a['validUntil'])) {
                    echo ' · ' . esc_html__('Geçerlilik:', 'wpteslimat') . ' '
                        . esc_html(Wpteslimat_My_Account::format_date($a['validUntil']));
                }
                echo '</div>';

                // Aksiyon butonları (yetki + duruma göre).
                echo '<div class="wpteslimat-actions" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:3px">';
                if ($can_reveal && ($is_active || $is_suspended)) {
                    echo '<button type="button" class="button button-small wpteslimat-op" data-op="reveal">' . esc_html__('Göster', 'wpteslimat') . '</button>';
                }
                if ($can_op && $is_active) {
                    echo '<button type="button" class="button button-small wpteslimat-op" data-op="replace">' . esc_html__('Değiştir', 'wpteslimat') . '</button>';
                }
                if ($can_op && ($is_active || $is_suspended)) {
                    $sv = $is_suspended ? '0' : '1';
                    $slabel = $is_suspended ? __('Geri aç', 'wpteslimat') : __('Askıya al', 'wpteslimat');
                    echo '<button type="button" class="button button-small wpteslimat-op" data-op="suspend" data-suspend="' . esc_attr($sv) . '">' . esc_html($slabel) . '</button>';
                }
                if ($can_op && ($is_active || $is_suspended)) {
                    echo '<button type="button" class="button button-small wpteslimat-op" data-op="bonus">' . esc_html__('+1 Bonus', 'wpteslimat') . '</button>';
                }
                echo '</div>';
                echo '</li>';
            }
            echo '</ul>';
        }

        // Sipariş-seviyesi: Tekrar Mail (60sn debounce panel tarafında).
        if ($can_op) {
            echo '<p style="margin-top:8px"><button type="button" class="button button-small wpteslimat-op" data-op="resend">' . esc_html__('Teslimat Mailini Tekrar Gönder', 'wpteslimat') . '</button></p>';
        }

        // Değişim geçmişi (§7 "eski anahtar geçmişi altta") — maskeli eski key + sebep + tarih.
        if (!empty($history)) {
            echo '<div class="wpteslimat-history" style="margin-top:10px;border-top:1px solid #ddd;padding-top:6px">';
            echo '<strong style="font-size:12px">' . esc_html__('Değişim Geçmişi', 'wpteslimat') . '</strong>';
            echo '<ul style="margin:4px 0 0;padding-left:16px;font-size:11px;color:#555">';
            foreach ($history as $h) {
                $old = isset($h['oldMasked']) ? $h['oldMasked'] : '—';
                $reason = isset($h['reason']) ? $h['reason'] : '';
                $when = !empty($h['createdAt']) ? Wpteslimat_My_Account::format_date($h['createdAt']) : '';
                $actor = isset($h['actor']) ? $h['actor'] : '';
                echo '<li><code>' . esc_html($old) . '</code>';
                if ($reason !== '') echo ' — ' . esc_html($reason);
                if ($when !== '') echo ' <em>(' . esc_html($when) . ')</em>';
                if ($actor !== '') echo ' · ' . esc_html($actor);
                echo '</li>';
            }
            echo '</ul></div>';
        }

        // "Farklı ürünle değişim" bilinçli olarak panelde: Woo sipariş kalemini de değiştirmek
        // gerektiğinden (senkron kalması için) operatör panelde tam bağlamla yürütür.
        $panel = Wpteslimat_Settings::panel_url();
        if ($panel) {
            echo '<p style="margin-top:8px;font-size:11px"><em>' . esc_html__('Farklı ürünle değişim / iptal için panel arayüzünü kullanın.', 'wpteslimat') . '</em></p>';
        }

        echo '</div>';
        $this->print_script();
    }

    /** Meta box operasyon JS'i — delegated click; her aksiyon panele AJAX ile gider. */
    private function print_script() {
        static $printed = false;
        if ($printed) return;
        $printed = true;
        ?>
        <script>
        (function () {
            var box = document.querySelector('.wpteslimat-mb');
            if (!box) return;
            var orderId = box.getAttribute('data-order');
            var nonce = box.getAttribute('data-nonce');

            function post(action, extra, done) {
                var fd = new FormData();
                fd.append('action', action);
                fd.append('nonce', nonce);
                fd.append('order_id', orderId);
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
                var btn = e.target.closest('.wpteslimat-op');
                if (!btn) return;
                e.preventDefault();
                var op = btn.getAttribute('data-op');
                var row = btn.closest('.wpteslimat-asg-row');
                var aid = row ? row.getAttribute('data-assignment') : '';
                if (btn.disabled) return;

                if (op === 'reveal') {
                    btn.disabled = true;
                    post('wpteslimat_mb_reveal', { assignment_id: aid }, function (j) {
                        btn.disabled = false;
                        if (!j || !j.success) return fail(j);
                        var d = j.data || {};
                        var valEl = row.querySelector('.wpteslimat-val');
                        if (!valEl) return;
                        if (d.fields && d.fields.length) {
                            var html = '';
                            d.fields.forEach(function (f) {
                                html += '<div><strong>' + escapeHtml(f.label || '') + ':</strong> <code>' + escapeHtml(f.value || '') + '</code></div>';
                            });
                            valEl.innerHTML = html;
                        } else if (typeof d.payload === 'string') {
                            valEl.innerHTML = '<code>' + escapeHtml(d.payload) + '</code>';
                        }
                        btn.textContent = 'Gösterildi';
                        btn.disabled = true;
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
                    var sv = btn.getAttribute('data-suspend');
                    btn.disabled = true;
                    post('wpteslimat_mb_suspend', { assignment_id: aid, suspend: sv }, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }

                if (op === 'bonus') {
                    if (!window.confirm('Bu satıra ek (bonus) bir lisans atansın mı?')) return;
                    btn.disabled = true;
                    post('wpteslimat_mb_bonus', { assignment_id: aid }, function (j) {
                        if (!j || !j.success) { btn.disabled = false; return fail(j); }
                        window.location.reload();
                    });
                    return;
                }

                if (op === 'resend') {
                    btn.disabled = true;
                    post('wpteslimat_mb_resend', {}, function (j) {
                        btn.disabled = false;
                        if (!j || !j.success) return fail(j);
                        btn.textContent = 'Gönderildi';
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

    /** Ortak ön-kontrol: nonce + klon guard + geçerli iletilmiş sipariş. Woo sipariş id'sini döner. */
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

    /** Panel yanıtını istemciye ilet (2xx → success, aksi → error + panel mesajı). */
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
        // Atama id'si (UUID) — yalnız güvenli karakterler.
        return preg_replace('/[^A-Za-z0-9\-]/', '', (string) $raw);
    }

    public function ajax_reveal() {
        $remote = $this->guard_request(false); // reveal = manage_options
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/reveal',
            []
        );
        $this->relay($res);
    }

    public function ajax_replace() {
        $remote = $this->guard_request(true);
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        $reason = isset($_POST['reason']) ? sanitize_text_field(wp_unslash($_POST['reason'])) : '';
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        if ($reason === '') wp_send_json_error(['message' => 'Değişim sebebi gerekli.'], 400);
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/replace',
            ['reason' => $reason]
        );
        $this->relay($res);
    }

    public function ajax_suspend() {
        $remote = $this->guard_request(true);
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $suspend = isset($_POST['suspend']) && $_POST['suspend'] === '1';
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/suspend',
            ['suspend' => $suspend]
        );
        $this->relay($res);
    }

    public function ajax_bonus() {
        $remote = $this->guard_request(true);
        $aid = self::sanitize_aid($_POST['assignment_id'] ?? '');
        if ($aid === '') wp_send_json_error(['message' => 'Geçersiz atama.'], 400);
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode($remote) . '/assignments/' . rawurlencode($aid) . '/bonus',
            []
        );
        $this->relay($res);
    }

    public function ajax_resend() {
        $remote = $this->guard_request(true);
        $res = Wpteslimat_Panel_Client::post('/v1/orders/' . rawurlencode($remote) . '/resend', []);
        $this->relay($res);
    }
}
