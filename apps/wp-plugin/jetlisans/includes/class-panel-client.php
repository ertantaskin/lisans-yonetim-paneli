<?php
if (!defined('ABSPATH')) exit;

/**
 * Panele HMAC imzalı HTTP istemcisi (MIMARI.md §4).
 *   X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))
 */
class Jetlisans_Panel_Client {

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

    public static function post($path, array $body) {
        return self::request('POST', $path, $body);
    }

    public static function get($path) {
        return self::request('GET', $path, null);
    }

    /**
     * @return array{code:int, body:array} — HTTP kodu + çözümlenmiş JSON.
     */
    private static function request($method, $path, $body) {
        $url = Jetlisans_Settings::panel_url() . $path;
        $body_str = $body === null ? '' : wp_json_encode($body);
        $ts = (string) time();
        $nonce = wp_generate_uuid4();
        $body_hash = hash('sha256', $body_str);

        $payload = strtoupper($method) . "\n" . self::canonical_path($path) . "\n" . $ts . "\n" . $nonce . "\n" . $body_hash;
        $sig = hash_hmac('sha256', $payload, Jetlisans_Settings::hmac_secret());

        $headers = [
            'X-Api-Key'   => Jetlisans_Settings::api_key(),
            'X-Timestamp' => $ts,
            'X-Nonce'     => $nonce,
            'X-Signature' => $sig,
            // Trace-Id uçtan uca (§16): panel genReqId bunu yakalayıp req.id yapar ve
            // yanıtta echo eder. HMAC imzasına GİRMEZ (yalnız başlık) — imza payload'i
            // değişmez, yalnızca WP→panel isteği loglarda izlenebilir olur.
            'X-Trace-Id'  => wp_generate_uuid4(),
        ];
        $args = [
            'method'  => $method,
            'headers' => $headers,
            'timeout' => 15,
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
     * her zaman `Jetlisans_Settings::hmac_secret()` kullanır (ayrı knob kaldırıldı; tanımlansa
     * panelin imzasıyla eşleşmez ve tüm gelen webhook'lar 401 olurdu).
     */
    public static function verify_webhook($method, $path, $ts, $nonce, $body_str, $signature) {
        $secret = Jetlisans_Settings::hmac_secret();
        // Zaman penceresi ±300sn (replay).
        if (abs(time() - (int) $ts) > 300) return false;
        $payload = strtoupper($method) . "\n" . self::canonical_path($path) . "\n" . $ts . "\n" . $nonce . "\n" . hash('sha256', $body_str);
        $expected = hash_hmac('sha256', $payload, $secret);
        return hash_equals($expected, (string) $signature);
    }
}
