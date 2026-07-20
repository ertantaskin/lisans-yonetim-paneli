<?php
if (!defined('ABSPATH')) exit;

/**
 * Panele HMAC imzalı HTTP istemcisi (MIMARI.md §4).
 *   X-Signature = HMAC-SHA256(secret, METHOD\nPATH\nTS\nNONCE\nSHA256(body))
 */
class Jetlisans_Panel_Client {

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

        $payload = strtoupper($method) . "\n" . $path . "\n" . $ts . "\n" . $nonce . "\n" . $body_hash;
        $sig = hash_hmac('sha256', $payload, Jetlisans_Settings::hmac_secret());

        $headers = [
            'X-Api-Key'   => Jetlisans_Settings::api_key(),
            'X-Timestamp' => $ts,
            'X-Nonce'     => $nonce,
            'X-Signature' => $sig,
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

    /** Gelen webhook imzasını doğrular (§2). */
    public static function verify_webhook($method, $path, $ts, $nonce, $body_str, $signature) {
        $secret = defined('JETLISANS_WEBHOOK_SECRET') ? JETLISANS_WEBHOOK_SECRET : Jetlisans_Settings::hmac_secret();
        // Zaman penceresi ±300sn (replay).
        if (abs(time() - (int) $ts) > 300) return false;
        $payload = strtoupper($method) . "\n" . $path . "\n" . $ts . "\n" . $nonce . "\n" . hash('sha256', $body_str);
        $expected = hash_hmac('sha256', $payload, $secret);
        return hash_equals($expected, (string) $signature);
    }
}
