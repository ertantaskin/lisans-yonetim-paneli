<?php
if (!defined('ABSPATH')) exit;

/**
 * Ayarlar + kimlik bilgisi erişimi. Sırlar (api key, hmac secret) ÖNCELİKLE
 * wp-config.php sabitlerinden okunur (§8 — WP DB'de düz metin option değil).
 * Panel URL sır değildir; option olarak da tutulabilir.
 *
 * "Panele Bağlan" tek-seferlik kod akışı (§7/§14): operatör panelden aldığı
 * tek kullanımlık kodu buraya girer → eklenti kimlik doğrulaması GEREKTİRMEYEN
 * `POST {panel}/v1/connect/claim { code }` çağrısını yapar; panel siteyi eşler
 * ve `{ siteDomain, apiKey, hmacSecret }` döner. Bunlar option'a kaydedilir.
 * Sabit tanımlıysa (WPTESLIMAT_API_KEY vb.) option'lar yok sayılacağı için bu
 * akış devre dışı bırakılır.
 */
class Wpteslimat_Settings {
    private static $instance = null;
    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        add_action('admin_menu', [$this, 'menu']);
        add_action('admin_init', [$this, 'register']);
        add_action('admin_post_wpteslimat_connect', [$this, 'handle_connect']);
        // (#10) Klon/staging koruması taban çizgisini mevcut adrese sıfırlama (yeniden bağla).
        add_action('admin_post_wpteslimat_rebind', [$this, 'handle_rebind']);
        add_action('admin_notices', [$this, 'clone_notice']);
        // Panel adresi güvenlik kapısına takılırsa SESSİZ kalma — operatör nedenini görsün.
        add_action('admin_notices', [$this, 'insecure_panel_notice']);
        // §7 admin bar sağlık göstergesi — her yönetici sayfasında panel bağlantı rozeti.
        add_action('admin_bar_menu', [$this, 'admin_bar_health'], 100);
    }

    /**
     * §7 ADMIN BAR SAĞLIK GÖSTERGESİ: panel bağlanabilirliğini (yeşil/kırmızı) üst-barda gösterir.
     * Her istekte panele gitmemek için sonuç 60sn transient'te cache'lenir. is_clone/yapılandırılmamış
     * durumda uyarı rengi. Tıklandığında Tanılama sekmesine gider.
     */
    public function admin_bar_health($bar) {
        if (!current_user_can('manage_woocommerce') && !current_user_can('manage_options')) return;
        if (!self::is_configured()) {
            $bar->add_node([
                'id'    => 'wpteslimat_health',
                'title' => '⚠ ' . esc_html__('Teslimat: yapılandırılmadı', 'wpteslimat'),
                'href'  => admin_url('options-general.php?page=wpteslimat'),
            ]);
            return;
        }
        if (self::is_clone()) {
            $bar->add_node([
                'id'    => 'wpteslimat_health',
                'title' => '⚠ ' . esc_html__('Teslimat: klon/staging (pasif)', 'wpteslimat'),
                'href'  => admin_url('options-general.php?page=wpteslimat'),
            ]);
            return;
        }
        $ok = get_transient('wpteslimat_health_ok');
        if ($ok === false) {
            // PERFORMANS (denetim): admin bar MAĞAZA ÖN YÜZÜNDE de çizilir (giriş yapmış mağaza
            // yetkilisi vitrini gezerken). Buradaki senkron panel çağrısı 4sn'ye kadar sürebildiği
            // için önbellek her sönümlendiğinde bir MÜŞTERİYE AÇIK sayfa render'ı bloklanıyordu.
            // Ağ yoklaması yalnız YÖNETİM isteklerinde yapılır; ön yüzde sıcak önbellek varsa rozet
            // yine gösterilir, yoksa rozet çizilmez (teşhis zaten yönetim tarafında yapılır).
            if (!is_admin()) return;
            $res = Wpteslimat_Panel_Client::get('/v1/health', 4);
            $ok = (isset($res['code']) && $res['code'] === 200 && isset($res['body']['status']) && $res['body']['status'] === 'ok') ? '1' : '0';
            set_transient('wpteslimat_health_ok', $ok, 60);
        }
        $green = ($ok === '1');
        $bar->add_node([
            'id'    => 'wpteslimat_health',
            'title' => ($green ? '🟢 ' : '🔴 ') . esc_html__('Teslimat', 'wpteslimat'),
            'href'  => admin_url('options-general.php?page=wpteslimat&wpteslimat_diag=1'),
            'meta'  => ['title' => $green ? __('Panel bağlantısı sağlıklı', 'wpteslimat') : __('Panele ulaşılamıyor — tanılamayı çalıştırın', 'wpteslimat')],
        ]);
    }

    /**
     * §7 TANILAMA: panel bağlantısı + HMAC kimlik + geri-kanal webhook erişilebilirliği (Cloudflare/
     * WAF) + saat kayması + sürüm. Ayarlar sayfasında ?wpteslimat_diag=1 ile çalıştırılır (canlı,
     * her sayfa yükünde DEĞİL). Her kontrol yeşil/kırmızı + kısa açıklama döner. SIR göstermez.
     */
    private static function run_diagnostics() {
        $checks = [];

        // 1) Panel bağlantısı (public /v1/health).
        $h = Wpteslimat_Panel_Client::get('/v1/health', 5);
        $hcode = isset($h['code']) ? (int) $h['code'] : 0;
        $hbody = isset($h['body']) && is_array($h['body']) ? $h['body'] : [];
        $hok = ($hcode === 200 || $hcode === 503) && !empty($hbody['status']);
        $checks[] = [
            'label' => __('Panel bağlantısı', 'wpteslimat'),
            'ok'    => $hok && ($hbody['status'] === 'ok'),
            'detail'=> $hok
                ? sprintf('%s · DB %s · Redis %s', $hbody['status'],
                    (!empty($hbody['checks']['db']) ? '✓' : '✗'),
                    (!empty($hbody['checks']['redis']) ? '✓' : '✗'))
                : sprintf(__('ulaşılamadı (HTTP %d)', 'wpteslimat'), $hcode),
        ];

        // 2) HMAC kimlik doğrulama — imzalı boş bulk-status (200 [] = kimlik OK, 401 = imza/anahtar hatalı).
        $auth = Wpteslimat_Panel_Client::post('/v1/orders/bulk-status', ['remoteOrderIds' => []]);
        $acode = isset($auth['code']) ? (int) $auth['code'] : 0;
        $checks[] = [
            'label' => __('HMAC kimlik doğrulama', 'wpteslimat'),
            'ok'    => ($acode >= 200 && $acode < 300),
            'detail'=> ($acode >= 200 && $acode < 300)
                ? __('geçerli (api_key + imza doğru)', 'wpteslimat')
                : sprintf(__('reddedildi (HTTP %d) — api_key/hmac_secret veya saat kayması', 'wpteslimat'), $acode),
        ];

        // 3) Geri-kanal webhook erişilebilirliği (Cloudflare/WAF). Kendi webhook URL'ine imzasız POST →
        //    401 invalid_signature = ERİŞİLEBİLİR (panel→WP yolu açık); 403/timeout/HTML = WAF/CDN blokluyor.
        $wurl = rest_url('wpteslimat/v1/webhook');
        $wp_res = wp_remote_post($wurl, ['timeout' => 6, 'body' => '{}', 'headers' => ['Content-Type' => 'application/json']]);
        if (is_wp_error($wp_res)) {
            $checks[] = ['label' => __('Webhook erişilebilirliği', 'wpteslimat'), 'ok' => false,
                'detail' => __('ulaşılamadı: ', 'wpteslimat') . $wp_res->get_error_message()];
        } else {
            $wcode = (int) wp_remote_retrieve_response_code($wp_res);
            // 401 = ulaşılabilir + işliyor (imza reddi beklenir); 200 (duplicate/ok) da erişilebilir.
            $reachable = in_array($wcode, [200, 400, 401], true);
            $checks[] = ['label' => __('Webhook erişilebilirliği', 'wpteslimat'), 'ok' => $reachable,
                'detail' => $reachable
                    ? sprintf(__('erişilebilir (HTTP %d)', 'wpteslimat'), $wcode)
                    : sprintf(__('BLOKLU (HTTP %d) — Cloudflare/WAF geri-kanal webhook\'u engelliyor olabilir', 'wpteslimat'), $wcode)];
        }

        // 4) Saat kayması — panel /health "time" (ISO) ile yerel saat farkı. HMAC ±300sn penceresi
        //    tıkanmadan uyar: >60sn sarı, >240sn kırmızı (imza reddinin kritik ipucu).
        if (!empty($hbody['time'])) {
            $skew = abs(time() - (int) strtotime((string) $hbody['time']));
            $checks[] = ['label' => __('Saat kayması', 'wpteslimat'), 'ok' => ($skew <= 60),
                'detail' => sprintf(__('~%d sn%s', 'wpteslimat'), $skew,
                    $skew > 240 ? __(' — KRİTİK: sunucu saatini NTP ile eşitleyin', 'wpteslimat')
                    : ($skew > 60 ? __(' — dikkat: saat sapması artıyor', 'wpteslimat') : ''))];
        }

        // 5) Sürüm.
        $checks[] = ['label' => __('Sürüm', 'wpteslimat'), 'ok' => true,
            'detail' => sprintf(__('eklenti v%s · panel v%s', 'wpteslimat'),
                WPTESLIMAT_VERSION, !empty($hbody['version']) ? $hbody['version'] : '—')];

        return $checks;
    }

    public static function panel_url() {
        if (defined('WPTESLIMAT_PANEL_URL')) return rtrim(WPTESLIMAT_PANEL_URL, '/');
        return rtrim((string) get_option('wpteslimat_panel_url', ''), '/');
    }
    public static function api_key() {
        return defined('WPTESLIMAT_API_KEY') ? WPTESLIMAT_API_KEY : (string) get_option('wpteslimat_api_key', '');
    }
    public static function hmac_secret() {
        return defined('WPTESLIMAT_HMAC_SECRET') ? WPTESLIMAT_HMAC_SECRET : (string) get_option('wpteslimat_hmac_secret', '');
    }
    public static function is_configured() {
        return self::panel_url() && self::api_key() && self::hmac_secret();
    }

    /**
     * Staging/klon koruması (§7 "URL değişince pasif mod"). Taban çizgisi (beklenen home_url) üç
     * kaynaktan gelebilir, öncelik sırasıyla: (1) wp-config.php'de WPTESLIMAT_BOUND_HOME sabiti
     * (sabit-tabanlı kurulumların operatörü beklenen adresi açıkça sabitleyebilir); (2) aktivasyonda
     * yazılan `wpteslimat_bound_home` option'ı (prod'da kurulumda sabitlenir, klon DB bunu devralır);
     * (3) "Panele Bağlan" akışının yazdığı aynı option. Site başka bir alan adına klonlanırsa (prod →
     * staging, aynı wp-config → aynı api_key/hmac_secret) home_url DEĞİŞİR ve klon gerçek panele push
     * edip CANLI stoğu tüketebilir / gerçek müşterinin lisansını geri alabilir. Bu kontrol o durumu yakalar.
     *
     * Baseline HİÇ yoksa (aktivasyon çalışmamış + sabit yok) false döner — kontrol atlanır (güvenli
     * varsayılan); korumayı etkinleştirmek için yeniden aktivasyon veya sabit tanımı yeterlidir.
     */
    /** Klon-koruma taban çizgisi: sabit → aktivasyon/connect option (is_clone + clone_notice ORTAK kaynak). */
    private static function bound_home() {
        return (defined('WPTESLIMAT_BOUND_HOME') && WPTESLIMAT_BOUND_HOME)
            ? (string) WPTESLIMAT_BOUND_HOME
            : (string) get_option('wpteslimat_bound_home', '');
    }

    public static function is_clone() {
        $bound = self::bound_home();
        if ($bound === '') return false;
        // Şema-BAĞIMSIZ karşılaştır: HTTP→HTTPS geçişi (SSL kurulumu — çok yaygın) siteyi yanlışlıkla
        // 'klon' sanıp siparişleri sessizce durdurmasın. Gerçek klon (prod→staging) HOST'u değiştirdiği
        // için yine yakalanır; yalnız aynı-host / farklı-şema yanlış-pozitifi giderilir.
        $strip = static function ($u) {
            return untrailingslashit(strtolower(preg_replace('#^https?://#i', '', (string) $u)));
        };
        return $strip(home_url()) !== $strip($bound);
    }

    /** Kopya/staging tespit edilirse yönetici panelinde kalıcı uyarı gösterir. */
    public function clone_notice() {
        if (!self::is_clone()) return;
        if (!current_user_can('manage_options')) return;
        // Beklenen adresi is_clone() ile AYNI kaynaktan al (sabit-tabanlı kurulumda boş '()' göstermesin).
        $bound = self::bound_home();
        echo '<div class="notice notice-error"><p>' . esc_html(sprintf(
            'Teslimat eklentisi: Site adresi (%s) bağlanma anındaki adresten (%s) farklı. Kopya/staging koruması etkin: ' .
            'siparişler panele İLETİLMİYOR (canlı stok korunur). Bu kasıtlı bir taşımaysa Ayarlar → Teslimat Eklentisi ' .
            'sayfasındaki "Bu adrese yeniden bağla" ile taban çizgisini sıfırlayın.',
            home_url(),
            $bound
        )) . '</p></div>';
    }

    /**
     * SIR kimlik bilgileri (apiKey/hmacSecret) sabitle tanımlı mı? "Panele Bağlan"
     * akışının tek amacı bu sırları panelden çekip option'a yazmaktır; sırlar sabitse
     * yazılan option'lar yok sayılacağından akış anlamsızdır (devre dışı).
     *
     * NOT: Sırsız WPTESLIMAT_PANEL_URL sabiti bu akışı KİLİTLEMEZ — yalnız panel
     * adresi sabitken token/secret alma akışı geçerli kalmalıdır (panel URL yine
     * connect isteğinde `self::panel_url()` sabit değerinden gelir).
     */
    private static function has_const() {
        return defined('WPTESLIMAT_API_KEY') || defined('WPTESLIMAT_HMAC_SECRET');
    }

    /**
     * Panel URL güvenli mi? "Panele Bağlan" yanıtı sırları düz metin döndürdüğü
     * için https zorunludur; yalnız yerel geliştirme adresleri (localhost/127.0.0.1/::1)
     * http'ye izinlidir. PUBLIC (denetim W1): panel-client istek yolu ve eklenti güncelleyici
     * de bu kapıyı kullanır → düz-metin panelde sır sızıntısı + MITM ile kötücül eklenti
     * kurulumu (RCE) önlenir (connect akışının dışında da güvenli kanal zorlanır).
     */
    public static function is_secure_panel_url($url) {
        $host = strtolower((string) wp_parse_url($url, PHP_URL_HOST));
        $scheme = strtolower((string) wp_parse_url($url, PHP_URL_SCHEME));
        if ($scheme === 'https') {
            return true;
        }
        // http YALNIZ kanıtlanabilir şekilde ÖZEL/yerel adreslerde kabul edilir. Tehdit modeli
        // MITM'dir: trafik makineyi/özel ağı TERK ETMİYORSA araya girecek bir ağ yoktur. Panel ile
        // WP aynı sunucuda/Docker ağındayken (yaygın tek-sunucu kurulumu ve bizim izole dev yığınımız)
        // adres `http://api:3001` gibi İÇ bir addır ve TLS sonlandırıcı (Caddy) devrede değildir.
        // (REGRESYON DERSİ: bu kapı önce yalnız localhost'a izin veriyordu → iç adresli kurulumda
        // eklenti panele HİÇ istek yapmadı, teslimatlar WP'de görünmez oldu; hata SESSİZDİ.)
        return self::is_private_host($host);
    }

    /**
     * Host kanıtlanabilir şekilde ÖZEL/yönlendirilemez mi? (public DNS'te var olamayacak adresler)
     *   · loopback: localhost / 127.0.0.0/8 / ::1
     *   · TEK ETİKETLİ ad (nokta YOK): Docker/Compose servis adı (`api`, `panel`) — public DNS'te çözülemez
     *   · özel IPv4: 10/8, 172.16/12, 192.168/16, 169.254/16 (link-local)
     *   · özel IPv6: fc00::/7 (ULA), fe80::/10 (link-local)
     *   · ayrılmış son ekler: .local .internal .test .localhost .home.arpa
     * Bunların DIŞINDAKİ her ad (gerçek alan adı) http ile REDDEDİLİR → sır düz metin gitmez.
     */
    private static function is_private_host($host) {
        if ($host === '') {
            return false;
        }
        $host = trim($host, '[]'); // IPv6 literal köşeli parantezleri
        if ($host === 'localhost' || $host === '::1') {
            return true;
        }
        // Tek etiketli ad (nokta içermeyen, IP olmayan) → yalnız iç ağda çözülebilir.
        if (strpos($host, '.') === false && strpos($host, ':') === false
            && !filter_var($host, FILTER_VALIDATE_IP)) {
            return true;
        }
        foreach (['.local', '.internal', '.test', '.localhost', '.home.arpa'] as $suffix) {
            if (substr($host, -strlen($suffix)) === $suffix) {
                return true;
            }
        }
        if (filter_var($host, FILTER_VALIDATE_IP)) {
            // Özel/ayrılmış aralık DIŞINDAKİ (yani genel yönlendirilebilir) IP'ler reddedilir.
            $public = filter_var(
                $host,
                FILTER_VALIDATE_IP,
                FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE
            );
            return $public === false;
        }
        return false;
    }

    /**
     * Panel adresi güvenlik kapısına takıldıysa yöneticiye GÖRÜNÜR uyarı bas. Eskiden bu blok
     * SESSİZDİ: eklenti hiçbir istek yapmıyor, sipariş/teslimat panele gitmiyor ama operatör
     * yalnız "Lisans bilgileriniz şu an görüntülenemiyor" mesajını görüp nedenini bilemiyordu.
     */
    public function insecure_panel_notice() {
        if (!current_user_can('manage_options')) return;
        $panel = self::panel_url();
        if ($panel === '' || self::is_secure_panel_url($panel)) return;
        echo '<div class="notice notice-error"><p>' . esc_html(sprintf(
            'Teslimat eklentisi: Panel adresi (%s) güvenli değil — sırlar düz metin kanaldan ' .
            'gönderilmesin diye panele HİÇBİR istek yapılmıyor (sipariş iletimi ve lisans görüntüleme ' .
            'DEVRE DIŞI). Adresi https:// yapın; iç ağ/aynı sunucu kurulumunda http yalnız yerel ' .
            'adreslerde (localhost, 10.x, 192.168.x, Docker servis adı, *.local) kabul edilir.',
            $panel
        )) . '</p></div>';
    }

    public function menu() {
        add_options_page('WP Teslimat Eklentisi', 'Teslimat Eklentisi', 'manage_options', 'wpteslimat', [$this, 'page']);
    }

    public function register() {
        register_setting('wpteslimat', 'wpteslimat_panel_url');
        // (#14) Sır alanları (api_key/hmac_secret) formda value ile ÖN-DOLDURULMAZ; boş POST'ta
        // mevcut option KORUNUR (yalnız yeni değer girilince güncellenir). Aksi halde operatör
        // yalnız panel URL'ini değiştirmek için kaydettiğinde boş sır alanları mevcut sırları
        // silerdi. Bu, WP API-anahtarı alanlarının standart güvenli desenidir.
        register_setting('wpteslimat', 'wpteslimat_api_key', [
            'type'              => 'string',
            'sanitize_callback' => [$this, 'sanitize_api_key'],
        ]);
        register_setting('wpteslimat', 'wpteslimat_hmac_secret', [
            'type'              => 'string',
            'sanitize_callback' => [$this, 'sanitize_hmac_secret'],
        ]);
    }

    /** (#14) Boş girilirse mevcut api_key korunur; doluysa temizlenip yazılır. */
    public function sanitize_api_key($value) {
        $value = is_string($value) ? trim($value) : '';
        if ($value === '') return (string) get_option('wpteslimat_api_key', '');
        return sanitize_text_field($value);
    }

    /** (#14) Boş girilirse mevcut hmac_secret korunur; doluysa temizlenip yazılır. */
    public function sanitize_hmac_secret($value) {
        $value = is_string($value) ? trim($value) : '';
        if ($value === '') return (string) get_option('wpteslimat_hmac_secret', '');
        return sanitize_text_field($value);
    }

    public function page() {
        $configured = self::is_configured();
        $has_const  = self::has_const();
        ?>
        <div class="wrap">
            <h1>WP Teslimat Eklentisi</h1>
            <?php self::render_connect_notice(); ?>
            <p>Durum:
                <?php if ($configured): ?>
                    <strong style="color:#1a7f5a">✓ Yapılandırıldı</strong> — panel: <?php echo esc_html(self::panel_url()); ?>
                <?php else: ?>
                    <strong style="color:#c0392b">✗ Eksik</strong>
                <?php endif; ?>
            </p>

            <?php if (self::is_clone()): ?>
                <hr>
                <h2><?php esc_html_e('Bu adrese yeniden bağla', 'wpteslimat'); ?></h2>
                <?php if (defined('WPTESLIMAT_BOUND_HOME') && WPTESLIMAT_BOUND_HOME): ?>
                    <p><em><?php echo esc_html(sprintf(
                        /* translators: 1: sabitteki beklenen adres, 2: mevcut adres */
                        __('Beklenen adres wp-config.php\'de WPTESLIMAT_BOUND_HOME sabitiyle sabitlenmiş (%1$s). Bu taşıma kalıcıysa taban çizgisini panelden değil, sabiti mevcut adrese (%2$s) güncelleyerek sıfırlayın.', 'wpteslimat'),
                        (string) WPTESLIMAT_BOUND_HOME,
                        home_url()
                    )); ?></em></p>
                <?php else: ?>
                    <p><?php echo esc_html(sprintf(
                        /* translators: %s: mevcut site adresi */
                        __('Klon/staging koruması etkin: mevcut adres (%s) taban çizgisinden farklı olduğundan siparişler panele iletilmiyor. Bu taşıma kalıcıysa taban çizgisini bu adrese sıfırlayın; koruma yeniden etkin olur ve siparişler iletilmeye devam eder.', 'wpteslimat'),
                        home_url()
                    )); ?></p>
                    <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                        <input type="hidden" name="action" value="wpteslimat_rebind">
                        <?php wp_nonce_field('wpteslimat_rebind'); ?>
                        <?php submit_button(__('Bu adrese yeniden bağla (taban çizgisini sıfırla)', 'wpteslimat'), 'primary', 'submit', false); ?>
                    </form>
                <?php endif; ?>
            <?php endif; ?>

            <hr>
            <h2><?php esc_html_e('Tanılama', 'wpteslimat'); ?></h2>
            <?php if (isset($_GET['wpteslimat_diag'])): ?>
                <?php $diag = self::run_diagnostics(); ?>
                <table class="widefat" style="max-width:680px">
                    <tbody>
                    <?php foreach ($diag as $c): ?>
                        <tr>
                            <td style="width:24px"><?php echo $c['ok'] ? '🟢' : '🔴'; ?></td>
                            <td style="width:200px"><strong><?php echo esc_html($c['label']); ?></strong></td>
                            <td><?php echo esc_html($c['detail']); ?></td>
                        </tr>
                    <?php endforeach; ?>
                    </tbody>
                </table>
                <p><a href="<?php echo esc_url(admin_url('options-general.php?page=wpteslimat&wpteslimat_diag=1')); ?>" class="button"><?php esc_html_e('Yeniden çalıştır', 'wpteslimat'); ?></a></p>
            <?php else: ?>
                <p><?php esc_html_e('Panel bağlantısı, HMAC kimlik, webhook erişilebilirliği (Cloudflare/WAF), saat kayması ve sürümü canlı test eder.', 'wpteslimat'); ?></p>
                <?php if ($configured): ?>
                    <a href="<?php echo esc_url(admin_url('options-general.php?page=wpteslimat&wpteslimat_diag=1')); ?>" class="button button-secondary"><?php esc_html_e('Tanılamayı çalıştır', 'wpteslimat'); ?></a>
                <?php else: ?>
                    <p><em><?php esc_html_e('Önce panele bağlanın.', 'wpteslimat'); ?></em></p>
                <?php endif; ?>
            <?php endif; ?>

            <?php Wpteslimat_Catalog_Sync::render_settings_section(); ?>

            <hr>
            <h2>Panele Bağlan (tek seferlik kod)</h2>
            <p>Panel yönetim arayüzünden aldığınız <strong>tek kullanımlık bağlan kodunu</strong> girin;
               eklenti API anahtarı ve HMAC sırrını panelden otomatik alıp kaydeder.</p>
            <?php if ($has_const): ?>
                <p><strong style="color:#b26a00">Sabit tanımlı — kod ile bağlama devre dışı.</strong>
                   Kimlik bilgileri <code>wp-config.php</code> sabitlerinden okunuyor.</p>
            <?php else: ?>
                <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                    <input type="hidden" name="action" value="wpteslimat_connect">
                    <?php wp_nonce_field('wpteslimat_connect'); ?>
                    <table class="form-table">
                        <tr>
                            <th><label for="wpt-connect-panel">Panel URL</label></th>
                            <td>
                                <input type="url" id="wpt-connect-panel" name="panel_url" required
                                       value="<?php echo esc_attr(get_option('wpteslimat_panel_url', '')); ?>"
                                       placeholder="https://api.167-233-108-12.sslip.io" class="regular-text">
                            </td>
                        </tr>
                        <tr>
                            <th><label for="wpt-connect-code">Bağlan Kodu</label></th>
                            <td>
                                <input type="text" id="wpt-connect-code" name="connect_code" required
                                       autocomplete="off" class="regular-text">
                                <br><small>Panelden alınan tek kullanımlık koddur; bir kez kullanılır.</small>
                            </td>
                        </tr>
                    </table>
                    <?php submit_button('Panele Bağlan', 'primary', 'submit', false); ?>
                </form>
            <?php endif; ?>

            <hr>
            <h2>Gelişmiş — kimlik bilgilerini el ile gir</h2>
            <p><em>Güvenlik önerisi (§8):</em> sırları <code>wp-config.php</code>'ye sabit olarak ekleyin:</p>
            <pre style="background:#f6f7f7;padding:12px;border-radius:6px">define('WPTESLIMAT_PANEL_URL', 'https://api.panel.example');
define('WPTESLIMAT_API_KEY', 'wpt_...');
define('WPTESLIMAT_HMAC_SECRET', '...');</pre>
            <form method="post" action="options.php">
                <?php settings_fields('wpteslimat'); ?>
                <?php
                // (#14) Sırlar value ile BASILMAZ (ekranda/DOM'da düz metin görünmez). Bunun yerine
                // "ayarlı/ayarsız" rozeti gösterilir; boş bırakılırsa kayıt işleyicisi mevcut değeri korur.
                $api_set  = defined('WPTESLIMAT_API_KEY') || get_option('wpteslimat_api_key', '') !== '';
                $hmac_set = defined('WPTESLIMAT_HMAC_SECRET') || get_option('wpteslimat_hmac_secret', '') !== '';
                ?>
                <table class="form-table">
                    <tr><th>Panel URL</th><td><input type="url" name="wpteslimat_panel_url" value="<?php echo esc_attr(get_option('wpteslimat_panel_url', '')); ?>" class="regular-text" <?php disabled(defined('WPTESLIMAT_PANEL_URL')); ?>></td></tr>
                    <tr><th>API Key</th><td>
                        <input type="text" name="wpteslimat_api_key" value="" autocomplete="off" class="regular-text"
                               placeholder="<?php echo $api_set ? esc_attr__('•••••• (ayarlı — değiştirmek için yeni değer girin)', 'wpteslimat') : esc_attr__('ayarlanmadı', 'wpteslimat'); ?>"
                               <?php disabled(defined('WPTESLIMAT_API_KEY')); ?>>
                        <br><small>
                            <?php echo $api_set
                                ? esc_html__('Ayarlı. Boş bırakılırsa mevcut değer korunur.', 'wpteslimat')
                                : esc_html__('Henüz ayarlanmadı.', 'wpteslimat'); ?>
                            <?php if (defined('WPTESLIMAT_API_KEY')) echo ' ' . esc_html__('Sabit tanımlı — buradan değiştirilemez.', 'wpteslimat'); ?>
                        </small>
                    </td></tr>
                    <tr><th>HMAC Secret</th><td>
                        <input type="password" name="wpteslimat_hmac_secret" value="" autocomplete="new-password" class="regular-text"
                               placeholder="<?php echo $hmac_set ? esc_attr__('•••••• (ayarlı — değiştirmek için yeni değer girin)', 'wpteslimat') : esc_attr__('ayarlanmadı', 'wpteslimat'); ?>"
                               <?php disabled(defined('WPTESLIMAT_HMAC_SECRET')); ?>>
                        <br><small>
                            <?php echo $hmac_set
                                ? esc_html__('Ayarlı. Boş bırakılırsa mevcut değer korunur.', 'wpteslimat')
                                : esc_html__('Henüz ayarlanmadı.', 'wpteslimat'); ?>
                            <?php if (defined('WPTESLIMAT_HMAC_SECRET')) echo ' ' . esc_html__('Sabit tanımlı — buradan değiştirilemez.', 'wpteslimat'); ?>
                        </small>
                    </td></tr>
                </table>
                <?php submit_button(); ?>
            </form>
        </div>
        <?php
    }

    /**
     * "Panele Bağlan" işlem sonucu bildirimi (redirect query arg üzerinden).
     * Ayar sayfası başında çağrılır.
     */
    private static function render_connect_notice() {
        if (!isset($_GET['wpteslimat_connect'])) return;
        $flag = sanitize_key(wp_unslash($_GET['wpteslimat_connect']));
        $msg  = isset($_GET['wpteslimat_msg'])
            ? sanitize_text_field(wp_unslash($_GET['wpteslimat_msg'])) : '';

        if ($flag === 'ok') {
            $text = $msg !== ''
                ? sprintf('Panele bağlanıldı (site: %s).', $msg)
                : 'Panele bağlanıldı.';
            echo '<div class="notice notice-success is-dismissible"><p>' . esc_html($text) . '</p></div>';
        } elseif ($flag === 'missing') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html('Panel URL ve bağlan kodu zorunludur.') . '</p></div>';
        } elseif ($flag === 'const') {
            echo '<div class="notice notice-warning is-dismissible"><p>' .
                esc_html('Sabit tanımlı — kod ile bağlama devre dışı.') . '</p></div>';
        } elseif ($flag === 'insecure') {
            echo '<div class="notice notice-error is-dismissible"><p>' .
                esc_html('Panel adresi https değil. Kimlik bilgileri düz metin gönderileceğinden bağlantı yapılmadı; güvenli (https) bir panel adresi girin.') .
                '</p></div>';
        } elseif ($flag === 'rebound') {
            echo '<div class="notice notice-success is-dismissible"><p>' .
                esc_html('Taban çizgisi bu adrese sıfırlandı. Klon/staging koruması artık bu adrese göre çalışır; siparişler panele iletilecek.') .
                '</p></div>';
        } elseif ($flag === 'error') {
            $text = $msg !== ''
                ? sprintf('Panele bağlanılamadı: %s', $msg)
                : 'Panele bağlanılamadı. Kodu ve panel adresini kontrol edin.';
            echo '<div class="notice notice-error is-dismissible"><p>' . esc_html($text) . '</p></div>';
        }
    }

    /**
     * (#10) Klon/staging koruması taban çizgisini MEVCUT adrese sıfırlar ("bu adrese yeniden bağla").
     * Site meşru olarak yeni bir alana taşınınca is_clone()=true olur ve push/revoke sessizce durur;
     * sırlar wp-config sabitleriyle tanımlıysa (has_const) normal "Panele Bağlan" formu devre dışıdır →
     * taban çizgisini sıfırlamanın başka yolu kalmaz. `wpteslimat_bound_home` option'ı SIRDAN BAĞIMSIZ
     * olduğundan sabit-tabanlı kurulumda da yazılabilir (yalnız WPTESLIMAT_BOUND_HOME sabiti tanımlıysa
     * o öncelikli olur ve bu form gösterilmez — o durumda sabit güncellenir).
     */
    public function handle_rebind() {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html('Bu işlem için yetkiniz yok.'), '', ['response' => 403]);
        }
        check_admin_referer('wpteslimat_rebind');
        update_option('wpteslimat_bound_home', home_url());
        self::redirect_settings('rebound');
    }

    /**
     * "Panele Bağlan" form gönderimini işler: yetki + nonce doğrula → panele
     * kimlik doğrulamasız `POST /v1/connect/claim { code }` → dönen kimlik
     * bilgilerini option'a kaydet → ayar sayfasına geri yönlendir.
     */
    public function handle_connect() {
        if (!current_user_can('manage_options')) {
            wp_die(esc_html('Bu işlem için yetkiniz yok.'), '', ['response' => 403]);
        }
        check_admin_referer('wpteslimat_connect');

        // Sabit tanımlıysa option yazımı yok sayılır — akış devre dışı.
        if (self::has_const()) {
            self::redirect_settings('const');
        }

        $panel = isset($_POST['panel_url'])
            ? rtrim(esc_url_raw(trim(wp_unslash($_POST['panel_url']))), '/') : '';
        $code = isset($_POST['connect_code'])
            ? sanitize_text_field(wp_unslash($_POST['connect_code'])) : '';

        if ($panel === '' || $code === '') {
            self::redirect_settings('missing');
        }

        // Yanıt kimlik bilgilerini (apiKey/hmacSecret) DÜZ METİN döndürür; panel
        // https değilse sırlar ağda açık geçer — göndermeden reddet (yerel geliştirme
        // için localhost/127.0.0.1 istisna).
        if (!self::is_secure_panel_url($panel)) {
            self::redirect_settings('insecure');
        }

        // Kendi geri-kanal webhook adresini de gönder → panel (host doğrulamalı) sites.webhookUrl'e
        // yazar; böylece bağlan-kod akışıyla kurulan sitede order.fulfilled/partial webhook'ları
        // GERÇEKTEN gönderilir (eskiden yalnız {code} gidiyordu → webhookUrl NULL kalıp sessizce atlanırdı).
        $res = wp_remote_post($panel . '/v1/connect/claim', [
            'timeout' => 15,
            'headers' => ['Content-Type' => 'application/json'],
            'body'    => wp_json_encode([
                'code'       => $code,
                'webhookUrl' => rest_url('wpteslimat/v1/webhook'),
            ]),
        ]);

        if (is_wp_error($res)) {
            self::redirect_settings('error', $res->get_error_message());
        }

        $http = (int) wp_remote_retrieve_response_code($res);
        $data = json_decode(wp_remote_retrieve_body($res), true);

        if ($http < 200 || $http >= 300 || !is_array($data) ||
            empty($data['apiKey']) || empty($data['hmacSecret'])) {
            $err = is_array($data) && !empty($data['error']) ? (string) $data['error'] : '';
            self::redirect_settings('error', $err);
        }

        update_option('wpteslimat_panel_url', $panel);
        update_option('wpteslimat_api_key', (string) $data['apiKey']);
        update_option('wpteslimat_hmac_secret', (string) $data['hmacSecret']);
        // Staging/klon koruması baseline'ı (§7): bağlanma anındaki site adresi. Site başka
        // alana klonlanırsa is_clone() bunu yakalar ve push'u pasifleştirir.
        update_option('wpteslimat_bound_home', home_url());
        // Katalog hash'ini SIFIRLA: yeni/farklı panele bağlanınca panel kataloğu BOŞ'tur; hash
        // kalırsa (ürün değişmediği sürece) hash-skip yeniden push'u engeller → panel kalıcı boş
        // kalırdı (§3 denetim bulgusu). Silince sonraki senkron zorla full snapshot iter.
        delete_option('wpteslimat_catalog_hash');

        $domain = isset($data['siteDomain']) ? (string) $data['siteDomain'] : '';
        self::redirect_settings('ok', $domain);
    }

    /** Ayar sayfasına sonuç bayrağıyla (ve varsa mesajla) geri yönlendirir. */
    private static function redirect_settings($flag, $detail = '') {
        $url = add_query_arg('wpteslimat_connect', $flag, admin_url('options-general.php?page=wpteslimat'));
        if ($detail !== '') {
            $url = add_query_arg('wpteslimat_msg', rawurlencode($detail), $url);
        }
        wp_safe_redirect($url);
        exit;
    }
}
