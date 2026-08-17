=== WP Teslimat Eklentisi ===
Requires at least: 6.0
Requires PHP: 7.4
WC requires at least: 7.0
Stable tag: 1.1.5

WooCommerce siparişlerini merkezi lisans teslimat paneline iletir; teslimatı müşteriye gösterir.
Lisans verisi WordPress veritabanında TUTULMAZ — panel tek doğruluk kaynağıdır (ince istemci).

== Kurulum ==

1. `wpteslimat` klasörünü `wp-content/plugins/` altına koyun ve etkinleştirin.
2. Sırları `wp-config.php`'ye sabit olarak ekleyin (§8 — WP DB'de düz metin option DEĞİL):

   define('WPTESLIMAT_PANEL_URL', 'https://api.panel.example');
   define('WPTESLIMAT_API_KEY', 'wpt_...');       // panelde site oluşturunca döner
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

= 1.1.5 =
* ÇOK KULLANIMLI (MAK) LİSANSTA "KAÇ ETKİNLEŞTİRME HAKKIM VAR" ARTIK HER ZAMAN YAZIYOR.
  Önceden bu bilgi yalnız birim sayısı 1'den büyükken basılıyordu; bir siparişe bir anahtardan
  yalnız 1 hak düştüğünde satır açıklamasız kalıyor ve müşteri paylaşımlı anahtarın tamamının
  kendisine ait olduğunu sanıyordu. Artık ürün çok kullanımlıysa "1" de yazılır.
* Sipariş ekranı ve müşteri hesabı özetlerinde toplam kullanım hakkı, MAK siparişlerinde
  koşulsuz gösteriliyor (eskiden toplam ile kayıt sayısı eşitse hiç görünmüyordu).
* "Değiştir" düğmesinin MAK kapısı artık panelin bildirdiği ürün kipine bakıyor (anahtar
  kapasitesinden çıkarım yapmıyor) — gereksiz kapanan düğme kalmadı.

= 1.1.4 =
* EŞLEME KUTUSU DÜRÜSTLEŞTİ: panelde PASİF edilmiş bir eşleme artık "Eşli" diye gösterilmiyor —
  ayrı bir uyarıyla belirtiliyor (pasif eşleme teslimatta kullanılmaz, siparişler eşlenmemiş kalır).
* Varyasyonlu ürünlerde kutu artık ürün-seviyesi ile varyasyon-özel eşlemeleri AYIRIYOR. Önceden
  varyasyona ait eşlemeyi "mevcut eşleme" gibi gösterip değiştirdiğinizi sandırıyor, gerçekte ayrı
  bir kayıt yazıyordu; o varyasyonun siparişleri eski ürünü teslim etmeye devam ediyordu.
* Panel ürün listesi eksik geldiğinde (çok ürünlü kurulum) görünür uyarı — aradığınız ürün listede
  yoksa "panelde yok" sanılmıyor.
* Çok kullanımlı (MAK) lisanslarda sipariş ekranındaki "Değiştir" düğmesi sebebiyle kapalı geliyor;
  eskiden tıklanıyor ve panel her seferinde hata döndürüyordu.
* Panel hata mesajları artık okunabilir Türkçe cümle olarak gösteriliyor (ham "Not Found" /
  "validation_error" yerine).

= 1.1.3 =
* DESTEK YAZIŞMASI (kapalı döngü): müşteri açtığı talebi sipariş sayfasında görür, destek ekibinin
  yazdıklarını okur ve AYNI talebe yanıt yazabilir. Önceden "Ek bilgi iste" denince müşterinin cevap
  verecek hiçbir yolu yoktu; tek çıkış yeni talep açmaktı (talep bütçesini yiyor, eski talep açık kalıyordu).
* "Sorun Bildir" artık teslimat beklerken, ürün eşlenmemişken, lisans geri alındığında, süre dolduğunda
  ve panel erişilemezken de görünüyor (eskiden yalnız teslim edilmiş satırda vardı — çıkmaz sokak).
* Çok kullanımlı (MAK) üründe müşteri kartı artık "1 lisans (toplam 5 kullanım hakkı)" diyor; sipariş
  kutusu ve teslimat maili ile aynı dil (eskiden "1 lisans" deyip eksik teslimat izlenimi veriyordu).
* "Süresi doldu" / "inceleme altında" bantları artık yalnız ilgili ürünleri kapsıyor; çok ürünlü
  siparişte canlı lisans dururken tüm siparişi kapsayan yanıltıcı uyarı basılmıyor.
* İptal/iade edilmiş sipariş metni artık para iadesi İDDİA ETMİYOR (inceleme reddinde de aynı durum oluşuyor).
* İndirilen .txt dosyası süresi dolmuş lisansı "Geçerlilik:" yerine "Süresi doldu:" olarak yazıyor (ekranla aynı).
* Koyu temada okunmayan destek formu ve "süresi doldu" notu tema-nötr hâle getirildi (sabit renk kaldırıldı).

= 1.1.2 =
* Silinen sipariş kalemi artık panele bildiriliyor (tam senkron): teslim edilmiş lisanslar müşteride canlı kalmıyor.
* Tüm kalemleri silinen siparişte sessiz dönüş yerine görünür sipariş notu.
* Tekrar-deneme zinciri tükendikten sonra YENİ bir iş tetiklendiğinde sayaç ve kalıcı hata izi sıfırlanır (ikinci bir iade artık sessiz kalmıyor).

= 1.1.1 =
* KATALOG SENKRONU: ürün adı/SKU kırpması artık panelin ölçtüğü BİRİMLE (UTF-16 kod birimi) aynı.
  Eskiden `mb_substr` kod NOKTASI sayıyordu; emoji/astral karakter taşıyan tek bir ürün adı
  panelin sınırını aşıyor ve TÜM katalog snapshot'ı reddediliyordu — panelde katalog boş
  görünüyor, mağazada tek iz sessiz bir error_log satırı oluyordu.
* Ürün "Panel Eşlemesi" kutusu hata mesajları sipariş kutusuyla AYNI çeviriden geçiyor: panel
  doğrulama hatasında dizi dönen mesaj artık parçalı/anlamsız değil, tek okunur cümle; ağ
  hatasında ham İngilizce cURL metni yerine Türkçe açıklama.
* Sipariş ekranındaki değişim sebebi çipi çok baytlı (Türkçe) karakterde bölününce BOŞ
  görünebiliyordu — kırpma artık karakter sınırında yapılıyor.
* Bonus lisansların hangi ürüne ait olduğu panelin döndürdüğü yetkili alandan okunuyor; satır
  kimliğini eklentide yeniden ayrıştırma yalnız eski panel sürümleri için fallback olarak kaldı.

= 1.1.0 =
* KURULUM / ETKİNLEŞTİRME REHBERİ: panelde ürüne bağlanan talimat metni artık müşterinin
  sipariş sayfasında, o ürünün kartı içinde katlanır bir bölüm olarak görünüyor ve indirilen
  .txt dosyasına da yazılıyor (teslimat e-postasına eklenmesi panel tarafında yapılır).
  Anahtarı teslim etmek yetmiyordu: "Office 365'e nasıl giriş yaparım", "Windows anahtarını
  nereye girerim" soruları destek yükünün büyük kısmıydı.
* Teslimat görünümü KART yapısına geçti: her ürün kendi kartında (başlıkta lisans adedi),
  anahtarlar sarmalı kod bloklarında — uzun anahtarların son haneleri artık kırpılmıyor.
  Renkler tema-nötr (yarı saydam katmanlar) → koyu temalarda da okunur (eski sabit açık gri
  zemin koyu temada metni yutuyordu).
* Rehber HTML'i panelden geliyor olsa da eklentide `wp_kses` allow-list'iyle ikinci kez
  süzülür (yalnız h4/p/ol/ul/li/strong/em/a/br/code; yalnız http-https bağlantı).

= 1.0.7 =
* Sipariş ekranındaki lisans özeti çok kullanımlı (MAK) anahtarda YANILTICIYDI: kalem sayıyordu,
  yani 3 aktivasyonluk tek anahtar "1 lisans" görünüyordu — operatör eksik teslimat sanıp bedava
  bonus verebiliyordu. Artık "2 lisans (toplam 5 kullanım hakkı)" biçiminde birim de yazıyor.
* Anahtar satırındaki kullanım sayacı "Anahtar geneli: 12/500" diye etiketlendi (bu sayaç anahtarın
  TÜM siparişlerdeki toplamıdır, o siparişin değil) ve siparişe düşen birim ayrıca gösteriliyor.

= 1.0.6 =
* Müşteri sayfasında lisanslar artık ÜRÜNE göre gruplanıp ürün adıyla başlıklanıyor (çok ürünlü
  siparişte hangi anahtarın hangi ürün olduğu belli değildi). Aynı gruplama .txt indirmede de var.
* Çok kullanımlı (MAK/toplu) anahtarlarda "bu anahtar kaç aktivasyon hakkı içeriyor" bilgisi
  müşteriye gösteriliyor — müşteri eksik teslimat aldığını sanmıyor.
* Hesap ürününde alanlar çözülemediğinde müşteri artık kalıcı "Teslimat hazırlanıyor" ekranında
  kilitlenmiyor: lisans bilgisi olduğu gibi gösteriliyor, hiç içerik yoksa destek yönlendirmesi
  yapılıyor (.txt indirmede boş satır üretilmesi de düzeltildi).
* Panele iletilemeyen işlemler artık sonsuza kadar denenmiyor: 1dk/5dk/30dk sonra en fazla üç deneme,
  sonra tek ve net bir sipariş notu. Kimlik doğrulama hatasında (geçersiz anahtar/imza) hiç denenmiyor;
  bunun yerine yönetici panelinde uyarı gösteriliyor. Sipariş notu tekrarları da bitti.
* Güvenlik/doğruluk: tablo göçündeki `SHOW TABLES LIKE` sorgusu joker karakter kaçışıyla yapılıyor.

= 1.0.5 =
* Tarihler artık mağazanızın saat diliminde gösteriliyor. Lisans geçerlilik ve değişim tarihleri
  müşteri ekranında ve sipariş kutusunda UTC'ye göre basılıyordu (Türkiye'de 3 saat geriden).
* Güvenlik: sipariş erişim anahtarı (order key) giriş yapmış müşterinin sayfa kaynağına ve
  "Tüm lisansları indir" bağlantısına artık hiç gömülmüyor (tarayıcı geçmişi/erişim logu/
  paylaşılan link üzerinden sızma yolu kapandı). Misafir erişimi aynen çalışıyor.
* Kalem adedi düşürüldüğünde panel erişilemezse işlem artık SESSİZ kalmıyor: siparişe not
  düşüyor ve otomatik yeniden deneniyor (fazladan teslim edilmiş lisans geri alınmadan kalmıyordu).
* Eşzamanlı iki işlem aynı kilide düştüğünde kaybeden iş artık yeniden planlanıyor (Action
  Scheduler kurulu olmayan sitelerde iş tamamen kaybolabiliyordu); takılı kilidin kurtarma yolu da eklendi.
* Mağaza ön yüzü hızlandı: yönetici çubuğundaki panel sağlık göstergesi artık müşteriye açık
  sayfalarda panele istek atmıyor (sayfa render'ı bekletilmiyor).
* WooCommerce devre dışıyken panel uçları ölümcül hata yerine düzgün yanıt veriyor.
* Ürün eşleme kutusundaki metinler sadeleşti ("Adet başına kalem" — panel yalnız anahtar değil
  hesap/kod da taşıyabilir).

= 1.0.4 =
* Panelde yeni sürüm yayınlandığı hâlde indirme adresi güvenlik kontrolüne takılırsa güncelleyici
  artık SESSİZ kalmıyor: yöneticiye nedenini (reddedilen adres + beklenen host) söyleyen bir uyarı
  basıyor. Güvenlik kararı gevşetilmedi, yalnız görünür kılındı.
* Bu uyarının aynı sunucu / Docker iç ağı kurulumlarında YANLIŞ tetiklenmesi giderildi: paket adresi
  denetimi artık panel adresiyle aynı kuralı kullanıyor (1.0.3'te iki kapı çelişiyor ve kapatılamayan
  kalıcı bir hata bandı bırakabiliyordu). Çok siteli (multisite) kurulumda uyarı doğru kapsamda
  saklanıyor ve ağ yöneticisine de gösteriliyor; panele ulaşılamadığında bilginin eski olduğu belirtiliyor.
* İç tanımlayıcılar `wpt_` önekine taşındı (davranış değişmez; ad çakışması riski azalır).

= 1.0.3 =
* Panel adresi doğrulaması (is_secure_panel_url) aynı sunucu / Docker iç ağı gibi MEŞRU
  dağıtımları engelliyordu — eklenti panele hiçbir istek yapmadan sessizce duruyordu.
  Artık https her zaman kabul edilir; http yalnız KANITLANABİLİR özel adreslerde
  (localhost, özel IP aralıkları, tek etiketli Docker servis adı, *.local/.internal/.test)
  geçerlidir ve engel artık GÖRÜNÜR bir yönetici uyarısı bırakır (sessiz kesinti yok).

= 1.0.2 =
* Webhook nonce yaşam süresi panelin HMAC nonce TTL'iyle hizalandı (600 → 660 sn) — saat
  kaymasında replay penceresinin kenarında kalan boşluk kapandı.

= 1.0.1 =
* Güvenlik denetimi düzeltmeleri: güncelleyici artık HTTPS zorunlu tutuyor ve kurulacak
  paket URL'inin host/şema doğrulamasını yapıyor (MITM ile enjekte edilen sahte .zip
  kurulumu engellendi).

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
