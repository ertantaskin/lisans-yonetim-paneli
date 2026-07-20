=== Jetlisans — Lisans Teslimat İstemcisi ===
Requires at least: 6.0
Requires PHP: 7.4
WC requires at least: 7.0
Stable tag: 0.1.0

WooCommerce siparişlerini merkezi Jetlisans paneline iletir; teslimatı müşteriye gösterir.
Lisans verisi WordPress veritabanında TUTULMAZ — panel tek doğruluk kaynağıdır (ince istemci).

== Kurulum ==

1. `jetlisans` klasörünü `wp-content/plugins/` altına koyun ve etkinleştirin.
2. Sırları `wp-config.php`'ye sabit olarak ekleyin (§8 — WP DB'de düz metin option DEĞİL):

   define('JETLISANS_PANEL_URL', 'https://api.panel.example');
   define('JETLISANS_API_KEY', 'jl_...');       // panelde site oluşturunca döner
   define('JETLISANS_HMAC_SECRET', '...');       // panelde site oluşturunca döner
   define('JETLISANS_WEBHOOK_SECRET', '...');    // opsiyonel; yoksa HMAC_SECRET kullanılır

3. Panelde bu site için webhook_url'i şuna ayarlayın:
   https://SITENIZ/wp-json/jetlisans/v1/webhook
4. Panelde ürünleri eşleyin: remoteProductId = WooCommerce ürün ID'si.
5. "Ayarlar → Jetlisans" ekranından durumu doğrulayın (kalıcı bağlantılar/permalink açık olmalı).

== Nasıl çalışır ==

* Sipariş "processing"/"completed" olunca panele HMAC imzalı POST /v1/orders gider;
  panel atomik atama yapar, dönüş order meta'ya yazılır. Lisans verisi WP'ye gelmez.
* Müşteri "Siparişlerim → Görüntüle": teslimatlar panelden server-side çekilir (no-store).
* Panel değişiklikleri (tamamlanma, iptal) geri kanal webhook ile order meta'yı günceller.
* Değiştir / tekrar mail / iptal gibi yönetim işlemleri panel arayüzünde yapılır.

== Değişiklikler ==

= 0.1.0 =
* İlk sürüm: sipariş push, webhook alıcı, My Account teslimat, admin meta box.
