<?php
if (!defined('ABSPATH')) exit;

/**
 * Panele HMAC imzalı HTTP istemcisi (MIMARI.md §4).
 *   X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))
 */
class Wpteslimat_Panel_Client {

    /**
     * TEK-SEFERLİK aktör geçersiz kılma (§7 "kim yaptı" izlenebilirliği). Arka plan işlerinde
     * (Action Scheduler / wp-cron) oturum açmış kullanıcı YOKTUR; işi TETİKLEYEN mağaza
     * yöneticisi enqueue anında siparişe kaydedilir ve iş işleyicisi panel çağrısından hemen
     * önce buraya koyar. Bir sonraki istekte TÜKETİLİR (temizlenir) → aynı PHP sürecinde koşan
     * sonraki iş yanlış kullanıcıya atfedilmez.
     */
    private static $actor_override = null;

    /**
     * Bir sonraki panel isteğinin aktörünü (WP kullanıcı adı) belirler. Boş/geçersiz değer
     * yok sayılır (mevcut oturum → 'system' zincirine düşer).
     */
    public static function set_actor($login) {
        $login = self::sanitize_actor($login);
        self::$actor_override = ($login === '') ? null : $login;
    }

    /**
     * İsteği yapan WP kullanıcısının adı (audit attribution). Sıra: tek-seferlik geçersiz
     * kılma → oturum açmış kullanıcı → 'system' (cron/webhook/arka plan işi).
     * Panel bunu `wp:<kullanıcı>@<site.domain>` biçiminde birleştirir — domain PANELDEN gelir
     * (güvenilir), bu yüzden burada YALNIZ kullanıcı adı gönderilir (format bozulmaz).
     */
    public static function current_actor() {
        if (self::$actor_override !== null) return self::$actor_override;
        if (function_exists('wp_get_current_user')) {
            $current = wp_get_current_user();
            if ($current && $current->exists()) {
                $login = self::sanitize_actor($current->user_login);
                if ($login !== '') return $login;
            }
        }
        return 'system';
    }

    /**
     * Başlık değeri güvenliği: yalnız güvenli karakterler (CR/LF dâhil her türlü başlık
     * enjeksiyonu elenir) + uzunluk sınırı. 60 karakter panelin `WpActor` sanitizasyonuyla
     * BİREBİR aynıdır → panelde sessizce kırpılma olmaz.
     */
    private static function sanitize_actor($raw) {
        $val = is_scalar($raw) ? (string) $raw : '';
        $val = preg_replace('/[^A-Za-z0-9._@+\- ]/', '', $val);
        $val = trim(preg_replace('/\s+/', ' ', (string) $val));
        return function_exists('mb_substr') ? mb_substr($val, 0, 60) : substr($val, 0, 60);
    }

    /**
     * İmza yolu kanonikleştirme — panel `canonicalizePath` (shared/api/hmac.ts) ile
     * BİREBİR aynı olmalı. Fragment atılır; query param'lar string sıralanır.
     */
    private static function canonical_path($path) {
        $path = (string) $path;
        $hash = strpos($path, '#');
        if ($hash !== false) $path = substr($path, 0, $hash);
        $q = strpos($path, '?');
        if ($q === false) return $path;
        $pathname = substr($path, 0, $q);
        $query = substr($path, $q + 1);
        $parts = array_values(array_filter(explode('&', $query), function ($p) {
            return $p !== '';
        }));
        if (empty($parts)) return $pathname;
        sort($parts, SORT_STRING);
        return $pathname . '?' . implode('&', $parts);
    }

    public static function post($path, array $body, $timeout = 15) {
        return self::request('POST', $path, $body, $timeout);
    }

    public static function get($path, $timeout = 15) {
        return self::request('GET', $path, null, $timeout);
    }

    /**
     * @param int $timeout Saniye. Yazma/async yolları için 15 (varsayılan) uygun; SAYFA RENDER'ı
     *                     içinde senkron çalışan OKUMA yolları (my-account, admin metabox) daha kısa
     *                     (5sn) geçmeli ki panel yavaş/erişilemezken sipariş sayfaları 15sn asılmasın
     *                     (mevcut graceful fallback devreye girer). Cache YOK — sır (§7).
     * @return array{code:int, body:array} — HTTP kodu + çözümlenmiş JSON.
     */
    private static function request($method, $path, $body, $timeout = 15) {
        $panel = Wpteslimat_Settings::panel_url();
        // GÜVENLİK (denetim W1): sırlar (api_key + HMAC imzalı istek) ve reveal yanıtları DÜZ-METİN
        // kanaldan GEÇMEZ. panel_url https değilse (localhost hariç) isteği hiç YAPMA → MITM ile
        // anahtar/e-posta sızıntısı + sahte panel yanıtı engellenir. Panel her zaman TLS (Caddy)
        // arkasındadır; http yalnız yerel geliştirmede (localhost) meşrudur. Fail-safe: kod 0 döner
        // (çağıranlar mevcut graceful/hata yolunu izler; sessiz düz-metin gönderim olmaz).
        if (!Wpteslimat_Settings::is_secure_panel_url($panel)) {
            return ['code' => 0, 'body' => ['error' => 'insecure_panel_url']];
        }
        $url = $panel . $path;
        $body_str = $body === null ? '' : wp_json_encode($body);
        $ts = (string) time();
        $nonce = wp_generate_uuid4();
        $body_hash = hash('sha256', $body_str);

        $payload = strtoupper($method) . "\n" . self::canonical_path($path) . "\n" . $ts . "\n" . $nonce . "\n" . $body_hash;
        $sig = hash_hmac('sha256', $payload, Wpteslimat_Settings::hmac_secret());

        $headers = [
            'X-Api-Key'   => Wpteslimat_Settings::api_key(),
            'X-Timestamp' => $ts,
            'X-Nonce'     => $nonce,
            'X-Signature' => $sig,
            // Trace-Id uçtan uca (§16): panel genReqId bunu yakalayıp req.id yapar ve
            // yanıtta echo eder. HMAC imzasına GİRMEZ (yalnız başlık) — imza payload'i
            // değişmez, yalnızca WP→panel isteği loglarda izlenebilir olur.
            'X-Trace-Id'  => wp_generate_uuid4(),
        ];

        // Audit attribution (§7 "actor: wp:kullanıcı@site"): panel bu başlıktan WP kullanıcısını
        // audit_log.actor'a yazar. YALNIZ audit içindir — YETKİ site HMAC secret'ıyla sağlanır
        // (başlık sahtelense de yetki değişmez). İmzaya GİRMEZ. Oturum yoksa (cron/webhook/arka
        // plan işi) 'system' gider → panelde "wp:system@site" olarak görünür; başlığı hiç
        // göndermemek panelde yanıltıcı 'admin' üretiyordu. createOrder gibi uçlar zaten yok sayar.
        $headers['X-Wp-Actor'] = self::current_actor();
        // Tek-seferlik geçersiz kılma tüketildi → sonraki istek kendi bağlamından çözer.
        self::$actor_override = null;

        // Kurulu eklenti sürümü (§16 görünürlük): panel "hangi sitede hangi sürüm kurulu"
        // bilgisini gösterebilsin diye taşınır — eski sürümde kalmış siteler panelden fark edilir.
        // HMAC İMZASI KAPSAMINDA DEĞİLDİR: imza yalnız METHOD\nPATH\nTS\nNONCE\nSHA256(body)
        // üzerinedir; bu başlık sahtelenebilir ve panel ONA DAYANARAK YETKİ KARARI VERMEZ
        // (X-Wp-Actor ile AYNI SINIF: salt bilgi/gösterim). Yetki her zaman site HMAC secret'ıyla.
        // Sabit tanımlı değilse (kısmi yükleme / sınıfın tek başına include edildiği bağlam)
        // başlık HİÇ eklenmez — savunmalı okuma, fatal üretmez.
        $plugin_version = defined('WPTESLIMAT_VERSION') ? (string) WPTESLIMAT_VERSION : '';
        if ($plugin_version !== '') {
            $headers['X-Wpteslimat-Version'] = $plugin_version;
        }

        $args = [
            'method'  => $method,
            'headers' => $headers,
            'timeout' => $timeout,
        ];
        if ($body !== null) {
            $args['headers']['Content-Type'] = 'application/json';
            $args['body'] = $body_str;
        }

        $res = wp_remote_request($url, $args);
        if (is_wp_error($res)) {
            return ['code' => 0, 'body' => ['error' => $res->get_error_message()]];
        }
        $code = (int) wp_remote_retrieve_response_code($res);
        $decoded = json_decode(wp_remote_retrieve_body($res), true);
        return ['code' => $code, 'body' => is_array($decoded) ? $decoded : []];
    }

    /**
     * Gelen webhook imzasını doğrular (§2). Panel geri-kanal webhook'ları YALNIZ sitenin
     * HMAC secret'iyle imzalar — ayrı bir "webhook secret" API'de YOKTUR. Bu yüzden doğrulama
     * her zaman `Wpteslimat_Settings::hmac_secret()` kullanır (ayrı knob kaldırıldı; tanımlansa
     * panelin imzasıyla eşleşmez ve tüm gelen webhook'lar 401 olurdu).
     */
    public static function verify_webhook($method, $path, $ts, $nonce, $body_str, $signature) {
        $secret = Wpteslimat_Settings::hmac_secret();
        // (#12) Yapılandırılmamış sitede secret boş ('') olur; boş anahtar herkesçe bilinir →
        // saldırgan boş anahtarla geçerli imza üretip sahte webhook geçirebilir. Boş secret'ı
        // hiç doğrulama denemeden reddet.
        if ($secret === '') return false;
        // Zaman penceresi ±300sn (replay).
        if (abs(time() - (int) $ts) > 300) return false;
        $payload = strtoupper($method) . "\n" . self::canonical_path($path) . "\n" . $ts . "\n" . $nonce . "\n" . hash('sha256', $body_str);
        $expected = hash_hmac('sha256', $payload, $secret);
        return hash_equals($expected, (string) $signature);
    }
}
