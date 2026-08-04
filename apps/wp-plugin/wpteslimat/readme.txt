=== WP Teslimat Eklentisi ===
Requires at least: 6.0
Requires PHP: 7.4
WC requires at least: 7.0
Stable tag: 1.0.2

WooCommerce siparişlerini merkezi lisans teslimat paneline iletir; teslimatı müşteriye gösterir.
Lisans verisi WordPress veritabanında TUTULMAZ — panel tek doğruluk kaynağıdır (ince istemci).

== Kurulum ==

1. `wpteslimat` klasörünü `wp-content/plugins/` altına koyun ve etkinleştirin.
2. Sırları `wp-config.php`'ye sabit olarak ekleyin (§8 — WP DB'de düz metin option DEĞİL):

   define('WPTESLIMAT_PANEL_URL', 'https://api.panel.example');
   define('WPTESLIMAT_API_KEY', 'jl_...');       // panelde site oluşturunca döner
   define('WPTESLIMAT_HMAC_SECRET', '...');       // panelde site oluşturunca döner

3. Panelde bu site için webhook_url'i şuna ayarlayın:
   https://SITENIZ/wp-json/wpteslimat/v1/webhook
4. Panelde ürünleri eşleyin: remoteProductId = WooCommerce ürün ID'si.
5. "Ayarlar → Teslimat Eklentisi" ekranından durumu doğrulayın (kalıcı bağlantılar/permalink açık olmalı).

== Nasıl çalışır ==

* Sipariş "processing"/"completed" olunca panele HMAC imzalı POST /v1/orders gider;
  panel atomik atama yapar, dönüş order meta'ya yazılır. Lisans verisi WP'ye gelmez.
* Müşteri "Siparişlerim → Görüntüle": teslimatlar panelden server-side çekilir (no-store).
* Panel değişiklikleri (tamamlanma, iptal) geri kanal webhook ile order meta'yı günceller.
* Değiştir / tekrar mail / iptal gibi yönetim işlemleri panel arayüzünde yapılır.

== Değişiklikler ==

= 1.0.0 =
* Panele artık kurulu eklenti sürümü bildiriliyor — panelde hangi sitenin güncel olduğu görünüyor
  (yalnız bilgi amaçlı; yetki her zaman site HMAC imzasıyla sağlanır).
* İlk kararlı sürüm: sipariş iletimi arka planda çalışır ve yanıt gönderildikten hemen sonra
  tetiklenir (ödeme/checkout ekranı beklemez), klon/staging koruması hem aktivasyonda hem
  güncellemede kurulur, lisanslar sipariş kalemi altında kart olarak görünür, mağaza ürün
  kataloğu panele bildirilir.

= 0.7.0 =
* Mağaza ürün kataloğu panele senkronlanır (Ayarlar → "Ürünleri Panele Aktar" + ürün kaydında
  otomatik) — panelde ürünleri sipariş beklemeden, adıyla proaktif eşlemek için. Sır göndermez
  (ad/sku/tip).

= 0.6.0 =
* Sipariş satırlarına mağaza ürün adı (remoteName) eklendi — panelde eşlenmemiş ürünleri isimle
  görüp tek tıkla eşlemek için (teslimatı etkilemez, additive).

= 0.5.1 =
* Sipariş notları netleşti: teslimat webhook'u artık ham "order.fulfilled (durum: fulfilled)"
  yerine düz Türkçe ("Teslimat tamamlandı — tüm lisanslar müşteriye iletildi.") yazar.
* İade/iptalde ham İngilizce WooCommerce durumu (refunded/cancelled) yerine yerelleştirilmiş
  ad kullanılır; panele iletim/geri-alma/iade BAŞARISIZ olursa sipariş notuna uyarı düşer
  (arka planda tekrar denenir — artık sessiz takılma yok).
* Meta box durum gösterimi her yolda Türkçe (ham enum sızmaz); eşlemesiz ürün "Ürün eşlenmemiş";
  bonus etiketi düzeltildi.

= 0.5.0 =
* Lisanslar artık her ürünün SİPARİŞ KALEMİ altında (order items), uzun yan metabox yerine —
  her ürünün kendi anahtarları + Göster/Değiştir/Askıya al/+1 Bonus + değişim geçmişi orada.
* Kart arayüzü yenilendi: özet sayaç (N lisans · X aktif), renkli durum rozetleri, ikonlu ve
  hiyerarşik butonlar (nötr Göster / mavi Değiştir / amber Askıya al / yeşil Geri aç), ürün-bazlı
  "Bonus Ekle" alt aksiyonu, katlanır değişim geçmişi; 5+ anahtarda kart KAYDIRILIR (ekran uzamaz).
* +1 Bonus artık ürün-bazlı (ayrı satır → sonraki Woo senkronu/iadesi bonusu geri almaz).
* Kritik iade düzeltmesi: kısmi iade sonrası re-sync artık iade edilen birimleri yeniden teslim
  ETMEZ (net adet gönderilir); bundleQty>1 üründe iade doğru ölçeklenir (aşırı revoke giderildi).
* Sipariş listesinde 100+ toplu güncelleme parçalanır; güvenlik: boş secret ile sahte webhook
  reddi, misafir "Sorun Bildir" erişimi korunur, alan taşımasında "yeniden bağla" aksiyonu.
* Ürün eşleme kutusu katalog önbelleği + yetki denetimi; ayarlar sayfası secret'ı DOM'a basmaz.

= 0.4.0 =
* Meta box operasyon katmanı (§7): key bazında Göster (loglu, yalnız yönetici), Değiştir
  (sebepli), Askıya al/Geri aç, +1 Bonus, Teslimat mailini tekrar gönder (60sn); değişim geçmişi.
* Ürün ekranına "Panel Eşlemesi" kutusu (Woo ürünü → panel ürünü, adet başına key).
* Sipariş listesine panel-durum filtresi (eşlemesiz/bekleyen/kısmi…).
* WooCommerce Product Bundles / Composite: paket konteyneri atlanır, bileşenler eşlenir.
* Tüm meta box/eşleme işlemleri site HMAC ile imzalı + klon/staging korumalı; audit'e wp:kullanıcı@site.

= 0.3.0 =
* Kısmi iade → satır revoke; tanılama sekmesi + admin bar sağlık göstergesi; müşteri ekranı
  cilası (parola göster/gizle, ilerleme çubuğu, toplu .txt indirme, canlı tamamlama yoklaması).

= 0.1.0 =
* İlk sürüm: sipariş push, webhook alıcı, My Account teslimat, admin meta box.
