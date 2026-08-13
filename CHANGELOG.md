# Değişiklik Günlüğü (Changelog)

Bu projenin tüm önemli değişiklikleri bu dosyada belgelenir.
Format: [Keep a Changelog](https://keepachangelog.com/tr/1.1.0/) · Sürümleme: [SemVer](https://semver.org/lang/tr/).

Bu dosya **sohbet hafızasından bağımsız, kalıcı** yayın geçmişidir — her sürümde ne
değiştiğini burada görürsün. Dağıtım kaydı (ne zaman/hangi git sha ile prod'a gitti):
[docs/DEPLOY-LOG.md](docs/DEPLOY-LOG.md). Yayın süreci: [docs/RUNBOOK-RELEASE.md](docs/RUNBOOK-RELEASE.md).

İki ayrı sürüm izi vardır:
- **Panel** (API + Admin) — bu dosyadaki sürüm numarası + `git tag vX.Y.Z`.
- **WP eklentisi** — kendi sürümü (`apps/wp-plugin/wpteslimat/wpteslimat.php` `Version:`),
  müşteri sitelerine `plugin_releases` üzerinden dağıtılır (bkz. Sürümler / `/releases`).

## [Yayınlanmamış]

### İkinci onay modali (panel geneli) + rozet dilinin tek kaynağa toplanması (migration YOK)

Kullanıcı: *"Stok giriş durumlarında 2. onay gereksin, ekrana modal gelsin, lisansların olduğu bir
liste vs, ondan sonra ekleme yapmalı — eklenip eklenmediği tam anlaşılmıyor. Başka yerlerde de
benzer teyit durumları gerekiyorsa yapalım. Ayrıca /stock rozetleri (teslim edildi, stokta,
geçersiz kılındı) siparişler sayfasındaki gibi değil; senkron bir palet olmalı."*

**Yeni primitifler.** `ui/dialog.tsx` (Radix Dialog — `Sheet` kenardan açılan *çalışma* yüzeyi,
`Dialog` ekranın ortasındaki *karar* yüzeyi) ve `ui/confirm.tsx` → **`useConfirm()`**: söz-tabanlı
API (`if (!(await confirm({...}))) return;`) sayesinde `window.confirm`/`prompt` çağrı yerleri
neredeyse birebir taşındı. Destekler: serbest `details` (liste/özet), `tone:'danger'` (kırmızı onay
düğmesi + odak **İPTAL**'de başlar → yanlışlıkla Enter silmez), `reason` (zorunlu/opsiyonel gerekçe;
çok satırlı · tek satır · **parola** + `minLength`).

**Stok girişinde ikinci onay (asıl istek).** "Onayla ve Dağıt" artık doğrudan kaydetmiyor: modal
ürünü, kayıt sayısını (MAK ürününde ayrıca kullanım hakkını), tedarik özetini, **girilecek
kayıtların listesini** (ilk 20; hesap ürününde gizli alanlar maskeli), mükerrer/boş satır notunu ve
en önemlisi *"bu giriş **N bekleyen birimi hemen teslim eder** — müşteriye e-posta gider"*
uyarısını gösterir. Sonuç artık **toast** ile de bildiriliyor (form temizlendiği için "oldu mu?"
sorusu kalmasın); `imported = 0` asla yeşil gösterilmez.

**19 yerli tarayıcı kutusu panel modaline taşındı** — kod tabanında `window.confirm/prompt/alert`
artık **sıfır**: sipariş askıya al · iptal (gerekçe) · anahtar değiştir (gerekçe) · değişim talebi
onayla/reddet · inceleme kuyruğu onayla/reddet · site askıya al/aktifleştir (iki ekran) · HMAC
secret yenile · bağlan kodu üret · eşleme kaldır (iki ekran) · şablon sil (iki ekran) · yönetici sil
ve parola sıfırla (artık **maskeli** alan; kısa parola `alert` yerine kilitli düğmeyle engellenir) ·
KVKK anonimleştirme · bildirimleri okundu yap · görünüm kaydet. `/review`'daki elle yazılmış modal
(portalsız, odak tuzağı yok) silinip paylaşılana taşındı (−85 satır).

**Rozet dili tek kaynağa toplandı.** `/stock` lisans envanteri ikonsuz düz `Badge` + kendi ton
sözlüğünü kullanıyordu → `StatusBadge`; `available/reserved/assigned/depleted` paylaşılan haritaya
eklendi, böylece "Teslim edildi" `/orders` ile **aynı yeşil ve aynı ikon**. Karantina tablosu
`voided`'ı amber basıyordu (envanterde kırmızıydı). Tedarik zincirinde **dört ayrı** rozet
uygulaması vardı ve birbiriyle çelişiyordu — `voided` tedarikçi karnesinde amber / ürün detayında
kırmızı; `ordered` satın alma emri listesinde gri / ürün detayında amber; PO listesi etiketleri
sözlüğü atlayıp elle küçük harf yazıyor ve ikon basmıyordu → tek bir **`SupplyStatusBadge`**.
`SupportStatusBadge` de paylaşılana devredildi. `ui/badge.tsx`'e **ton kuralı** yazıldı: success =
sağlıklı/eylem gerekmez · warning = bekliyor/bak · danger = ölü/hatalı · neutral = kapanmış; aynı ton
içindeki durumlar **ikon + etiketle** ayrışır — yeni renk eklenmez (monokrom kimlik korunur).

**Düzeltilen iddia.** Ara bir commit, "kapanan açılır menü görünmez bir tıklama ölü bölgesi
bırakıyor" diye canlı bir hata raporladı. Kontrol denemesi bunu çürüttü: doğrulamada kullanılan
tarayıcı paneli CSS animasyonlarını hiç koşturmuyor (sıfırdan oluşturulan 60 ms'lik bir animasyon
bile `animationend` üretmedi), Radix de unmount için o olayı bekliyor. Gerçek tarayıcıda böyle bir
hayalet katman **kanıtlanmadı**; dropdown/popover/select/tooltip'e eklenen durum-kapılı giriş/çıkış
animasyonu doğru eşleşme olduğu için kaldı ama "canlı bir hatayı düzeltti" diye okunmamalı.

### Stok girişi: gün-bazlı parti etiketi + canlı satır/lisans sayacı + sınır görünürlüğü (migration YOK)

Kullanıcı: *"Parti etiketi gün vs de içerebilir ayırt etme konusunda. Ayrıca başka sorun var mı?
Anahtar yapıştırma ekranında satır sınırı vs var mı, oraya maks da belirtilebilir. Veya
yapıştırıldığında kaç ürün/lisans olduğunu hesaplayıp kenarda gösterebilir — yanlış giriş olmaması
açısından."*

**Parti etiketi artık günü de taşır:** `YYYY-MM-<HARF>` → **`YYYY-MM-DD-<HARF>`** (`2026-08-13-A`).
Ay-bazlı etikette aynı ayın 3'ünde ve 27'sinde alınan iki parti yalnız `A`/`B` ile ayrışıyordu;
etikete bakan operatör hangisinin hangi alım olduğunu parti detayına girmeden anlayamıyordu. Harf
artık yalnız **aynı gün içindeki** ikinci/üçüncü girişi ayırır. Eski ay-bazlı etiketler farklı bir
desendir: çakışmaz, harf dizisini kaydırmaz. 10 vakalık davranış testi + dev'de gerçek giriş
(`2026-08-13-A` oluştu → aynı gün ikinci giriş `-B` önerdi) ile doğrulandı.

**Girdi sayacı (`EntryMeter`)** — girdi alanının **hemen altında**, canlı: kaç kayıt gideceği, kaç boş
satırın atlandığı, kaç satırın birbirinin aynısı olduğu, `N / 10.000 satır` ve `X KB / 700 KB`.
%90'da uyarı rengine döner. Sınır ayrıca bölüm açıklamasında ve alan yardım metninde yazıyor —
eskiden **yalnız aşıldığında** görünüyordu. Sağ raydaki özet uzun listede ekran dışında kalıyordu.

**Yol boyunca bulunan üç gerçek kusur:**

- **MAK/çok kullanımlıkta anahtar sayısı, birim talebiyle kıyaslanıyordu.** "Bu giriş N bekleyen
  birimi otomatik tamamlar" olduğundan **az** görünüyordu: 1 anahtar × 500 kullanım = 500 birim.
  Sayaç ve bekleyen-sipariş etkisi artık kapasite üzerinden ("3 anahtar = 1.500 kullanım hakkı");
  özet rayına ayrı "Kullanım hakkı" satırı eklendi.
- **Görünmez karakter denetimi yalnız hesap tablosundaydı.** Düz anahtar yapıştırmasında yoktu:
  `trim()` yalnız uçları alır, anahtarın **ortasına** düşmüş sıfır-genişlik karakter (web/PDF
  kopyası) sessizce şifrelenip müşteriye gider ("çalışmıyor") ve hash'i değiştirdiği için mükerrer
  kontrolünü de kaçırır. Artık sayılır, uyarılır ve tek tıkla temizlenir (sessiz düzeltme yok).
- **Hesap TABLO modunda yapıştırma satır tavanı yoktu.** Hücre başına bir `<input>` render edildiği
  için binlerce satırlık Excel bloğu sekmeyi kilitleyebilirdi; gövde sınırı bunu önlemez (blokaj
  ancak render'dan sonra görünür). Tavan **500 satır**; sessizce kırpılmaz — kaç satırın alınmadığı
  ve kalanın "JSON (gelişmiş)" sekmesine gireceği açıkça yazılır, "Satır ekle" tavanda kapanır.
- 1 KB altı boyut ham **bayt** olarak yazılır (`Math.ceil` boş formda bile "1 KB" gösteriyordu).

`/guide`: sınırlar, otomatik etiket biçimi ve MAK kullanım hakkı örneği eklendi.

### Stok girişi UX cilası + panel geneli Türkçe arama düzeltmesi (migration YOK)

Kullanıcı, yeni ekranı kullandıktan sonra ekran görüntüleriyle: *"düzen sıralama olarak biraz daha
kolaylaştırılabilir. Parti etiketi tarihe göre otomatik oluşabilir. Search inputlardaki arama tasarım
sorunlarını düzelt. Başka yerlerde sorunlar/bağlantılar varsa onları da hallet."*

**Türkçe arama sessizce bozuktu (gerçek kusur, panel geneli).** Combobox süzgeci düz `toLowerCase()`
kullanıyordu; projede tam bu iş için yazılmış `includesTr` yardımcısı yok sayılmıştı. JS'in
`toLowerCase()`'i "I"yı noktalı `i` yapar → "ANAHTARI" yazan operatör "Anahtarı" kaydını **bulamıyordu**
ve hata da almıyordu (sessiz boş liste). `/mappings`, `/customers`, satın alma emri formu, stok girişi
ve stok düzeltme dahil bütün aranabilir seçiciler etkileniyordu.

**İki farklı arama görünümü vardı:** tablo araç çubuklarındaki `SearchInput` kenarlıklı, temizle (×)
düğmeli; açılır listelerin içindeki arama kenarlıksız ve temizlemesizdi. Hizalandı — aynı ikon boyutu,
aynı temizle düğmesi, listeden ayıran zemin, dar tetikleyicide ezilmeyi önleyen min/max genişlik,
filtre sonrası "N sonuç" şeridi (+ ekran okuyucu duyurusu) ve boş durumda `"X" için sonuç yok`.

**Stok girişi, tedarik bölümü:** üç dev radyo kartı (~200 px) kompakt bir segmente indi (34 px; ok
tuşları/Home/End ile gezinilir), yalnız seçili modun açıklaması görünür. **Parti etiketi artık
otomatik** — alım tarihinden türetilir (bu sürümde ay-bazlıydı; yukarıdaki girdide **gün-bazlıya**
çevrildi), harf o ürünün aynı dönemdeki kullanılmayan ilk harfi;
operatör alana dokunana kadar tarihle güncellenir, dokununca donar ("Otomatik" geri-dönüş düğmesiyle).
Alan artık boş/kırmızı-zorunlu başlamıyor. "Tedarikçi listede yok" onay kutusu alanın içine taşındı ve
geçişte girilen değer artık kaybolmuyor. Alan sırası kim/ne zaman → ne kadar → kimlik/not; maliyet
alanında para birimi öneki ve canlı toplam hemen altında.

**Panel temizliği:** `/guide` yeni akışa göre yeniden yazıldı (hızlı giriş ↔ tedarikli giriş);
`/batches`, `/purchase-orders`, `/suppliers` açıklamaları güncellendi; otomatik oluşan parti ve
emirlerde ham `[oto-giris]` öneki yerine "Otomatik" rozeti; tedarikçi formu ortak `Field` primitifine
geçti. Ölü iç link taraması temiz.

**Çekişmeli doğrulama 5 kusur buldu, hepsi kapatıldı.** En önemlisi kendi eklediğim Escape davranışıydı:
"dolu aramada Escape önce temizlesin, popover açık kalsın" guard'ı, odak temizle (×) düğmesindeyken
aramayı hiç boşaltamadığı için **her Escape'i yutuyor** ve popover'ı yalnız dışarı tıklamayla
kapatılabilir hâle getiriyordu. Guard tamamen kaldırıldı — popover içinde Escape her zaman kapatır
(sayfa içi `SearchInput`'ta temizlemeye devam eder; orada kapatılacak bir katman yok). Diğerleri:
"N sonuç" sayacı temizle satırını saymıyordu · ürün değişince elle yazılmış etiket diğer ürüne
taşınıyordu · tarih boşaltılınca var olmayan bir düğmeye yönlendiriliyordu · `aria-autocomplete`
yanlış öğedeydi.

### Stok girişi yeniden tasarımı: tek ekranda tedarikçi + alım tarihi + maliyet (migration YOK)

Kullanıcı: *"Key/Stok hesap İçe Aktar işlemleri biraz karışık geldi… eklerken seçmek mantıklı
değil mi hangi tarihin partisi olduğunu, tedarikçiyi vs."*

**Ölçülen durum:** "12 Ağustos'ta Acme'den aldım" bilgisini girmek **4 ekran / 6 adım** sürüyordu
(Tedarikçi → Satın Alma Emri → Teslim Al → Partiler → ürün detayı → yapıştır) ve **alım tarihi
hiçbir formda girilemiyordu** (`batches.received_at` sunucuda `now()` oluyordu). İçe aktarma formu
partiyi yalnız *seçtiriyordu*; parti oluşturmanın tek yolu satın alma emri teslim almaktı. Üstelik
form "Parti… normalde boş bırakın" diyordu, ama boş bırakılan girişlerin maliyeti raporlarda
**kalıcı olarak** "kapsanamayan" kalıyordu (snapshot import anında yazılır, bir daha düzelmez).

**Yeni `/stock/import` — tek sayfa:** solda Ürün · Tedarik bilgisi (katlanır, isteğe bağlı) ·
Anahtarlar; sağda canlı önizleme rayı. Tedarikçi (listede yoksa adı yazılarak oluşturulur), **alım
tarihi**, parti etiketi ve birim maliyet (**lira** girilir, canlı toplam gösterilir) anahtarlarla
aynı istekte gider; API **tek transaction**'da `received` bir satın alma emri + partiyi açar ve
maliyeti lisans kayıtlarına snapshot'lar. Hesap ürünlerinde **sütunlu tablo** varsayılan (Excel/
Sheets'ten yapıştırma; sekme/`;`/`,` otomatik algılanır, başlık satırı atlanır), ham JSON
"Gelişmiş" sekmesine taşındı. **.txt/.csv dosya yükleme** (tarayıcıda okunur, sır sunucu loguna
düşmez). Sol menüye, `/stock` başlığına, `/pending` ve `/batches` derin bağlantılarına eklendi;
eski tek giriş noktası (`/products/[id]` formu) bu ekrana yönlendiren kompakt bir karta indi.

**Alınan üç karar (tasarım ajanları çelişti):**
- **Parti adedi = gerçekten girilen kayıt sayısı**, operatörün beyanı değil. Mükerrer atlanan
  anahtarlar zaten önceki bir partide sayılmıştır; bu partide tekrar saymak tedarikçi harcamasını
  **çift** gösterirdi. Sonuç: formda adet alanı yok, sapma olursa sonuçta açıkça yazılır.
- Otomatik emirde **`ordered_at = NULL`** — `avgLeadDays = avg(received_at − ordered_at)` olduğu
  için eşitlemek her geçmişe dönük girişte 0 gün ekleyip tedarikçi KPI'ını sessizce sıfıra çekerdi.
- **Tedarikçisiz + maliyetli giriş → 400.** Maliyeti sessizce düşürmek, giderdiğimiz hatanın kendisi.
- Girilen anahtarların **tamamı mükerrerse → 409 + tam rollback** (0 adetli hayalet emir/boş parti yok).

**Güvenlik — Excel yapıştırmanın getirdiği risk kapatıldı:** `serializeAccountPayload` değerleri
`trim()` etmiyor ve şemada olmayan sütunu sessizce atıyordu. Sonuç: NBSP/akıllı tırnak taşıyan bir
parola olduğu gibi şifrelenip **müşteriye yanlış gidiyor** (panelde maskeli olduğu için operatör
göremiyor) ve `payload_hash` farklılaştığı için **dedupe devre dışı** kalıyordu (aynı hesap iki
müşteriye). `normalizeFieldValue` (NFC · BOM · NBSP · akıllı tırnak · sıfır-genişlik · trim) +
bilinmeyen anahtar reddi eklendi — ret mesajı anahtar **adını** taşır, **değerini asla**.

**Yol boyunca kapatılan sessiz kusurlar:** pino `redact` listesi `req.body.payload` diyordu ama
import gövdesi `items[].payload` — lisans anahtarları **loga sızabilirdi** · import sonrası
`/batches` ve `/purchase-orders` revalidate edilmiyordu (bayat sayaç) · `previewStockAction`
aktör geçirmiyordu · satın alma emri birim maliyetinde üst sınır yoktu (int4 taşması → 500) ·
`cleanupByTag` batches/purchase_orders/suppliers'a dokunmuyordu (yeni testler `afterAll`'da FK
ihlaliyle patlar, maliyet testini kirletirdi) · kenar menü aktif öğesi düz prefix eşleşmesi
kullanıyordu (`/stock/import`'ta iki öğe birden aktif) · breadcrumb ham "import" basıyordu.

Doğrulama: typecheck 4/4 + check-use-server · shared 34/34 (mutasyonla kanıtlandı) · api birim
72/72 · **entegrasyon 178/178 (+18 yeni) + yarış 3/3** · dev'de gerçek veriyle uçtan uca (kuru
çalıştırma hiçbir şey yazmadı; gerçek girişte emir `received`/adet 3/`ordered_at` NULL, parti
12.08.2026, `byMonth` 2026-08 = 37,50 ₺, değerlemede kapsanamayan 0, "Otomatik" rozeti).

### UI/UX bağlam denetimi: çok siteli görünürlük + held sipariş körlüğü (36 bulgu, migration YOK)

Kullanıcı: *"/pending'de hangi site olduğu belirtilmiyor, çok siteli yönetimde karışıklık;
detayları atlamamalısın, başka yerlerde de UI/UX sorunları varsa tespit edip düzelt."*
5 ekran-grubu taraması + çekişmeli doğrulama (45 ajan): **56 ham → 36 doğrulanmış**
(3 kozmetik, 1 çürütüldü) → 4 ayrık-dosya işçi düzeltti.

**Bildirilen kusur (kök neden):** `pending()` ve `list()` yalnız `orders` kolonlarını
döndürüyordu — site bilgisi olarak sadece okunamaz `siteId` (UUID) vardı ve tabloda kolon yoktu.
API artık `sites` leftJoin ile `siteDomain`+`siteType` döndürür (sır kolonu seçilmez);
`/pending` ve `/orders`'a **Site** kolonu, `/orders`'a **veriden türeyen site süzgeci** (tek
mağazada gizlenir) ve mağaza adını kapsayan arama eklendi.

**En kritik ek bulgu — İNCELEMEDEKİ (held) sipariş körlüğü:** dinamik kota ile beklemeye alınan
sipariş DB'de `status='pending'` durur → kuyrukta sıradan "Bekliyor" görünüyordu. Operatör bunu
stok beklemesi sanıp stok girer; `autoComplete` held siparişi **atlar** → hiçbir şey olmaz,
sipariş günlerce çürür (gerçek eylem `/review`'da). Held bayrağı artık ham durumu **ezer**:
"İncelemede" rozeti + sebep + `/review` linki + liste üstünde uyarı bandı; `/orders` durum
süzgecine "İncelemede" seçeneği.

**[YÜKSEK] `/sites/new` sihirbaz çıkmazı:** site oluşmuş ama bağlan kodu üretilememişse panelde
kurtarma yolu yoktu ve operatör **var olmayan bir butona** yönlendiriliyordu.

**Diğer düzeltmeler:** `/pending` "Ürün / eksik adet" kolonu + ürün bazında "stok bekleyen talep"
şeridi (tek korelasyonlu alt sorgu, N+1 yok; incelemedekiler talebe dahil edilmez) · `/orders`
200-kayıt penceresi dürüstleşti ("listede yok = panelde yok DEĞİL") · `/review`'de satırdan
siparişe/müşteriye link + "Onayla" sonucu **gerçek** durumu raporluyor (stok yoksa yeşil değil) ·
stok düzeltme formu stoku değiştirmeden yeşil "Eklendi" demiyor (kalem seçimi zorunlu) · parti
alanı ham UUID yerine seçim · `/stock` "Satıldığı siteler" kolonu + eşleme süzgeci (eşlemesiz
ürün artık görünür) · `/batches` linkleri + Türkçe arama + tek kaynaklı durum etiketi · `/support`
site + ürün/lisans bağlamı · `/customers/[email]` site + tıklanabilir talepler · `/security`
yönetici-giriş olayları Türkçe + süzgeç + kırpılma uyarısı · `/notifications` ve `/mappings` ham
enum temizliği · `/mappings` varyasyon-ebeveyn yanlış uyarısı + sonuç raporu · `/deployments` log
görünürlüğü + otomatik yenileme · terim birliği (Ctrl+K "Tamamlandı" → "Teslim edildi";
doğrulamada kendi ürettiğim "Mağaza" başlığı panelin yerleşik **"Site"** terimine hizalandı).

**Doğrulama:** typecheck 4/4 + check-use-server (21 dosya/67 export) · api birim 72/72 · admin
production build · VPS izole test DB **entegrasyon 160/160 + yarış 3/3** · **dev E2E:** 21 rota
200 (hata sınırı yok), Site kolonu 3 gerçek mağazayla doğrulandı, **held rozeti canlı kanıtlandı**
(gerçek sipariş incelemeye alındı → üç ekranda göründü → geri alındı) · prod+dev deploy, /health
200 v1.0.0, api+admin **healthy**. Migration YOK.

### WP senkron kesintisi (kendi güvenlik düzeltmemin yan etkisi) + yazılımsal denetim maddeleri (eklenti v1.0.3, migration YOK)

**Kullanıcı raporu:** dev'de atanan lisanslar WordPress'te görünmüyor; bazı siparişlerde
"Lisans bilgileriniz şu an görüntülenemiyor" çıkıyor.

**Kök neden (ölçüldü):** güvenlik denetiminde eklediğim W1 HTTPS zorlaması (`is_secure_panel_url`)
http'ye YALNIZ `localhost/127.0.0.1/::1` için izin veriyordu. Panel ile WP aynı Docker ağındayken
adres `http://api:3001` (İÇ servis adı) → guard `false` → eklenti panele **hiç istek yapmadan**
`code=0` dönüyordu. Kanıt: WP konteynerinden `http://api:3001/v1/health` **200 OK** (ağ sağlam)
ama dev API loglarında **24 saatte sıfır** site-facing istek. Sipariş push / iade / katalog
senkronu da aynı sebeple **sessizce** durmuştu.

- **Düzeltme:** https her zaman geçer; http YALNIZ kanıtlanabilir ÖZEL adreste (loopback ·
  tek-etiketli Docker servis adı — public DNS'te çözülemez · 10/8, 172.16/12, 192.168/16,
  169.254/16 · IPv6 ULA/link-local · `.local/.internal/.test/.localhost/.home.arpa`).
  **Gerçek alan adı + http HÂLÂ REDDEDİLİR** (MITM tehdit modeli korunur — 10 vakalık matris).
- **Blok artık sessiz değil:** `insecure_panel_notice()` — panel adresi reddedilirse WP admin'de
  kırmızı uyarı ("sipariş iletimi ve lisans görüntüleme DEVRE DIŞI"). Bu arıza günlerce görünmezdi.

**Yazılımsal denetim maddeleri (kullanıcı önceliği "yazılımsal taraf"):**
- **Sessiz mail arızası** — `SMTP_HOST` varsayılanı `mailpit` ve mailpit PROD compose'da ayakta:
  operatör gerçek relay yazmazsa mail 250 OK alır, `email_log` 'sent' olur, panel yeşil görünür,
  müşteri lisans mailini ASLA almaz. Yeni `MailConfigGuardService`: ÜRETİMDE dev-sink hedefte
  açılışta `logger.error` + **kritik bildirim**. Fail-closed DEĞİL (mail tek kanal değil; sinyal
  ver, sistemi kırma). **Prod'da ilk boot'ta ATEŞLEDİ — gerçek bir yapılandırma hatası buldu.**
- **docker-compose env'leri geçirmiyordu** (`.env`'e yazmak sessizce etkisizdi): admin →
  `REQUIRE_AUTH` (fail-closed emniyet kemeri ATIL kalıyordu), `TZ` (panel saatleri 3 saat
  sapıyordu), `APP_VERSION`; api → `HMAC_IP_FAIL_LIMIT`, `AUTOCOMPLETE_INLINE_CAP`,
  7×`RETENTION_*`, `RECONCILE_WINDOW_DAYS/FULL`, `SWEEP_ALARM_DEDUPE_HOURS`.
- **Log rotasyonu yoktu** (json-file sınırsız → disk dolarsa PostgreSQL durur = tüm teslimat
  durur) → `x-logging` anchor, tüm servislerde 10m × 5. **Healthcheck yoktu** → api `/v1/health`,
  admin `/login`. **deploy.sh disk sızdırıyordu** (68 GB build cache) → başarılı dağıtımdan sonra
  dangling imaj + 7 günden eski cache temizliği (**prod: %57 → %13 dolu, 64 GB geri kazanıldı**).
- **`/settings` yanlış bilgi veriyordu:** Telegram HER ZAMAN "kapalı" (admin env'ine bakıyordu;
  oysa API konteynerinde yaşar), sürüm HER ZAMAN `0.0.0`. Yeni **ADMIN-ONLY**
  `GET /v1/admin/system/status` (yalnız boolean; public `/v1/health`'e KOYULMADI — gereksiz
  yapılandırma ifşası) → gerçek Telegram/Sentry/AI durumu + "Mail gönderimi" kutucuğu
  (gerçek relay / DEV yakalayıcı) + API erişilemezse dürüst "Bilinmiyor".
- **CI kapsamı:** müşteri sitelerine giden WP eklentisinin PHP'si hiç kontrol edilmiyordu →
  `php -l`; ayrıca **migration/şema sapma denetimi** (`db:generate` yeni dosya üretirse CI kırılır
  — bu sınıf iki kez üretimi kırma eşiğine gelmişti).
- **Bonus (healthcheck ortaya çıkardı):** Next standalone `server.js` bind adresini
  `process.env.HOSTNAME`'den alır, Docker onu konteyner ID'sine ayarlar → admin **loopback'e bind
  olmuyordu** (yalnız konteyner IP'si). `HOSTNAME=0.0.0.0` (kanonik Next-in-Docker ayarı).

**Doğrulama:** typecheck 4/4 + check-use-server temiz · api birim **72/72** (+7 yeni) · admin
production build (uyarısız) · VPS izole test DB **entegrasyon 160/160 + yarış 3/3** · PHP-lint 12/12
· `docker compose config` geçerli · dev E2E (WP→panel HMAC 200, metabox 200, deliveries 200 gerçek
anahtar) · prod+dev deploy → **/health 200 v1.0.0, api+admin healthy**. Migration YOK.

### Tam test doğrulaması + odaklı eksik-giderme (5-boyutlu denetim; eklenti v1.0.2; migration YOK)

Kullanıcı: *"tüm projeyi test et, eksikler var ise onları güvenli, performans şekilde tamamla tam
olarak."* Önce bekleyen doğrulama koşuldu (86dcc22 sonrası VPS entegrasyon+yarış hiç koşulmamıştı):
izole docker (pg17+redis7+node22) — **yarış 3/3, entegrasyon 157/157, birim 65/65, typecheck 4/4,
build 3/3, PHP-lint 12/12, şema drift YOK**. Ardından 5 paralel denetim ajanı (API güvenlik ·
correctness · perf/dayanıklılık · WP eklentisi · admin+test-kapsamı) — güvenlik/WP/admin boyutları
DOĞRULANMIŞ TEMİZ; yalnız gerçek boşluklar kapatıldı:

- **[perf/dayanıklılık] SMTP fail-fast timeout** (`mail.transport.ts`): sistemdeki timeout kalkanının
  tek deliğiydi — nodemailer varsayılanları (connect ~2dk, socket ~10dk) yüzünden relay TCP'yi kabul
  edip yanıtı black-hole yaparsa mail worker dakikalarca sıkışıp TÜM lisans teslim maillerini
  baş-bloklardı. `connectionTimeout/greetingTimeout 10s + socketTimeout 20s` → hızlı-başarısız →
  BullMQ retry. Ayrıca **mail worker `concurrency: 5`** (varsayılan 1'di; `mail.processor.ts`).
- **[correctness] `bulkReplaceBatch` soyağacı `newAssignmentId`** (`supply-ops.service.ts`): eskiden
  geriye-dönük "en yeni aktif atama" tahmin dalına düşüyordu (dosyanın kendi sözleşmesini ihlal) →
  AYNI satırda eşzamanlı değişimde soyağacı yanlış atamaya bağlanabilirdi (yalnız denetim-izi/görüntü;
  §2 invaryantları etkilenmiyordu). Diğer üç çağıranla simetri.
- **[test] `syncRefunds` suspended kısmi-iade REGRESYON testleri** (`sync-refunds.test.ts` f+g): bir
  önceki batch'in H1-düzeltmesi üç revoke yolunu suspended'ı kapsayacak şekilde değiştirdi; ikisinin
  testi vardı ama üçüncü yol (`syncRefunds` WooCommerce kısmi-iade) regresyonsuzdu → aday kümesi
  `['active']`'e döndürülse tüm testler geçer ama bedava-lisans bug'ı sessizce dönerdi. **Mutasyon
  testiyle kanıtlandı** (aday kümesi→active-only → f+g KIRMIZI). single (revokeAssignment yolu) +
  multi/MAK (revokePartialUnits + over-count savunması).
- **[güvenlik, savunma-derinliği] readonly-sql unicode-escape kapısı** (`readonly-sql.service.ts`):
  `U&'\0061dmin'` / `U&"..."` kod-noktası kaçışı denylist adlarını obfuscate edip TÜM metin
  denylist'lerini atlatabilirdi → sözdizimi tümden reddedilir (+test).
- **[WP tutarlılık, eklenti v1.0.2] webhook nonce transient TTL 600→660** (`class-webhook.php`):
  paylaşılan `HMAC_NONCE_TTL_SEC = 2×300+60` sözleşmesiyle hizalandı (WP tam sınırdaydı, replay marjı yoktu).

**Doğrulama (izole docker, düzeltmeler sonrası):** yarış 3/3 · entegrasyon **160/160** (+3 yeni) · birim
65/65 · typecheck 4/4 · build 3/3 · PHP-lint 12/12 · mutasyon testi (aday→active-only) f+g KIRMIZI
(guard doğrulandı) · şema drift YOK. Kapsam-dışı (bilinçli): global-arama trgm/GIN index (ölçek-kapılı,
extension+migration), WP IPv6 literal localhost (dev-kolaylığı, prod etkisi yok), reconcile
checkMultiCapacity recentFilter (arka plan, statement_timeout korumalı). Migration YOK.

### Derin-denetim düzeltmeleri: H1 suspended-refund + rol-farkında maske + KVKK + readonly-sql (migration YOK)

Kullanıcı: *"tüm eksikleri ve sorunları gider, sistem stabil güvenli performans bir şekilde."*
Derin-denetimde bulunan gerçek + güvenli-düzeltilebilir açıklar kapatıldı; her düzeltme
**9-ajanlı adversaryel doğrulama workflow'undan** (çürütmeye çalış + kapsam taraması) geçirildi
ve o workflow **kaçırdığım üçüncü bir H1-yolunu (HIGH) + 2 tamlık boşluğunu** ortaya çıkardı —
hepsi deploy-öncesi kapatıldı.

- **[H1 — bedava lisans] iade/adet-düşür yollarının ÜÇÜ de** yalnız `status='active'` atamayı geri
  alıyordu → ASKIDAKİ (`suspended`) atama iadede/adet-düşürde CANLI kalıyor, admin sonradan "Geri aç"
  derse iade edilen müşteride çalışan lisans oluyordu (§2 ihlali). Düzeltildi: `revokeOrderForSite`
  (tam iade) + `syncRefunds` (kısmi iade) + `revokeExcess` (adet-düşür re-push; **adversaryel sweep
  bulgusu**) aday kümesi `active + suspended`; `revokePartialUnits` guard'ı suspended kabul eder;
  syncRefunds else-branch gerçek dönüşü sayar (over-count savunması). §2 korunur: MAK iadede kapasite
  havuza dönmez, satır `canceled` işaretlenir.
- **[H2 — düz-metin sızıntısı, latent] `apiRaw`** oturum rolünü iletmeyerek envanter reveal-gate'ini
  owner-olmayan admin için etkisiz bırakıyordu (`canRevealPlaintext('')=true`). `getSessionRole()` ile
  rol artık `apiRaw`'da da iletilir (apiPost/apiGet ile simetrik). *Latent: ikincil admin hesabı yok.*
- **[M1] Karantina listesi** rol'e bakmadan TAM düz anahtar döndürüyordu → A1 kararıyla hizalandı:
  owner düz görür, owner-olmayan admin maskeli (key son-4 / account secret maskeli); reveal audit'i
  yalnız gerçek düz-metin dönüşünde yazılır.
- **[M2] readonly-sql (§15, AI varsayılan KAPALI)** salt-okunur tx yazmayı engelliyor ama uygulamanın
  DB rolü superuser olduğundan `pg_read_file`/`dblink`/`lo_*`/adminpack dosya-ağ okuması + `pg_authid`/
  `pg_shadow` parola-hash katalogları okunabiliyordu → tehlikeli-fonksiyon + sistem-katalog tablo +
  parola-hash kolon denylist'i (savunma-derinliği; otoriter katman = superuser-olmayan DB rolü, ops).
- **[M3] KVKK anonimleştirme** serbest-metin PII'yi (`replacement_requests.reason`/`resolution_note`,
  `replacement_messages.body` + mevcut `email_log.subject`/`security_events.detail`) atlıyor VE
  farklı-kasada yazılmış e-postayı gövdede bırakırken sayacı "maskelendi" diyordu → hepsi
  **büyük-küçük harf duyarsız** `regexp_replace(...,'gi')`; mesaj gövdeleri talep JOIN'i ile kapsanır
  (drizzle `ANY(${arr}::uuid[])` bozuk SQL'i JOIN'e çevrildi — entegrasyon testi yakaladı).
- **[LOW] `bundleQty`** products.controller'da `.positive()` (sınırsız) → `.min(1).max(1000)`
  (site-mappings ile hizalı; sınırsız bundleQty aşırı-teslim DoS).

**Doğrulama:** typecheck 4/4 + check-use-server temiz · api birim 65/65 · admin production build ·
VPS izole test DB **entegrasyon 157/157 + yarış 3/3** (yeni: h1 suspended-refund, revokeExcess
suspended, quarantine-mask, readonly-sql M2 vektörleri, anonymize M3 case-insensitive) · adversaryel
doğrulama workflow (9 ajan) SOUND · prod + dev deploy (deploy.sh rollback'li, ikisi de /health 200).
Migration YOK (tüm düzeltmeler kod/mantık; şemaya dokunulmadı).

### Geleceğe-hazırlık: dayanıklılık + retention + performans (migration 0029)

Kullanıcı: *"tüm eksikleri kontrol edip düzelt, geleceğe hazırla, performanslı+güvenli, sistem asla
sorun yaratmamalı, stres testi yap, tablo sun."* Çok-ajanlı **41-öngörülü arıza-modu taraması** +
**fault-injection testleriyle** (dev izole ortamda Redis/Postgres'i gerçekten kırarak) bulunan sistemik
açıklar kapatıldı. **Kök tema: hiçbir katmanda zaman aşımı yoktu** — bir backing servis yavaşlayınca
istekler hızlı-başarısız yerine SÜRESİZ askıda kalıyordu (ölçüldü: Redis donunca 12sn, PG kilidinde 50sn,
/health bile yanıtsız).

**A — Dayanıklılık (fail-fast, her katmanda zaman aşımı):**
- **Redis:** fail-fast bağlantı (`commandTimeout` 2s + `enableOfflineQueue:false`); BullMQ kendi
  null-retry bağlantısını korur. HMAC nonce Redis-DOWN'da **fail-CLOSED-FAST** (503, askı yok — güvenlik
  kontrolü doğrulanamıyorsa reddet; WP retry eder, veri kaybı yok); rate-limit **fail-OPEN**; `/health`
  `Promise.race` 2s → hızlı `degraded` (503). `maxmemory 768mb + noeviction` (host OOM-kill'i önler).
- **Postgres:** `statement_timeout` 30s + `lock_timeout` 10s + `idle_in_transaction_session_timeout` 60s
  + `connect_timeout` 10s → takılan sorgu/kilit tüm havuzu askıya almaz.
- **Fastify:** `requestTimeout` 30s. **HMAC uçlarına IP başarısızlık-tavanı** — YALNIZ auth-FAIL
  (geçersiz api_key/imza) sayılır; her istekte önce peek ile "bu IP cezalı mı" bakılır (findForAuth DB
  lookup'ından ÖNCE). Meşru mağaza (imzası hep geçerli) ASLA kısıtlanmaz; saldırgan sel N başarısızlıktan
  sonra DB'ye inmeden 429. (Stres testi eski "tüm istekleri say" tasarımının yoğun mağazayı yanlışlıkla
  429'ladığını ortaya çıkardı → düzeltildi.)

**B — Retention/bakım (migration 0029, additive index):**
- **RetentionService** (günlük, batch delete): fulfillment_events 180g SİL · outbox(delivered) 30g SİL ·
  security_events 365g SİL · email_log 365g PII **MASKELE** + 730g SİL (KVKK) · audit_log otomatik-reveal
  gürültüsü 90g SİL (gerçek denetim aksiyonları KORUNUR). Hepsi env ile ayarlanabilir. Manuel:
  `POST /v1/admin/maintenance/retention`.
- **reconcile** sıcak-yol 30 gün penceresi (tam-tablo tarama yerine; `RECONCILE_FULL` ile tam koşu).
- **Sweep hata alarmı** (`@OnWorkerEvent('failed')` → kritik bildirim) — sessiz ölüm bitti.

**C — Performans:** stok import `autoComplete` cap 200 satır inline + kalanı arka plana (BullMQ, jobId
dedupe) → büyük backlog'da import isteği dakikalarca asılmaz (geriye-uyumlu; küçük backlog eski hızlı yol).

**Fault-injection KANITI (dev'de gerçek kırma):** Redis donunca push artık **12sn askı yerine 503/4.5sn**
+ health hızlı degraded; PG advisory-lock tutulurken createOrder **50sn askı yerine 500/10.5sn** ve
**/health 18ms'de yanıt** (cascade bitti). Çifte-satış hâlâ = 0 (yarış 3/3).



### Panelden sürüm yayınlama + sitelerdeki kurulu sürüm görünürlüğü (migration 0028, eklenti v1.0.0)

Kullanıcı geri bildirimi: *"sürüm ve dağıtımı sen gerçekleştir, panel üzerinde güncellemeler
çalışmıyor gibi anlayamadım tam olarak."* Teşhis: iki ekran da **kırık değildi**, ama panelden
uçtan uca **kullanılamıyordu** — `/releases` elde hazır bir `.zip` istiyordu (panelde paket
üretilemez), `/deployments` ise yalnız zaten push edilmiş kodu canlıya alıyordu. Ayrıca hangi
mağazanın hangi eklenti sürümünü çalıştırdığı panelde **hiç görünmüyordu**.

**Kaynaktan yayınla (yeni birincil akış)**
- `/releases` → owner'a özel **"Kaynaktan yayınla"**: dosya seçmeden, tek tuşla yayın. Panel yalnız
  bir istek kaydeder (`deployments` kuyruğu, `target='plugin'`); VPS host'undaki runner
  `scripts/publish-plugin.sh` ile **repo HEAD'inden** paketi üretip panele yayınlar. Panel
  konteynerine Docker/git yazma yetkisi verilmez — dağıtımdaki ayrımın aynısı.
- Yayınlanan sürüm **kodda tanımlıdır** (formda girilmez): "yayınlanan zip = HEAD" invaryantı korunur.
  `publish-plugin.sh` VPS'te **commit atmaz, push gerektirmez** (prod checkout'unda git kimliği ve
  kimlik bilgisi yoktur; commit atsaydı origin'den ayrışıp sonraki `deploy.sh`'ın `git pull --ff-only`
  adımını kırardı). Sürüm artırımı geliştirici makinesinde commit'lenip push edilir.
- Elle `.zip` yükleme kurtarma yolu olarak kaldı (artık "gelişmiş" altında).

**Sitelerdeki kurulu sürüm (görünürlük)**
- Eklenti (v1.0.0+) her imzalı istekte `X-Wpteslimat-Version` gönderir; panel bunu site kaydına
  yazar (değiştiğinde — her istekte UPDATE yok). Başlık **imza kapsamında değildir** (`X-Wp-Actor`
  ile aynı sınıf): yalnız gösterim, yetki kararı verilmez.
- `/releases` → "Sitelerdeki kurulu sürüm" tablosu: güncel / eski (vX mevcut) / bilinmiyor.
  "Eski" damgası yalnız iki sürüm de bilindiğinde basılır — bilinmeyen sürüm "güncel değil" demek
  değildir. **migration 0028** (additive): `sites.plugin_version`/`plugin_version_at`, `deployments.note`.

**Eklenti düzeltmesi**
- Panelde hiç yayın yokken uç `200 {}` döndürüyor; güncelleyici bunu "hata" sayıp 15 dakikalık
  negatif önbellek yazıyordu. Artık "yayın yok" ile "panele erişilemedi" ayrı ele alınır.

### Sistem geneli tarama — 35 doğrulanmış bulgu + 6 kendi-regresyon (migration 0027, eklenti v0.9.1)

8 lensli keşif (mail/kuyruk · auth/RBAC · stok/tedarik · müşteri-destek-güvenlik · rapor/AI/SQL ·
admin UI · WP eklentisi · altyapı/şema) + 4 çekişmeli doğrulayıcı: **54 ham → 35 CONFIRMED**
(19 çürütüldü). Sonra 8 işçi düzeltti, 2 lensli re-doğrulama **düzeltmelerin kendi açtığı 6
regresyonu** buldu, 4 işçi onları kapattı, 3 işçi bağlantı (glue) maddelerini tamamladı.

**Kırık olan (yüksek)**
- `/purchase-orders` ve `/suppliers` sunucu eylemleri **canlıda çalışmıyordu**: `'use server'`
  dosyasından obje re-export'u. Next 15 bu guard'ı **çalışma anında** uyguluyor — `next build`
  temiz geçiyor, ekran ilk tıklamada patlıyor. Commit 9b81c9b'nin tekrarı (önceki tarama metin
  grep'i olduğu için re-export desenini kaçırmıştı). Artık **tip-tabanlı** `scripts/check-use-server.js`
  var ve `pnpm typecheck` ile CI'a bağlı; negatif kontrolle gerçekten yakaladığı doğrulandı.

**Sessiz veri/para kaybı riskleri (orta)**
- `QueueModule` `REDIS_URL`'den yalnız host+port alıyordu → parolalı veya TLS'li Redis'te BullMQ
  sessizce ölür: `/health` yine "ok" der, sipariş 201 döner, ama **teslimat maili, geri-kanal
  webhook ve tüm bakım işleri hiç çalışmaz**.
- Değişim onayı atomik değildi: stok ön-kontrolü ile atama arasında son anahtar kapılırsa eski
  anahtar çoktan karantinaya alınmış oluyordu → müşteri lisansını kaybediyordu.
- `usageMode` multi→single düzenlemesi mevcut MAK anahtarlarının kapasitesini sessizce yok
  ediyordu (güncelleme şeması create refine'larını taşımıyordu).
- KVKK anonimleştirme `security_events` kayıtlarını atlıyordu (müşteri e-postası ekranda kalıyordu).
- Maliyet raporu MAK'ta kapasite birimini anahtar-başı maliyetle çarpıyordu.
- "Atanabilir stok" tanımı kod tabanında **iki farklıydı**: gerçek atama süresi geçmiş kalemi
  dışlıyor, 11 sayım noktası dışlamıyordu → panel/rapor/düşük-stok alarmı/AI özeti/bayi katalog ucu
  var olmayan stoğu gösteriyordu. Hepsi tek paylaşılan yükleme bağlandı.

**Güvenlik / dayanıklılık**
- `/api/login`: IP hız sınırı yoktu, kilit yalnız kimlik başına olduğu için farklı `identifier` ile
  tamamen atlanabiliyordu, `identifier` uzunluk sınırsızdı ve **senkron scrypt tek event loop'u
  60-100 ms bloklıyordu** — ucuz bir istek seliyle teslimat yavaşlatılabiliyordu. Dördü de kapandı.
- `deploy-runner.sh` kendi kilidini alamıyordu (cron'daki dış `flock` + betik içi `flock` aynı
  dosya) → panelden istenen dağıtım hiç koşmuyordu.
- WP klon/staging koruma tabanı yalnız aktivasyonda kuruluyordu; eklenti **güncellemesi**
  aktivasyonu tetiklemediği için kurulu sitelerde koruma kalıcı olarak etkisiz kalabiliyordu.
- `/ops` mail replay'i her kaydı teslimat işi sayıyordu → bir bildirim kaydını replay etmek
  müşteriye tüm anahtarları gönderebilirdi.

**Kullanılabilirlik**
- DataTable aramaları Türkçe İ/I harflerinde sessizce sonuç bulamıyordu (tek `lowerTr` yardımcısı).
- 25 `error.tsx` üretimde İngilizce Next boilerplate'i gösterebiliyordu → ortak `ErrorState`
  (Türkçe metin + "Hata kodu: <digest>").
- Dead-letter listesi 100 kayıtta sessizce kırpılıyordu; "Tekrar dene" artık replay edilemeyen
  kayıtta gerekçesiyle devre dışı (sessiz 400 yok).
- Presence göstergesi hiç durmayan ikinci bir poller'dı (sekme gizliyken de atıyordu).

**migration 0027 — IDEMPOTENT, mevcut kurulumlarda tam no-op**
drizzle meta snapshot'ı 0020'de kalmıştı (0013-0018 ve 0021-0026 elle yazılmıştı) → `db:generate`
aradaki her şeyi "yeni" sanıp yeniden yaratan bir migration üretiyordu; o dosya prod'a gitseydi
`CREATE TABLE deployments` "already exists" ile **API'yi boot ettirmezdi**. Snapshot hizalandı ve
0025'te elle yazılan 5 index şema dosyalarına taşındı. `db:generate` artık **"No schema changes"**.

**Kendi-regresyonlar (re-doğrulama yakaladı)**
Bildirim mailleri kuyruğa taşınmış ama tüketicisi eklenmemişti (**hiç gitmiyordu**) ·
`allocatableCountForLine` süre koşulunu atlıyordu → değişimde sonsuz "tekrar deneyin" ·
0027'nin journal zaman damgası geriye gidiyordu (migration **hiç uygulanmazdı**) · `/ops`
düzeltmesi yarım kalmıştı · `products.update` guard'ı meşru kapasite artırımını da bloke ediyordu ·
`release-plugin.sh` yeni kontrolü commit'lenmemiş kodu fark etmiyordu.

### Eşlenmemiş sipariş görünürlüğü · mağaza→panel gecikmesi · karantina süzme/indirme · mağaza admin URL (migration 0026, eklenti v0.9.0)

Kullanıcının 4 şikâyeti. Dördünün de kök nedeni dev ortamında **gerçek veriyle ölçüldü** (tahmin yok);
3 dalga paralel işçi + 5 lensli çekişmeli denetim (toplam 23 ajan → 22 + 10 doğrulanmış bulgu).

**1) "Eşleştirilmemiş sipariş panelde görünmüyor" — iki ayrı sebep**
- Kayıp sipariş `wc-on-hold` (havale/EFT) durumundaydı; eklenti yalnız `processing`/`completed`
  dinliyordu → panele **hiç push edilmedi**. Ödenmemiş siparişi teslim etmemek doğru (§2) ve
  değişmedi; ama artık mağaza sipariş listesinde **"Panele iletilmedi — ödeme bekleniyor"** etiketi
  ve aynı adla bir **filtre** var → sipariş sessizce kaybolmuyor.
- `GET /v1/admin/pending` yalnız `pending`/`partial` filtreliyordu → `unmapped` sipariş
  **"Bekleyen Teslimatlar" ekranında hiç görünmüyordu**. Artık dahil (ayrı limitler: pending/partial
  200 + unmapped 100, böylece eşlemesiz sel eski siparişleri pencereden düşürmüyor).
- `unmappedOrders` sayacı **satır-tabanlı** oldu: "en az bir eşlemesiz aktif satırı olan sipariş"
  (`product_id IS NULL AND canceled=false AND status IN ('pending','partial')`). Eskisi yalnız
  `orders.status='unmapped'` sayıyordu; o değer ancak satırların **hepsi** eşlemesizse yazılıyor ve
  `recomputeOrderStatus` hiç üretmiyordu → **çok kalemli siparişte tek eşlemesiz kalem gözden
  kaçıyordu** (şikâyetin en can alıcı hâli). Sayaç artık `/mappings` ve `/pending` ile aynı yüklemi
  kullanıyor → üç ekran çelişmiyor. Her `/pending` satırında `hasUnmappedLine` + tek-tık "Eşleştir".
- **Alarm tasarımı düzeltildi:** panodaki kırmızı bant artık **gerçek talepten** (`unmappedOrders`)
  türetiliyor. Katalogdaki eşlenmemiş ürün sayısı (`unmappedCatalogProducts`) **bilgi** sayacıdır —
  mağazanın lisans taşımayan ürünleri de katalogda olduğu için "eşlenmemiş ≠ eşlenmesi gereken";
  o sayaçtan alarm üretmek hiç sönmeyen bir bant (alarm körlüğü) ve operatörü tehlikeli bir
  catch-all eşlemeye iten bir baskı yaratıyordu. Varyasyonlu ürünün ebeveyn satırı da sayımdan
  ve "eşlenmemiş" rozetinden çıkarıldı (SQL üç-değerli mantık: varyasyon-özel eşleme ebeveyne
  asla eşleşmez → hiçbir doğru işlemle sönmeyen sayı).

**2) Mağaza→panel gecikmesi — ölçüldü: 41 sn → 0,6 sn**
- Ölçüm: sipariş 13:07:22'de `processing`, panele 13:08:03'te düştü. Geçmiş kayıtlarda
  12/27/30/65/75 sn. Kaynağın tamamı WordPress tarafı: Action Scheduler'ın async loopback
  dispatch'i güvenilmez, iş wp-cron'un dakikalık kuyruğuna düşüyor ve wp-cron ancak bir sayfa
  isteği geldiğinde koşuyor. **Panel suçsuz** — API yanıtları 9-16 ms.
- Çözüm: iş, yanıt müşteriye gönderildikten **sonra aynı istekte** koşuyor
  (`fastcgi_finish_request` → `litespeed_finish_request` → ikisi de yoksa sınırlı satır-içi koşum:
  1 iş / 2 sn timeout / yalnız `push`+`revoke`). AS güvenlik ağı **korunuyor**.
  Yeniden ölçüm (dev, `apache2handler`/mod_php): **0,6 sn**, sipariş `fulfilled`.
- REST bağlamı **dışlanmıyor**: WooCommerce'in varsayılan blok checkout'u (Store API) bir REST
  isteğidir; dışlansaydı düzeltme en yaygın checkout yolunda çalışmazdı. Yalnız CLI ve cron dışlanır.
- İş kilidi (`INSERT IGNORE` ile gerçekten atomik) + satır-içi iş bitince kuyruktaki ikizin
  `as_unschedule_action` ile iptali → aynı iade/resync iki kez POST edilmiyor (yanıltıcı ikinci
  "0 birim geri alındı" notu bitti). Kilit alınamazsa **sessizce vazgeçilmez**, iş yeniden planlanır
  (aksi hâlde takılı bir kilit AS güvenlik ağını yutup siparişi kalıcı kaybettirebiliyordu).

**3) Karantina süzme + indirme**
- Sunucu-taraflı süzgeç: durum · **tarih aralığı (SQL'de)** · tedarikçi · ürün · arama.
  Tarih süzgeci artık yalnız yüklenen pencerede değil tüm kayıtlarda çalışıyor; "liste kırpılmış
  olabilir" uyarısı ham SQL satır sayısından hesaplanıyor (eskiden süzme sonrası sayıya bakıyordu →
  tam da liste eksikken uyarı kayboluyordu).
- İndirme: kapsam seçimi (görünen süzülmüş N vs tümü M) + biçim (Excel uyumlu CSV / düz .txt) +
  içerik ayrımı **korundu**: "Tedarikçi bildirimi" müşteri e-postası içermez; "İç denetim" tüm
  alanları içerir ve artık **CSV'de de** KVKK uyarı satırı taşır (eskiden yalnız .txt'de vardı).
  UTF-8 BOM + CRLF + Excel formül enjeksiyonu koruması.

**4) "Mağaza panelinde aç" URL'i yanlış**
- Kök neden: link origin'i `sites.webhook_url`'den türetiliyordu; o adres makineden-makineye bir
  adrestir ve iç hostname olabilir — gerçek veri: `http://wordpress/wp-admin/...` (Docker servis adı,
  tarayıcıda çözülemez). Ayrıca panel HPOS yolunu **tahmin** ediyordu (HPOS kapalı mağazada ve
  alt-dizin kurulumunda yanlış).
- Çözüm: link artık **yalnız mağazanın kendi bildirdiği şablonla** üretilir. Eklenti HPOS'u tespit
  edip `admin_url()` ile doğru şablonu katalog senkronuyla panele bildirir (aktivasyon/güncelleme/
  günlük heartbeat tetikleri de eklendi, ürün düzenlemeyi beklemez). Şablon yoksa **link
  gösterilmez** (kullanıcı şartı: "ya doğru olmalı ya hiç link olmamalı"); ekranda şablonun site
  ayarlarından girilebileceği belirtilir. `buildStoreAdminUrl` tek dosyaya taşındı (iki farklı kopya
  vardı) + iç/özel hostname reddi + `user:pass@host` reddi + 14 birim testi (eski test dosyası
  hiçbir vitest config'ine girmediği için **hiç koşmuyordu**, taşındı).
- **migration 0026** (additive): `sites.admin_order_url_template_manual` — şablonun kaynağı.
  Elle girilen değer senkronla ezilmez; otomatik değer de kolonu kalıcı kilitlemez (mağaza HPOS'u
  kapatırsa yeni doğru şablon yazılabilir).

**Yol boyunca kapatılan diğer bulgular:** `syncRefunds` kilitsiz/transaction'sız read-modify-write
idi → eşzamanlı iki iade bayat `fulfilledQty` ile gerekenden **fazla** atamayı geri alabiliyordu
(müşterinin iade etmediği canlı anahtarlar ölür, partial-auto taze stokla doldurur = lisans yanması);
artık advisory-lock + tek transaction + `FOR UPDATE`, kilit sırası diğer yollarla tutarlı (ABBA yok).
Katalog senkron hash'i `admin_url()` şemasına duyarlıydı (proxy arkasında her tetikte tam katalog
DELETE+INSERT) → normalize edildi. `hostMatchesSiteDomain` üst alan adını kabul ediyordu (çok
kiracılıda komşu siteye link yazdırma) → yalnız aynı alan adı veya alt alan adı.

### İş istasyonu partisi — bekleyen satır çözümü, lisans envanteri, canlı akış, destek yazışma (migration 0024 + 0025)

**Bekleyen satır ("eşledim ama sipariş hâlâ eşlenmemiş görünüyor")**
- Kök neden: teslimat motoru satırları `product_id` üzerinden tarar; eşlemesiz satırda o alan
  NULL'dır → eşleme SONRADAN kurulunca eski satırlar hiçbir sweep'e girmez, "Kalanları Ata"
  no-op döner. Yeni `pending-lines` servisi mevcut eşlemeyi **geriye dönük uygular** ve normal
  atama makinesinden geçirir (advisory-lock + `FOR UPDATE` + `product_id` hâlâ NULL re-check).
- **Otomatik eşleştirme YOK:** hiçbir eşleme oluşturulmaz/tahmin edilmez; yalnız operatörün elle
  kurduğu aktif eşleme uygulanır. İptal (`canceled`) satır ASLA bağlanmaz; incelemedeki (held)
  sipariş bağlansa da teslim edilmez.
- Eşleme oluşturulduğunda otomatik (best-effort) çalışır ve "N satır bağlandı, M teslim edildi"
  diye raporlar. `/mappings` → **"Eşleme Bekleyen Sipariş Satırları"** paneli; sipariş detayında
  satır başına **"neden bekliyor" tanısı** + tek-tık aksiyon.

**Yeni ekranlar/özellikler**
- **Lisans envanteri:** `GET/PATCH/DELETE /v1/admin/license-items` — arama/filtre/25-50-100 sunucu
  sayfalama; ürün detayında ve `/stock` "Son Eklenen Lisanslar" bölümünde. Teslim edilen kalemde
  panel siparişi + **mağaza yönetim paneli bağlantısı** (SALT YÖNLENDİRME — panel o adrese
  bağlanmaz, veri çekmez; şablon `sites.admin_order_url_template`, http(s) + `{orderId}` zorunlu).
- **Canlı iş istasyonu:** tek hafif `GET /v1/admin/live` (ETag/304) + tek paylaşılan poller
  (15 sn, gizli sekmede DURUR, üstel geri çekilme, oturum bitince giriş ekranına gider).
  Bildirim çanı (varsayılan ses KAPALI; WebAudio ile üretilir — dosya/ağ isteği yok) + canlı
  genel bakış akışı. SSE bilinçli tercih EDİLMEDİ.
- **Destek:** admin↔müşteri yazışması (iç not müşteriye gitmez), suistimal sayacı, karar Sheet
  içinde; sipariş detayında talep kartı. **Karantina:** CSV dışa aktarma + filtreler; menüde
  Envanter altına taşındı.
- **WP eklentisi:** işlemi yapan kullanıcı (arka plan işlerinde tetikleyen yönetici), "İptal"
  yerine **"Değiştirildi"** + sebep, ürün kalemi altında lisans kartları, `held` rozeti.

**Denetim (5 lens / 32 ajan, bul→çekişmeli doğrula → 23 doğrulanmış bulgu; hepsi düzeltildi)**
- **[YÜKSEK]** Destek yazışması HİÇ açılmıyordu: API `{messages:[...]}` sarmalı döndürürken
  istemci düz dizi sanıyordu → `.map is not a function` → ekran error boundary'ye düşüyordu.
- **[ORTA] bundleQty çift ölçekleme → bedava lisans** ve **ölçek kaybı → canlı anahtar geri
  alınıyor**: ölçek her tüketicide canlı eşlemeden türetiliyordu. **0025** `order_lines.bundle_qty`
  (teslimat anındaki ölçek anlık görüntüsü) + ortak `resolveLineScale`; çözülemezse qty'ye
  DOKUNULMAZ. 3 regresyon testi.
- **[ORTA]** Karantina listesi düz metin anahtarları toplu döndürüyor ama `reveal` audit
  yazmıyordu (§17 değişmezi) → per-view audit kaydı.
- **[ORTA/perf]** `lowStockCount` her poll'da `license_items`'ı tam tarıyordu (status filtresi
  JOIN'e taşındı + 60 sn önbellek + tek-uçuş); envanter listesi count+rows tek sorguya; status
  parametresi cast'lendi (kolon cast'i index'i öldürüyordu); `assigned_desc` LATERAL yerine
  kolondan. **0025**: 5 sıcak-yol index'i.
- **[ORTA]** `consumeMultiUseCapacity` `assigned_at` yazmıyordu → MAK/multi'de teslim tarihi hep boş.
- **[DÜŞÜK ×16]** replaceAssignment advisory-lock · pending-lines `orderCount` çift sayımı +
  `truncated` · `:id` ParseUUIDPipe · site-facing yazışma okuma hız sınırı · WP: panel `replaced`
  bayrağı yetkili, aktör işe bağlandı (kalıcı meta kaldırıldı), `held` rozeti, kontrast (AA), ağ
  hatası mesajı · UI: sessiz 200-kayıt kırpması, CSV'de kişisel veri ayrımı, dürüst sonuç raporu.

### Proaktif katalog senkronu + eşleme Değiştir/Kaldır (migration 0023 · eklenti v0.7.0)
- **Proaktif eşleme:** Yeni `site_remote_products` katalog snapshot tablosu (ad/sku/tip — **SIR YOK**;
  eşlemeler ayrı tabloda, kopmaz). WP eklentisi mağazanın yayınlanmış ürünlerini panele iter
  (`POST /v1/site-mappings/catalog`, HMAC, tam snapshot). Panelde **/mappings → "Site Kataloğu"**:
  site seç → mağazanın TÜM ürünlerini adıyla gör → **sipariş beklemeden** tek-tıkla panel ürününe eşle.
  `GET /catalog/summary` + `GET /catalog?siteId=` (eşleme durumu resolveMapping mantığıyla).
- **OTOMATİK EŞLEŞTİRME YOK (güvenlik):** katalog senkronu yalnız ürün LİSTESİNİ getirir; hangi panel
  ürünüyle eşleşeceğine ASLA karışmaz. Eşleme %100 elle — operatör seçer.
- **Eşlemeyi Değiştir/Kaldır:** `PATCH /mappings/:id` artık hedef panel ürününü değiştirir (remap) +
  bundle; yeni `DELETE /mappings/:id`. Katalog eşli satırında **Değiştir** + onaylı **Kaldır**.
- **Tazeleme modeli:** polling YOK; olay-güdümlü (ürün eklen/sil/düzenle → ~3dk debounce) + WP manuel
  buton. **WP yük optimizasyonu:** katalog değişmediyse (yalnız stok/fiyat edit'i) push atlanır (hash-skip).
- **Adversaryel denetim (deploy-öncesi, 9 ajan → 4 düzeltme):** syncCatalog advisory-lock (eşzamanlı
  snapshot çift-satır/500 kapandı); boş dizi artık kataloğu SİLMEZ (no-op); listCatalog LIMIT 2000→5000;
  geçersiz ?site= tüm sayfayı boşaltmıyor. **Migration 0023.** dev E2E tam yeşil (varyasyon çözümü,
  remap, delete, boş-push wipe-yok dahil).

### Sipariş detayı + destek akışı UX/correctness dalgası (kullanıcı geri bildirimi + 4-lens denetim / 23 bulgu)
- **Sipariş detayı (/orders/[id]):** aktif lisanslar ile iptal/değiştirilen/expired atamalar ayrıldı
  (katlanır "Geçmiş" bölümü); her satır+atamada ürün adı (ham Woo kalem id yerine); başlıkta siparişin
  geldiği site; held (inceleme) sipariş için uyarı bandı + /review linki; held/canceled satırda
  "Kalanları Ata" gizli. "Kalanları Ata" artık added=0'ı dürüstçe raporlar (eskiden hep yeşil "başarılı").
  Değişim geçmişinde eski key TAM görünür (key-tipi ölü/karantina key; account secret maskeli). İptal
  (revoke) sebep sorar; askıdaki atama doğrudan iptal edilebilir.
- **Destek ↔ sipariş bağı:** sipariş detayına "Değişim/Destek Talepleri" kartı (inline Onayla/Reddet +
  /support linki); /support satırı siparişe link. `replacements.approve` TOCTOU advisory-lock + tx
  (çift-tıkta "zaten çözülmüş", sahte "stok yok" değil); onayda müşteriye "değişim onaylandı" bildirimi;
  requestInfo aktör kaydı.
- **WP eklentisi (v0.5.1):** teslimat webhook sipariş notu ham event/enum yerine Türkçe cümle;
  iade sebebi yerelleştirilmiş WC durumu; push/revoke/refund başarısızlığında sipariş notu; metabox
  durum fallback'leri Türkçe + 'unmapped'→'Ürün eşlenmemiş' + bonus i18n.
- **Tutarlılık:** StatusBadge revoked→'Geri alındı' (labels.ts ile); /orders faceti 'Geri alındı';
  müşteri detayı değişim durumu paylaşılan StatusBadge. **Migration YOK.** Doğrulama: typecheck 4/4,
  entegrasyon 115/115 + yarış 3/3, dev canlı uçtan-uca (approve→409 zaten-çözülmüş, eski key tam görünür).

### WP eklentisi v0.5.0 (yayınlandı — panele publish, müşteri siteleri güncelleyebilir)
- **Lisanslar sipariş-kalemi bağlamında (per-line):** her ürünün anahtarları + Göster/Değiştir/
  Askıya al/+1 Bonus + değişim geçmişi artık o ürünün SİPARİŞ KALEMİ altında (uzun sağ metabox
  yerine) → çok ürünlü siparişte her ürün kendi bağlamında yönetilir.
- **Yenilenmiş kart arayüzü (UI/UX):** başlıkta özet sayaç ("N lisans · X aktif · Y askıda"),
  renkli durum rozetleri (Aktif/Askıda/İptal…), ikonlu + hiyerarşik butonlar (nötr Göster / mavi
  Değiştir / amber Askıya al / yeşil Geri aç), ürün-bazlı "Bonus Ekle" alt aksiyonu, katlanır
  değişim geçmişi; **5+ anahtarda kart kaydırılır** (max-height ~232px) → sipariş ekranı asla
  uzamaz. İptal/değiştirilen anahtarda aksiyon butonu görünmez (yanlış işlem imkânsız). Saf
  sunum katmanı — backend/API/kontrat değişmedi, migration yok.
- **+1 Bonus ürün-bazlı:** ayrı sentetik satır (`bonus:<item>:…`) → sonraki Woo senkronu/iadesi
  bonusu geri almaz (qty şişmez).
- **Kritik iade düzeltmesi:** kısmi iade sonrası re-sync artık iade edilen birimleri yeniden
  teslim ETMEZ (net adet gönderilir); `bundleQty>1` üründe iade doğru ölçeklenir (aşırı revoke giderildi).
- 16 WP denetim düzeltmesi (boş-secret webhook reddi, misafir Sorun Bildir, katalog önbelleği,
  100+ toplu-güncelleme parçalama vb.).

### Düzeltildi — teslimat-hazırlık denetimi (5-lens workflow, 16 doğrulanmış bulgu)
- **Dağıtım [yüksek]:** `deploy.sh` rollback artık dala BAĞLI kalır (`git reset --hard`; eskiden
  `git checkout <sha>` → detached HEAD sonraki TÜM deploy'ları kilitliyordu); build/up hatası da
  (yalnız sağlık değil) rollback tetikler; admin hedefi deploy'da runtime probu ile doğrulanır;
  renk kodları yalnız TTY'de (runner logunu/paneli kirletmez).
- **Dağıtım [yüksek]:** `deploy-runner.sh` deploy çıktısını göndermeden jq içinde 20000 karaktere
  kısaltır (>200KB build logu artık `finish`'i 400'lemez → başarılı deploy 'stuck/failed' kalmaz);
  controller Zod cap'leri servis `.slice` ile hizalı; `deployments.request()` advisory-lock ile
  serileştirildi (çift-tık iki 'pending' üretmez).
- **Sürüm raporlama:** `apps/api` + `apps/admin` sürümü 1.0.0'a çekildi → /health + /deployments +
  /settings artık doğru sürümü gösterir (eskiden kalıcı 0.0.0).
- **Eklenti bağlantısı:** "Panele Bağlan" kod akışı artık siteye geri-kanal `webhookUrl`'ini (host
  doğrulamalı) yazar → bağlan-kodla kurulan sitede order.fulfilled/partial webhook'ları GERÇEKTEN
  gönderilir (eskiden NULL kalıp sessizce atlanıyordu); bağlantı testi yanlış-yeşil yerine 'beklemede'.
- **WP performans:** sipariş push/revoke/resync artık Action Scheduler ile ARKA PLANDA çalışır
  (checkout/admin isteği 15sn bloklanmaz; AS yoksa senkron fallback, idempotency+klon guard'ı korunur);
  render okuma yolları (my-account + metabox) 5sn timeout ile asılmaz.
- **WP doğruluk:** `is_clone()` şema-bağımsız (HTTP→HTTPS geçişi artık klon sanılmaz); misafir
  'Sorun Bildir' `order_key` ile yetkilendirilir (eskiden guest checkout'ta hep 403); güncelleyici
  changelog'u `sections`'tan okunur; 'unmapped' durumu için Türkçe etiketler.
- **.env.example:** ölü `NEXT_PUBLIC_API_URL` yerine gerçek `API_URL` belgelenir; `PUBLIC_API_URL` eklendi.

### Eklendi
- **Yayın yönetim sistemi:** CHANGELOG + semantik sürüm + `docs/DEPLOY-LOG.md` (dağıtım
  geçmişi) + `docs/RUNBOOK-RELEASE.md` (adım adım yayın rehberi).
- `scripts/deploy.sh` — panel → prod tek-komut dağıtım (git pull + build + migration +
  health + hata olursa geri alma + deploy-log kaydı).
- `scripts/release-plugin.sh` — WP eklentisi tek-komut yayın (sürüm artır + zip + panele
  yayınla + changelog).
- Admin **/releases (Sürümler)** — eklenti sürüm geçmişi + yeni sürüm yayınlama arayüzü
  (backend `GET/POST /v1/admin/updates/plugin` zaten vardı).
- **Panelden dağıtım yönetimi — /deployments (Dağıtımlar):** canlı sürüm + sağlık +
  dağıtım geçmişi (salt-okunur) ve owner'a özel "Prod'a dağıt" tetikleyici. `deployments`
  tablosu (migration 0021) + API (`POST/GET /v1/admin/deployments`, runner için
  `claim`/`finish`) + host runner `scripts/deploy-runner.sh` (cron → `deploy.sh`). Panel
  konteynerine Docker soketi VERİLMEZ — istek/runner ayrımı güvenlik gereği. Aynı anda tek
  aktif dağıtım; 30dk'dan eski takılı "running" otomatik "failed" (self-heal).
- **Yerel geliştirme ortamı:** `scripts/wp-dev.sh` (tek-komut WordPress+WooCommerce dev
  sitesi, panele otomatik bağlanır), iyileştirilmiş `docker-compose.wp.yml`,
  [docs/GELISTIRME.md](docs/GELISTIRME.md), kök `package.json` kısayolları (`wp:dev`, `stack:up` …).

### Değişti
- **Tam yeniden adlandırma — `jetlisans` kaldırıldı (iç tanımlayıcılar dahil).** İki sistematik ad:
  panel paketleri `@jetlisans/*` → **`@lisans/*`** (kök paket `lisans-panel`); WP eklentisi tüm
  tanımlayıcılar → **`wpteslimat`** (klasör/ana dosya/sınıf/fonksiyon/sabit/option/cron/meta,
  text-domain, REST namespace, updater slug, DB tablosu). DB kimlik şablonları → `lisanspanel`.
- **Geriye dönük uyum (mevcut kurulumlar kesintisiz):** eklenti eski `JETLISANS_*` wp-config
  sabitlerini yeni ada köprüler; tek-seferlik göç eski kuyruk tablosunu + connect-option'larını
  taşır; webhook alıcı eski REST rotasını da dinler.

## [1.0.0] - 2026-07-27

İlk resmî sürümlenmiş yayın. Sistem üretimde, uçtan uca doğrulanmış ve VPS'te canlı
(bu tarihe kadarki tüm geliştirme; ayrıntı: proje geçmişi ve `CLAUDE.md`).

### Öne çıkanlar
- **Çekirdek:** WooCommerce → panel sipariş push (HMAC), atomik key atama (`FOR UPDATE
  SKIP LOCKED`, çifte satış imkânsız), kısmi teslimat, tamamlama motoru, geri-kanal webhook.
- **Ürün modeli:** key / hesap / süreli hesap / kod / stoksuz; tek & çoklu kullanım (MAK).
- **Güvenlik:** AES-256-GCM envelope şifreleme (AAD), HMAC imza + nonce/rotasyon, çoklu-admin
  auth (env-gated), KVKK anonimleştirme, güvenlik olayları/anomali tespiti.
- **Operasyon:** tedarik zinciri (tedarikçi/PO/parti/düzeltme), değişim & garanti kuyruğu,
  müşteri 360 + site→müşteri hiyerarşisi, raporlar, şablonlar, bildirimler, inceleme kuyruğu.
- **Marka:** panel "Lisans Paneli"; WP eklentisi görünen adı "WP Teslimat Eklentisi"
  (bu sürümde yalnız görünen adlar; iç tanımlayıcılar bir sonraki sürümde tamamen
  sadeleştirildi — bkz. [Yayınlanmamış] › Değişti).

### Odaklı denetim (admin yönetimi + WP eklentisi + WooCommerce; 5-lens) → 12 bulgu + 2 karar
- **[A1] owner-only düz-metin** (kullanıcı kararı): sipariş detayı + lisans envanteri + ürün detayı
  düz lisans/parola YALNIZ owner'a; owner-olmayan 'admin' MASKELİ görür. reveal + KVKK anonymize
  uçlarına API `OwnerGuard` (A3); görüntüleme audit'i gerçek admin'e (A2).
- **[A4]** admin auth/hesap yaşam döngüsü (login/başarısız-login/create/disable/reset/remove) →
  `security_events` (brute-force görünür; migration YOK).
- **[C2] §2 invaryantı** (kullanıcı kararı): MAK/multi İADE'de kapasite havuza DÖNMEZ
  (`returnMultiCapacity`; revokeOrderForSite + syncRefunds false; değişim/adet-düşür/recall true).
- **WP/Woo:** silinen ürünün satırı push+iade'de atlanmaz (C1); reconcile eklenen yeni-kalem uyarısı (C3);
  order_key misafir-only DOM (B1); plugin_info paket-URL doğrulama (B3); resolveBundleQty tipi (C5).
- **Çürütüldü:** operatör mağaza ön-yüzünden başka müşterinin siparişini göremez (view_order sahip-özel).

### Güvenlik denetimi (7-lens harici skill workflow → 14 bulgu + sıfırdan re-audit)
- **[HIGH]** `releases/publishRelease` owner-guard eksikti (owner-olmayan admin → tüm müşteri
  sitelerine keyfi eklenti .zip = tedarik-zinciri RCE); Next isOwner() + form-gate + API `OwnerGuard`.
- **[MED]** `reconcileOrder` advisory-lock + tek-tx (eşzamanlı qty-azalt re-push'ta over-revoke /
  canlı-lisans yanması); `bulkReplaceBatch` atomikliği (aynı sınıf); `readonly-sql` composite→text
  cast bypass kapatıldı (re-audit self-regresyonunu yakaladı).
- **Sertleştirme:** DTO üst sınırları, onboarding SSRF host, PII log maskeleme (KVKK), SESSION/
  ADMIN_TOKEN min-24 fail-closed + REQUIRE_AUTH, logout tokenVersion iptal, Docker non-root,
  `.dockerignore` özyinelemeli, `next`→15.5.22 + `nodemailer`→8.0.4, WP updater HTTPS+paket doğrulama.

### Son düzeltmeler (1.0.0 öncesi denetimler)
- 5-lens sistem denetimi → 9 bulgu: `completeLine` webhook kaybı (mail/webhook ayrı
  try/catch), WP klon guard tabanı (const/manuel kurulumda), satış-hızı/stok-önizleme
  status filtreleri, security-scan perf, Sentry health-probe istisnası.
- Round-3 denetim → 19 bulgu (queue/cron, güvenlik/crypto, mail/notif, tedarik/rapor, UX).
- Müşteri bölümü site→müşteri hiyerarşisine taşındı.

[Yayınlanmamış]: https://github.com/ertantaskin/lisans-yonetim-paneli/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/ertantaskin/lisans-yonetim-paneli/releases/tag/v1.0.0
