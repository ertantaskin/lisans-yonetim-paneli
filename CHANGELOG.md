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

### 2. tur: kendi düzeltmelerimin çürütülmesi + kalan alanlar (migration YOK)

Bir önceki partinin düzeltmeleri dağıtıldıktan sonra, onları **doğrulamak değil kırmak** için
iki ajan koşuldu; ayrıca ilk turda derin taranmayan altı alan tarandı. Çekirdek invaryantlar
(çifte satış / haksız geri alma) **kırılamadı**; bulunanlar dayanıklılık, kapsam ve dürüstlük
sınıfında — ve üçü doğrudan **benim önceki düzeltmelerimin açtığı yollardı.**

**Toplu INSERT'e geçiş eskiden var olmayan bir tavan getirmişti.** PostgreSQL Bind mesajı
parametre sayısını int16'da taşır (65535); satır başına 7 kolonla ~9.362 tahsisten sonra
`MAX_PARAMETERS_EXCEEDED` üretiliyor ve **tüm sipariş 500 ile geri alınıyordu** — eski birim-başına
döngüde böyle bir sınır yoktu, yani performans düzeltmesi yeni bir kırılma noktası açmıştı. Bu kod
tabanı aynı tuzağı katalog senkronunda zaten 500'lük dilimlerle çözüyordu; aynı desen uygulandı ve
iki çağırandaki kopya tek dosyaya toplandı. Aynı sınıf `releaseAllocations`'ta da vardı.

**Yazdığım guard ölü koddu.** "Atama kaydı okunamadı" throw'u, belgelediği arızayı — dizide
mükerrer kalem — yakalamıyordu: Map araması başarılı olur, bir atama id'si sessizce kaybolurdu.
Guard gerçek invaryanta bağlandı: *her tahsis için ayrı bir kayıt okundu mu*.

**Kırpma düzeltmem surrogate çiftini bölüyordu.** `.slice(0, N)` kesim noktası bir surrogate
çiftinin ortasına denk geldiğinde yalnız-surrogate kalıyor, Node onu U+FFFD'ye çeviriyor ve ürün
adı veritabanına `…�` olarak **sessizce bozuk** yazılıyordu (dev'de gerçek istekle ölçüldü). Paylaşılan
`truncateUtf16Safe` yazıldı; aynı kusur sipariş `remoteName` yolunda da vardı. Testin içinde kontrol
denemesi var: eski `slice` çıktısının bozuk olduğu aynı testte kanıtlanıyor.

**Yeni yazdığım CI kapısı da eksikti.** "Geçerli YAML" ile "Actions'ın kabul ettiği workflow" aynı
şey değil: `runs-on` taşımayan iş, `run:`/`uses:` içermeyen adım ve **YAML anchor** (js-yaml çözer,
Actions reddeder — bu yazım projede `docker-compose.yml`'de kullanılıyor) dosyayı yine sessizce ölü
bırakırdı. Yalnız elle tetiklenen bir iş akışı da eklendi. Ayrıca DI kapısı `controllers:` dizisini
hiç taramıyordu — oysa bir controller bağımlılığı da API'yi boot ettirmez, yani kapının var olma
sebebi kör noktasındaydı (kapsam 69 → 130 bağımlılık).

**Test boşluğu:** `releaseAllocations`'ın MAK yolu hiç koşmuyordu (yardımcı politika parametresini
kabul ediyor ama dört çağrısı da varsayılanı veriyordu), ve tüm MAK testlerinde birimler eşit
olduğu için bir id↔units eşleşme hatası görünmezdi. İki test eklendi.

**Kalan alanlardan:** yedek özeti `backup` ve `backup-drill` satırlarını ortak 30 satırlık pencerede
okuyordu → gecelik yedek + aylık tatbikat kurulumunda tatbikat pencereden düşüyor ve DR alarmı
"hiç başarılı tatbikat kaydı yok" diye **erken ve yanlış gerekçeyle** çalıyordu. Destek yazışması
`ASC ... LIMIT 500` ile en **yeni** mesajları sessizce düşürüyordu — bir destek ekranında görülmesi
en kritik satır sonuncusudur. `/reports` ile `/reports/reorder` iki farklı "satış" tanımı kullanıyor
ve aynı ürün için çelişen tükenme tahmini üretiyordu. Tedarikçi fişindeki düz metin anahtar anlık
görüntüsü hiç budanmıyordu (şifreli `payload_enc` ile asimetrik); kapanmış fişlerde artık maskeleniyor,
satır ve fiş izi korunuyor. AI hız sınırı IP başınaydı ama panel çağrıları proxy'lendiği için tek
global kovaya çöküyordu (bir operatör hepsini kilitliyordu), günlük özet ucunda ise hiç sınır yoktu.

### Proje geneli 6-lensli denetim: CI'ın 19 gündür ölü olduğu bulundu (migration YOK, eklenti 1.1.1)

Altı bağımsız lens (en yeni kod · güvenlik/RBAC · performans/DB · çekirdek para yolu ·
ops/kuyruk/env/betikler · admin arayüzü + WP eklentisi) paralel tarandı; her bulgu
raporlanmadan önce çürütme denemesinden geçti. Doğrulama temeli ölçülerek başlandı
(typecheck, kapılar, birim testleri, build, bağımlılık denetimi, migration damga sırası,
şema sapması — hepsi temizdi), yani aranan şey "zaten bozuk olan" değil **henüz görünmeyendi**.

**En ağır bulgu: `.github/workflows/ci.yml` GEÇERLİ YAML DEĞİLDİ.** `- name: 'use server'
export denetimi` satırında tek tırnakla BAŞLAYAN bir skalerden sonra düz metin geliyordu →
`bad indentation of a mapping entry (38:28)`. GitHub Actions böyle bir dosyayı reddeder, yani
**iş akışının tamamı hiç koşmuyordu**: 'use server' denetimi, Nest DI kablolaması, env
passthrough, typecheck, birim testleri, WP php-lint, migration drift, `bash -n`. Hepsi yeşil
sanılıyordu; hiçbiri çalışmıyordu. Kırılma `2026-07-28` / `ee59e14` commit'inde girmiş — yani
tam da "sessiz kırılmayı önleyecek" kapıyı CI'a ekleyen commit'te; 19 gün sürdü. Bu projenin
tekrarlayan dersi bir kez daha doğrulandı: **sessizce hiç çalışmayan bir kapı, kapı
olmamasından beterdir.** Satır düzeltildi ve tekrarını engellemek için yeni bir kapı eklendi
(`scripts/check-workflows.js`): iş akışı dosyalarının gerçekten ayrıştırılabildiğini, `on:`/`jobs:`
taşıdığını, her işin en az bir adımı ve hiçbir adımın boş `run:` içermediğini denetler. Kapı
**yerel `pnpm typecheck` zincirinde** — dosya ayrıştırılamıyorsa o dosyadaki hiçbir adım
koşmaz, dolayısıyla kendini denetleyemez; CI'daki kopyası ikincil güvencedir. Kontrol
denemesiyle doğrulandı (hatalı satır geri konunca kapı kırmızıya düştü).

**Kurulum rehberi özelliği panelden ETKİNLEŞTİRİLEMİYORDU.** Ürün formu `<select name="guideId">`
alanını basıyordu ama sunucu aksiyonundaki gövde kurucusu (`buildProductBody`) onu FormData'dan
hiç okumuyordu — iki satır yukarıda `categoryId` okunuyor, rehberde o çift yok. Operatör rehberi
seçip kaydediyor, ekran yeşil sonuç veriyor, hata çıkmıyor, form kaydettikten sonra seçimi doğru
gösteriyor; ama `guideId` gövdede hiç gitmediği için API `.partial()` şeması alanı "değişmedi"
sayıyor ve `products.guide_id` NULL kalıyordu → rehber müşteri sayfasında, teslimat e-postasında
ve `.txt`'de HİÇ görünmüyordu. Özelliğin dev doğrulaması bağı doğrudan API'den kurduğu için bu
kaçmıştı. Kök sebep test edilebilirlikti: fonksiyon bir `'use server'` dosyasında yaşıyordu ve
oradan yardımcı export etmek yasak (Next kuralı, `check-use-server.js` zorlar) → **testi
olamıyordu**. `apps/admin/lib/product-form-body.ts`'e taşındı ve formdaki her alanın gövdeye
ULAŞTIĞI 12 testle kilitlendi; kontrol denemesinde düzeltme geri alınınca 5 test kırmızıya düştü.

**Güvenlik.** `POST /v1/admin/sites` taze `apiKey` + `hmacSecret` üretip çağırana döndürüyor ama
`OwnerGuard` taşımıyordu; Next tarafındaki `createSiteAction` da `isOwner()` kapısı taşımıyordu.
Kardeş uçların ikisi (`rotate-secret`, `connect-code`) tam bu gerekçeyle owner-only idi. Kapısız
hâlde owner-olmayan bir admin kendine site açıp panelin kataloğundan bir ürüne eşleme kurup
sipariş oluşturarak `GET /v1/orders/:id/deliveries` üzerinden gerçek bir lisansı **düz metin**
okuyabiliyordu — A1/A3 kararını ("düz metin yalnız owner", reveal audit'li) tamamen atlayarak.
API'ye guard eklendi; ayrıca hiçbir sayfada render EDİLMEYEN `create-site-form.tsx` ve onun
`createSiteAction`'ı tamamen kaldırıldı (form ölüydü ama aksiyon, aynı `'use server'` modülünden
export edildiği için hâlâ çağrılabilir bir uç noktasıydı — kanonik akış `/sites/new` sihirbazı).
`GET /v1/admin/users` de owner kapısına alındı (tutarlılık). pino redact listesine `password` /
`fields` / `value` gövde yolları eklendi.

**Çekirdek para yolu — §2 ihlali (sessiz aşırı-satış).** `revokeExcess` (adet-düşür) MAK/çok
kullanımlı kapasiteyi havuza GERİ VERİYORDU, `syncRefunds` (iade) ise vermiyordu — aynı fiziksel
olay, zıt semantik; üstelik iki entegrasyon testi bu çelişkiyi ayrı ayrı kilitliyordu. Mağaza
re-push'u NET adet (brüt − iade) taşıdığı için bir WooCommerce iadesi `/refund` yerine bu yoldan
uzlaşabiliyor (ör. `/refund` işi kalıcı başarısız olduysa ya da admin aynı istekte kalem
düzenlediyse) ve o durumda HARCANMIŞ aktivasyonlar havuza dönüp **başka bir müşteriye
satılabiliyordu**. Teslimattan sonra adedin düşmesi MAK için iadeyle fiziksel olarak aynıdır ve
hangi yoldan geldiği ayırt edilemez → §2'nin ihtiyatlı kuralı iki yolda da uygulanıyor. Ayrıca
geri alınacak atamanın seçimi deterministik yapıldı: **önce askıdakiler** (zaten devre dışı →
müşterinin kullandığı canlı anahtarı öldürme), sonra en yeni, sonra `id`. Tie-break şarttı:
bir siparişin atamaları tek transaction'da yazıldığı için `created_at` damgaları birebir aynıdır.

**Performans.** Atama motorunda birim başına ayrı `INSERT` vardı: tek-kullanımlık üründe
`allocate()` kalem başına bir tahsis döndürdüğü için qty=500'lük bir satır 500 seri gidiş-dönüş
demekti — hepsi transaction içinde, satır kilitleri tutulurken, havuzun (max 10) bir bağlantısı
rezerveyken ve kota açık sitede `pg_advisory_xact_lock(site)` altında (aynı mağazanın diğer
siparişleri de o süre boyunca serileşiyordu). Tek çok-satırlı `INSERT`e indirildi; eşleme
sıraya değil `licenseItemId`'ye dayanıyor (RETURNING'in giriş sırasını koruduğu yazılı bir
garanti değildir). Aynı sınıf `releaseAllocations`'ta da vardı ve tam da **stok yetmediğinde**
(all-or-nothing geri alımı) tetikleniyordu → tek `UPDATE … FROM (VALUES …)` ifadesine indirildi.
Düşük-stok süpürmesi kısmi indeksi kullanamıyordu (süzgeç JOIN yerine agregat `FILTER`'ındaydı);
kardeş sorgu bunu gerekçesiyle çoktan çözmüştü, alarm üreten yol geride kalmıştı — büyük
kurulumda `statement_timeout`'a takılıp **düşük stok alarmını hiç üretmeyebilirdi**. Tedarikçi
fişi detayı tek fiş için bile tüm `supplier_claim_items`'ı agregeliyordu (gruplu alt sorguya
yüklem itilemez) → `LATERAL`. Ürün detayındaki parti ve satın-alma-emri listeleri LIMIT'sizdi
(bu iki tablo stok girişi başına birer satır alır) → tavan + görünür kırpma uyarısı. Ürün
kaydetmenin sıcak yolundaki rehber varlık denetimi tüm rehber gövdelerini çekiyordu → `exists()`.

**Gözlemlenebilirlik.** Teslimat maili arızasının alarmı YOKTU: günlük kritik alarm yalnız
`outbox_events`'e bakıyordu, `email_log`'a bakmıyordu. SMTP kimliği/kotası bozulunca siparişler
teslim edilmeye devam eder, panel "fulfilled" der, geri-kanal webhook başarılı olur, mailler
sessizce ölürdü ve sabah digest'i "Sorunlu webhook: 0" derdi. Artık iki kanal ayrı sayılıyor ve
alarmda ayrı yazılıyor. Dış kopya alarmında şiddet yükselmesi kendi dedupe'una takılıyordu
(`skipped` warning ile `failed` critical aynı tipi paylaşıyordu → operatörün dış kopyanın
alındığını sandığı en tehlikeli durum, daha zararsızı tarafından 24 saate kadar bastırılıyordu)
→ tipler ayrıldı, etiketi `labels.ts`'e eklendi.

**Kapılar ve betikler.** `check-env-passthrough` iki okuma biçimini görmüyordu (`getOrThrow(` ve
sabit ara değişken) — kör noktasındaki değişkenler `MAIL_FROM`, `SMTP_PORT`, `REDIS_URL`,
`ADMIN_TOKEN`, `AUTOCOMPLETE_INLINE_CAP` idi ve zod bunlara varsayılan verdiği için compose'dan
düşseler CI yeşil kalıp `.env` sessizce yok sayılırdı (kapsam 44 → 49). `check-nest-wiring`
`@InjectQueue`'yu hiç denetlemiyordu — kayıtsız kuyruk API'yi HİÇ boot ettirmez, yani kapının
var oluş sebebi olan sınıf kör noktasındaydı (+13 kuyruk bağımlılığı). `deploy-runner.sh` claim
hatasında tek satır log basmadan çıkıyordu (ADMIN_TOKEN rotasyonundan sonra panelden basılan
dağıtım isteği hiç claim edilmez, teşhis izi kalmazdı); `backup-runner.sh` aynı alt-kabuk
tuzağını taşıyordu (`claim="$(api …)"` komut ikamesi alt kabukta koştuğu için HTTP kodu ana
kabuğa dönmüyor, teşhis satırı her zaman bayat `0` basıyordu → 401 ile ağ hatası ayırt
edilemiyordu). Kabuk betiklerinin exec biti için kapı yoktu (`bash -n` 100644 bir dosyada da
geçer; runbook'lar bu betikleri doğrudan crontab'a koyuyor ve bu bir kez yaşanmıştı). Dördü de
kontrol denemesiyle kırmızı görülerek doğrulandı.

**Arayüz.** Owner-only aksiyonlar (secret yenile · site askıya al · bağlan kodu üret · KVKK
anonimleştir) gate'siz sunuluyordu: operatör "GERİ ALINAMAZ" kırmızı onayını geçtikten SONRA
"yetkiniz yok" alıyordu → karar sunucuda (`isOwner()`) verilip istemciye serileştirilebilir
boolean olarak geçiyor. Şablon tablosu kod tabanındaki son `includesString` kalıntısıydı →
"TESLİMATI" araması "Lisans Teslimatı"nı bulmuyordu (Türkçe İ). Ctrl+K paleti `unmapped`
durumunu ham İngilizce basıyordu (aynı sipariş `/orders` listesinde "Eşlenmemiş" diyordu).
Ölü `revealAction` kaldırıldı — çağrılırsa hiç yaşanmamış bir "lisans görüntülendi" olayını
denetim izine yazıyordu. 9 rotaya eksik `loading.tsx`/`error.tsx` eklendi. `/guide`'daki iki
yanlış vaat düzeltildi.

**WP eklentisi (1.1.1).** Katalog senkronunda kırpma birimi uyuşmazlığı vardı: eklenti kod
noktası, panel UTF-16 kod birimi sayıyordu → emoji/astral karakter taşıyan TEK bir ürün adı
`products` dizisinin tamamını 400'letiyor, snapshot hiç yazılmıyor, operatör `/mappings`'te
boş katalog görüyor ve tek iz mağazadaki `error_log` oluyordu (sessiz). Panel artık reddetmek
yerine kırpıyor (`remoteName` ile aynı desen), eklenti de aynı birimde ölçüyor. Ayrıca eşleme
kutusundaki bozuk hata mesajı, çok baytlı kırpmanın mesajı boşaltması, ölü ikinci maske tanımı
ve bonus önekinin iki yerde ayrı ayrıştırılması düzeltildi.

### Kurulum / etkinleştirme rehberleri + teslimat arayüzü yenilemesi (migration 0045, eklenti 1.1.0)

Lisans anahtarını teslim etmek yetmiyordu: müşteri "Office 365'e nasıl giriş yaparım",
"Windows anahtarını nereye girerim" cevabını alamadığı için destek yükü oluşuyordu. Artık
operatör talimatı panelde bir kez yazıyor, ürüne bağlıyor; teslimatla birlikte otomatik gidiyor.

**Veri modeli.** Yeni `product_guides` tablosu + `products.guide_id` (`ON DELETE SET NULL`).
Metin ürüne GÖMÜLMEDİ: "Office 2021 etkinleştirme" anlatısı onlarca SKU'da aynıdır, gömülü
olsaydı tek bir adım değişince onlarca ürünü elle güncellemek gerekirdi (ve biri unutulunca
müşteriye YANLIŞ talimat giderdi). Başlık benzersizliği Türkçe-duyarlı (`translate(title,'İIı','iii')`
— düz `lower()` "OFFICE KURULUMU" ile "office kurulumu"nu ayrı sayıyor, `product_categories`
ile aynı ölçülmüş gerekçe). Rehber silinince ürün silinmez, rehbersiz kalır ve kaç ürünün
etkilendiği onay kutusunda yazılır.

**Üç yüzey, TEK render.** Mağaza sipariş sayfası (HTML), teslimat e-postası (düz metin) ve
müşterinin indirdiği `.txt` aynı koddan beslenir (`packages/shared/domain/guide.ts`). Eklenti
PHP'de ikinci bir ayrıştırıcı TAŞIMAZ — iki uygulama er geç ayrışır ve aynı metin iki yüzeyde
farklı görünür (bu projede tekrar eden bir hata sınıfı). Biçimleme markdown'ın küçük ve güvenli
bir alt kümesidir: ham girdi önce kaçırılır, sonra yalnız tanınan kalıplar (`1.` adım listesi,
`-` madde, `##` başlık, `**kalın**`, `https://` bağlantı) etikete çevrilir → rehber metni
müşterinin tarayıcısında script çalıştıramaz. Eklenti üretilen HTML'i ayrıca `wp_kses`
allow-list'iyle süzer (savunma derinliği).

**Karakter sınırı 4.000 — sayı e-posta istemcisinden geriye doğru hesaplandı.** Gmail bir
e-postayı 102 KB'ı aşınca kırpar ve kırpılan yer genelde mesajın SONUDUR, yani tam da rehberin
bulunduğu yer. Türkçe metinde 4.000 karakter en kötü ~7 KB; şablon + anahtar listesi ~2-6 KB;
quoted-printable ~1,3 kat şişirir → 3 rehberli siparişte en kötü ~30 KB. E-postaya en fazla
3 rehber ve toplam 12.000 karakter konur; sınıra takılan rehber SESSİZCE düşürülmez, müşteriye
kalanları nerede bulacağı yazılır. Sınırın SEBEBİ panelde de yazılıdır.

**Mevcut şablonlarda rehber sessizce kaybolmuyor.** Şablonda `{{guides}}` varsa blok tam oraya
yerleşir; YOKSA mailin sonuna eklenir (`withGuides`). Yalnız token'a güvenilseydi, veritabanında
zaten kayıtlı olan ve bu token'ı içermeyen şablonlarla çalışan operatör rehberin gittiğini
SANIR, müşteri hiç göremezdi ve hata da alınmazdı. Kontrol denemesiyle doğrulandı (fix geri
alınınca test KIRMIZI).

**Numaralandırma kusuru (render sırasında bulundu).** Adımlar arasına boş satır koymak çok doğal
bir yazım biçimi ama her boş satır yeni bir blok açıyor → her adım kendi `<ol>`'u oluyor ve HTML
numarayı 1'den YENİDEN başlatıyordu: müşteri "1. 1. 1." görürdü, üstelik aynı metnin düz metin
sürümü doğru numaraları gösteriyordu (iki yüzey sessizce ayrışıyordu). `start` özniteliğiyle
yazılan numara korunur; eklentinin kses listesi `ol` için `start`'a izin verir (vermezse
öznitelik sessizce silinir ve kusur geri gelir).

**Panel.** Yeni `/guides` ekranı: başlık + metin, **canlı önizleme** (mağaza görünümü ↔ e-posta
görünümü sekmeli), karakter sayacı, biçimleme yardımı ve **hazır taslaklar** (Office 365,
Office 2021/2019, Windows 10/11, genel hesap). Hiçbir ürüne bağlı olmayan rehber müşteriye ASLA
ulaşmaz → listede "Ürüne bağlı değil" uyarısıyla işaretlenir (sessiz kayıp koruması). Ürün
formuna rehber alanı eklendi (serbest metin değil, listeden seçim); mevcut seçim listede yoksa
seçenek olarak basılır — aksi halde kaydetmek ürünü sessizce rehbersiz bırakırdı.

**Mağaza teslimat görünümü kart yapısına geçti** (eklenti 1.1.0): her ürün kendi kartında
(başlıkta lisans adedi), anahtarlar sarmalı kod bloklarında — uzun anahtarların son haneleri
artık kırpılmıyor. Renkler tema-nötr yarı saydam katmanlar; eski sabit açık gri zemin koyu
temalarda metni yutuyordu. Rehber, o ürünün kartı içinde katlanır bölüm olarak durur (tek ürünlü
siparişte açık gelir). Tarayıcıda ölçüldü: açık+koyu temada okunur, 360px kapta yatay kayma 0,
taşan öğe 0, kırpılan anahtar 0.

**Yol boyunca kapatılan sapma.** Şablon editörü "desteklenen değişkenler" listesinin KENDİ
kopyasını tutuyordu ve ayrışmıştı: API `valid_until` besliyor ama editörün kopyasında o alan
YOKTU → `{{valid_until}}` yazan operatör "desteklenmiyor, gönderimde boş çıkar" uyarısı
alıyordu; oysa değişken çalışıyor ve panelin kendi sunucu-taraflı önizlemesi onu geçerli
sayıyordu (aynı ekranda iki cevap). Liste `@lisans/shared`'a taşındı, iki taraf oradan okuyor.

**Yayın sonrası, kendi kodumun denetiminde bulunanlar.** (a) Rehber gövdesi atama satırlarının
LEFT JOIN'indeydi ve SATIR BAŞINA tekrarlanıyordu: 50 anahtarlı siparişte 4.000 karakterlik metin
50 kez (≈200 KB) taşınıyordu — üstelik bu uç yalnız sayfa render'ında değil mağazanın canlı
yoklamasında da (8-60 sn'de bir) çağrılıyor. Gövde aynı `Promise.all` içindeki bağımsız
`selectDistinct`'e taşındı: ek round-trip yok, taşınan veri sabit. (b) Rehber yolu tamamen
testsizdi → 5 davranış kilitlendi; kontrol denemesiyle iptal-satır filtresi kaldırılınca tam o
testin kırmızıya düştüğü görüldü. (c) Alan ipucu "sağda görünür" diyordu ama önizleme dar
ekranda altta durur; sınırın gerekçesi de sayacın altında ikinci bir paragraf olarak kalıyordu.

Doğrulama: typecheck 4/4 · üç kapı temiz (`use-server` 26/90, nest-wiring 42/69, env 44) ·
birim **57 + 135 + 152** · build 3/3 · şema sapması yok (0045'in damgası 0044'ten büyük — bu
projede tekrarlayan `when` tuzağı kontrol edildi) · VPS izole test DB **entegrasyon 401/401 +
yarış 3/3** · PHP-lint 13/13 + eklenti davranış testleri 108/108 · `pnpm audit --prod` temiz ·
31 rota 200 · prod `/v1/health` 200 v1.1.0, api 0 ERROR · eklenti v1.1.0 yayınlandı.

### Dış kopya (offsite) yokluğu artık alarm üretiyor (migration YOK)

Yedek **tazeliği** ve **tatbikat** için alarm vardı, **dış kopya için yoktu**. Sonuç: yedekler
düzenli alınır, tatbikat geçer, iki alarm da susar — ama her dump yalnız yedeklemenin sebebi
olan makinede durur. Sunucu kaybedilirse veri de MASTER_KEY de gider ve "yedeğimiz var" sanısı
gerçek bir kurtarma imkânı olmadan sürer. Durum `/deployments` ekranında rozet olarak
görünüyordu, ama rozet yalnız bakana yarar. Canlı ölçüm: prod'da `BACKUP_OFFSITE_CMD` tanımsız.

İki durum ayrı şiddet taşır, çünkü yapılacak iş farklıdır: kanca **kurulu değilse** `warning`
ve 7 gün dedupe (sürekli bir durum, alarm yorgunluğu yaratmamalı); kanca **kurulu ama
başarısızsa** `critical` ve 24 saat dedupe — operatör dış kopyanın alındığını sanıyor, ve
yanlış güven hiç güvenmemekten tehlikelidir. Yalnız başarılı son yedeğe bakılır: yedek zaten
alınamıyorsa asıl sorun `backupStale`'dir ve o alarm ayrıca çalışır.

Yeni bildirim tipi etiket sözlüğüne de eklendi — eklenmeseydi operatöre ham `backup_offsite`
kodu görünürdü (bir önceki turda düzeltilen kusurun aynısı). Üç şıklı entegrasyon testi
(warning / critical / yanlış pozitif üretmez), kontrol denemesiyle kırmızı olduğu doğrulandı ve
alarmın canlıda gerçekten düştüğü görüldü.

### Denetim: havuz kilitlenmesi, sessiz ölen arka plan işi, üç otomatik kapı (migration YOK)

Proje adım adım yeniden incelendi. Doğrulama temeli önce ÖLÇÜLDÜ (neyin bozuk olduğunu
bilmeden aramamak için): typecheck 4/4, birim **148 + 135 + 35**, `pnpm audit --prod` temiz,
migration `_journal` sıra ihlali yok, rota/menü/rehber kapsamı tam, env geçirme tam,
etiket sözlükleri API'nin ürettiği değerlerin tamamını karşılıyor. Aşağıdakiler bulunan
gerçek kusurlardır.

**Fiş kesme, ağır yük altında tüm paneli kilitleyebilirdi.** `supplier-claims.create`
transaction'ının İÇİNDEN `listQuarantine` kök bağlantı havuzunu kullanıyordu. postgres.js'te
`transaction()` havuzdan bir bağlantı rezerve eder; gövdeden kök havuza sorgu atmak İKİNCİ bir
bağlantı ister. Koddaki gerekçe "advisory-lock bağlantı açlığını da sınırlar (aynı anda en
fazla bir fiş kesme)" diyordu ve bu **akıl yürütme yanlıştı**: kilit yalnız kaç transaction'ın
kilidi GEÇTİĞİNİ sınırlar, kaçının BAĞLANTI TUTTUĞUNU değil. Eşzamanlı istekler (çift tık,
birkaç operatör, retry) kilidi beklerken havuzu (max 10) doldurursa kazanan istek ikinci
bağlantıyı alamaz ve hiçbiri ilerleyemez → `idle_in_transaction_session_timeout` (60 sn)
hepsini öldürene dek `/v1/health` dahil tüm panel bağlantısız kalır. Bu arıza sınıfı
`createOrder` yolunda daha önce k6 ile ölçülmüştü (100 VU → 0 tamamlanan iterasyon).
`listQuarantine` artık opsiyonel bir executor alıyor ve fiş kesme kendi `tx`'ini geçiyor.
İki incelik: (a) görüntüleme-audit'inin "best-effort yutma"sı YALNIZ kök havuzda geçerli —
transaction içinde patlayan bir ifade tüm transaction'ı abort eder (25P02) ve yutmak bunu
gizleyip sonraki her ifadeyi anlaşılmaz biçimde düşürürdü, o yüzden tx yolunda hata propage
edilir; (b) üç id-toplama sorgusu tx içinde SIRALI koşar — kod tabanında bir transaction
gövdesinde `Promise.all` kullanan başka örnek yok, doğrulanamayan bir desene bağlanmadı.

**Arka plan stok tamamlama işi sessizce ölebiliyordu.** Stok girişi inline olarak yalnız
CAP (vars. 200) satır tamamlar, gerisini `stock-autocomplete` kuyruğuna devreder. Bu
işleyicinin `@OnWorkerEvent('failed')` alarmı YOKTU — üstelik hem işleyici hem kuyruk dosyası
"kalıcı başarısızlıklar /ops dead-letter'da görünür" DİYORDU; bu yanlış: `/ops` yalnız
`outbox_events` + `email_log` okur, BullMQ'nun başarısız işlerine hiç bakmaz. Yani stok
girilmiş olmasına rağmen bekleyen siparişler teslim edilmeyebilir, müşteri lisansını almaz ve
hiçbir alarm çıkmazdı; operatör bunu ancak şikâyetle fark ederdi. Diğer süpürmelerle aynı
desende kritik alarm eklendi (yalnız SON denemede — ara denemelerde alarm, sonradan başarılı
olan geçici DB hatalarını kritik bildirime çevirirdi) ve iki yanlış yorum düzeltildi.

**Tie-break eksikleri (projenin kendi kuralı: LIMIT'li her ORDER BY'ın tie-break'i olmalı).**
En önemlisi `resolveMapping`: `mappings_site_remote_uniq` unique index'i NULL varyasyonu ayrı
saydığı için varyasyonsuz mükerrer eşleme satırı mümkündür (uygulamada advisory-lock ile
engelleniyor, eski/elle veri taşıyabilir) ve eşit `created_at`'te hangi ürünün teslim
edileceği keyfiydi; `/mappings` ekranının bu seçimi taklit eden sorgusu da aynı sıraya
hizalandı (ayrışırlarsa panel, teslimatta seçilecek olandan başka bir eşleme gösterir).
Ayrıca global arama (sipariş), destek kuyruğu (200 tavanlı), eşlemesiz ürün listesi
(500 tavanlı — çok kalemli siparişlerde `last_seen` eşitliği olağandır) ve katalog listesi
(5000 tavanlı; varyasyonlar çoğu mağazada ebeveyniyle aynı adı taşır).

**Üç sessiz-arıza sınıfı artık otomatik kapıya bağlandı** (üçü de `pnpm typecheck` ve CI'da
koşar; üçü de fix geri alınarak KIRMIZI olduğu doğrulandı):

- `scripts/check-nest-wiring.js` — bir sağlayıcının constructor bağımlılığı modülünden
  görünmüyorsa **API hiç boot etmez**; `tsc`/`next build` bunu yakalamaz. Bu sınıf iki kez
  yaşandı. Not: aynı denetim önce `Reflect.getMetadata('design:paramtypes')` ile bir birim
  testi olarak yazıldı ve **hiçbir şeyi denetlemediği** görüldü (esbuild `emitDecoratorMetadata`
  üretmez → glue kaldırıldığında test yeşil kaldı) — TypeScript AST'ye taşındı.
- `scripts/check-env-passthrough.js` — kodun okuduğu her çalışma-anı env değişkeni compose'da
  geçirilmeli ve `.env.example`de belgeli olmalı ("`.env`'e yazdım, hiçbir şey değişmedi"
  sınıfı; iki kez yaşandı). İlk sürümü yalnız `process.env.X` okumalarına bakıyordu ve 44
  değişkenin 18'ini görüyordu — görünmeyenler tam da geçmişte unutulanlardı (`RETENTION_*`,
  `HMAC_IP_FAIL_LIMIT`, `SMTP_*`); `ConfigService.get()` ve `days()/envInt()` yardımcıları da
  tarandı. Bulduğu tek gerçek boşluk: `APP_VERSION` yalnız yorum satırıydı, atanabilir satırı
  yoktu → operatör ayarlanabilir olduğunu göremiyordu.
- `scripts/smoke-routes.sh` — rota listesi artık `app/` ağacıyla otomatik karşılaştırılır.
  Elle karşılaştırma notu yetmemişti: `categories`, `sites/new` ve `templates/new` üç ayrı
  turda listeye eklenmeyi unutuldu, yani betik vardı ama yeni ekranları hiç taramıyordu.

Doğrulanmış ama düzeltilmeyen: `dynamic-quota-hold` + `replace-assignment` testlerinde bir
kez görülen flake'in sebebi **kanıtlanamadı** (uydurulmadı). Tek makul aday, ilk testin 20
siparişlik döngüsünün yerel gece yarısını geçmesi (`date_trunc('day', now())` bugünü sıfırlar)
— pencere çok dar, tekrarlatılamadı.

### Denetim: zaman çizelgesi sırası + görünmeyen etiketler (migration 0044)

Proje baştan sona yeniden denetlendi (doğrulama temeli: typecheck 4/4, birim 148+135+35,
entegrasyon 394/394, yarış 3/3, şema sapması yok, `pnpm audit --prod` temiz). Çekirdek
para yolu (atama/iade/değişim/kota), RBAC kapıları ve düz-metin maskeleme kapsamlı biçimde
denetlendi ve **temiz çıktı**; aşağıdakiler bulunan gerçek kusurlardır.

**Sipariş zaman çizelgesi yanlış sırada gösterebiliyordu.** Bir siparişin olayları tek
transaction'da yazılır (`order_received` → `fulfilled`/`pending_stock`) ve PostgreSQL'de
`now()` transaction başlangıcını döndürdüğü için damgalar **birebir aynı** olur. Sıralama
yalnız `created_at` ile yapıldığından bu olaylar keyfi sırada dönüyordu: sipariş detayında
"Geri alındı" satırı "Sipariş tamamlandı"nın üstünde görünebiliyor ve sıra sayfa yenilendikçe
değişebiliyordu — denetim izi niteliğindeki bir ekranda olayların nedensel sırasını yanlış
anlatan bir durum. Ölçüldü: dev verisinde aynı damgayı paylaşan **7.200 olay grubu**
(`fulfilled + line_completed + revoked` üçlüleri dahil). `fulfillment_events.seq` eklendi
(migration 0044, `license_items.seq`/0030 ile aynı desen ve aynı rewrite uyarısı; uygulanırken
prod 5, dev 14.418 satırdı — ölçüldü) ve sıralama `created_at, seq` oldu.

**Kritik mail alarmı operatöre ham kod olarak görünüyordu.** `mail_config` bildirimi
(üretimde mail hedefi yakalayıcıya bakıyor → teslimat mailleri gerçek müşteriye ulaşmıyor)
etiket sözlüğünde yoktu. Bu alarm prod'da **canlıydı**: ölçüldüğünde 26 kayıt vardı, en yenisi
aynı gün. Aynı sınıftan ikinci boşluk: yeni `account_credentials_rotated` olayı da sözlüğe
eklenmemişti, yani zaman çizelgesinde ham `account_credentials_rotated` çıkıyordu. Her iki
sözlük API'nin ürettiği değerlerin TAMAMINA karşı yeniden denetlendi; kalan sözlükler
(audit_action, güvenlik olayı tipleri) tam çıktı.

**Ürün detayındaki stok hareketleri listesi kararsızdı.** Toplu "geçersiz kıl/hasarlı" akışı
kalem başına bir satır yazar ve hepsi tek transaction'a düşer → damgalar aynı olur; tie-break
olmadığı için 50'lik pencereye o bloktan hangi satırların gireceği keyfiydi ve liste her
yenilemede değişebiliyordu (`created_at DESC, id DESC`).

**Rota duman testi iki sayfayı hiç taramıyordu.** `sites/new` (site bağlama sihirbazı) ve
`templates/new` listede yoktu — ikisi de sunucu action'ı olan, yani `next build` temiz geçerken
çalışma anında kırılabilen sayfalar; betiğin tüm değeri kapsamında olduğu için eklendi
(kapsamı elle doğrulamanın komutu da betiğe yazıldı).

Yeni regresyon testi `order-timeline-order.test.ts` **mutasyonla kanıtlandı**: düzeltme geri
alındığında kırmızıya döner. (İlk sürümü dönmüyordu — tie-break olmadan da Postgres küçük
tabloda satırları pratikte ekleme sırasında döndürdüğü için test hiçbir şeyi korumuyordu;
`seq` fiziksel sıranın tersine yazılarak ayırt edici hâle getirildi.)

Bir önceki denetimin "bilinçli olarak bırakıldı" diye raporlanan kalemleri tamamlandı.

**Hesap ürünlerinde eksik olan araç eklendi.** Sağlayıcı bir hesabın parolasını değiştirdiğinde
panelde doğru bir işlem yoktu: kalem düzenleme teslim edilmiş kaydı (haklı olarak) reddediyor,
"Değiştir" ise müşteriye **başka bir hesap** veriyordu — eski hesap müşterinin elinde çalışmaya
devam ediyor ve müşterinin o hesapta biriktirdiği veri kayboluyordu. Yani anahtar ürününde doğru
olan çözüm hesap ürününde yanlıştı. Yeni akış aynı kalemi ve aynı atamayı koruyup yalnız kimlik
bilgilerini yeniler: owner yetkisi ister, sebep zorunludur, maskeli değer reddedilir, siparişin
zaman çizelgesine görünür bir iz düşer. Müşteri yeni bilgileri otomatik görmez — panel bunu
açıkça söyler ve teslimat mailini yeniden göndermeye yönlendirir.

**Çok kullanımlı (MAK) lisansta çıkmaz sokak kapandı.** Üç değişim yolu da MAK'ı reddediyordu ve
**red doğruydu** (geri alınan kapasite aynı paylaşımlı anahtara döner, yeni atama yine o kusurlu
anahtarı seçerdi). Eksik olan, operatöre yapabileceğini söylemekti: sipariş detayı ve destek
ekranı düğmeyi hiçbir uyarı olmadan sunuyor, tıklayınca hata veriyordu. Artık iki ekranda da
sebebiyle kapalı ve gerçek reçete yazılı (mağaza ekranından "+1 Bonus", kusurlu anahtarı Kusurlu
Stok akışıyla tedarikçiye bildirme). "İptal" onayındaki yanıltıcı *"kusurlu key"* örneği de
kaldırıldı — o uç iade semantiğinde çalışır ve müşterinin hakkını yakar.

**Tükenmiş kapasite artık görünüyor.** Kapasitesi biten MAK anahtarları hiçbir stok ekranında
listelenemiyordu: ürün detayında kova yoktu, envanter süzgecinde seçenek yoktu ve "süresi geçmiş"
alanı hiçbir kod yolu onu yazmadığı için **daima sıfır** gösteriyordu. Üçü de düzeltildi; MAK'ta
kovaların toplanamayacağı (kısmen satılmış anahtar hem stokta hem müşterilerde sayılır) ekranda
ve kodda ayrıca not edildi.

**Maliyet raporu dönemlendi.** Rapor her açılışta `assignments` ve `stock_adjustments`
zincirlerini penceresiz tarıyordu. Artık `?from&to` alıyor, varsayılanı son 12 ay ve uygulanan
dönem ekranda yazılı (sessiz kırpma yok, tek tıkla "tüm zamanlar"). Stok değerlemesi bilerek
pencerelenmedi — o bir dönem akışı değil anlık pozisyondur, daraltmak "stok değerimiz düştü"
yalanı üretirdi. **migration 0043** üç indeks ekler (teslim tarihi · zayi tarihi · harcama tarihi
ifadesi).

**Hesap ürününde anahtar araması yalan söylüyordu.** "Son 5 hane" araması hesap kayıtlarında
kanonik JSON'un kuyruğunu hash'liyordu, yani operatörün aradığı parola/kullanıcı adı sonu **asla**
eşleşmiyordu; üstelik kuyruğun iki karakteri sabit olduğu için etkin entropi de düşüyordu. Hesap
kayıtlarında bu hash artık yazılmıyor ve arama ipucu gerçeği söylüyor.

**Eklenti 1.0.7:** sipariş ekranındaki lisans özeti çok kullanımlı anahtarda kalem sayıyordu — üç
aktivasyonluk tek anahtar "1 lisans" görünüyor, operatör eksik teslimat sanıp bedava bonus
verebiliyordu. Artık birim de yazıyor ve anahtarın genel kullanım sayacı ("bu siparişin değil,
anahtarın tümü") açıkça etiketli.

**İşletim:** `backup-runner.sh` deposunda **çalıştırılabilir değildi** (dosya izni), oysa runbook
onu doğrudan crontab'a koymayı söylüyor — operatör runbook'u harfiyen uygulasa bile yedek cron'u
sessizce hiç koşmayacaktı. İzin düzeltildi, sunucuda gecelik yedek + aylık tatbikat cron'ları
kuruldu ve ilk yedek alınıp panelde göründüğü doğrulandı. **Dış kopya (offsite) kancası hâlâ
kurulmadı** — hedef/kimlik bilgisi operatöre aittir.

### Panel + eklenti tam denetimi ve gerçek mağaza senaryosu testi (migration 0042, eklenti 1.0.6)

Panel ve WP eklentisi beş bağımsız lensle (WP eklentisi · güvenlik · performans · ürün tipi
doğruluğu · test kapsamı) tarandı; her bulgu çürütme denemesinden geçirildi. Ardından gerçek bir
WooCommerce mağazasında uçtan uca satış senaryosu koşuldu: **varyasyonlu ürün** (Retail/MAK),
**çok kullanımlı MAK anahtarı**, **Office 365 hesabı** (kullanıcı adı + gizli parola + kurtarma
adresi + 1 yıl geçerlilik) — tek siparişte karışık olarak, kısmi teslimat, kısmi iade, otomatik
tamamlama ve değişim talebi dahil.

**En ciddi bulgu yük testinde ortaya çıktı — kod okunarak görülemezdi.**

- **Bağlantı havuzu kilitlenmesi (kullanılabilirlik).** `createOrder` transaction'ı içinden ürün
  eşlemesi ve ürün kaydı **kök havuzdan** okunuyordu. Transaction zaten bir bağlantı rezerve
  ettiği için bu ikinci bir bağlantı istiyordu; havuz 10 bağlantılık olduğundan **10 eşzamanlı
  sipariş** tüm bağlantıları "idle in transaction" durumunda kilitliyor, hiçbiri serbest kalmıyor
  ve ancak 60 saniyelik Postgres zaman aşımı hepsini öldürünce çözülüyordu. O süre boyunca
  `/v1/health` bile `db:false` dönüyordu — yani sipariş trafiği **tüm paneli** deviriyordu.
  Ölçüldü: 100 eşzamanlı kullanıcı → **0 tamamlanan sipariş**, Postgres logunda 60 saniyede bir
  havuzun tamamının `FATAL` düşmesi. Düzeltmeden sonra aynı test: **7.171 istek, 354 istek/sn,
  sıfır hata, 14.334 doğrulamanın tamamı geçti**, 50 stoktan tam 50 sipariş karşılandı (çifte
  satış = 0), havuz ölümü **0**.

**Güvenlik**

- **Yetki yükselmesi:** "bağlan kodu" ucu owner kontrolü taşımıyordu. Owner olmayan bir yönetici
  herhangi bir mağazanın kimlik bilgilerini yeniletip alabiliyor, o kimlikle mağaza uçlarını
  imzalayarak **düz metin lisans/parola** okuyabiliyordu — "düz metin yalnız owner" kararı
  tamamen atlanıyordu. Aynı gücü veren `rotate-secret` zaten owner-only'ydi; asimetri kapandı.
- **Geriye dönük düz metin ifşası:** hesap alanları çözülemediğinde üretilen yedek görünüm alanı
  "gizli değil" işaretliyordu. Bir anahtar ürünü hesap tipine çevrildiğinde o ürünün **tüm**
  anahtarları maskesiz görünüyordu. Yedek görünüm artık gizli sayılıyor (güvenli yön).
- **Sessiz lisans imhası:** owner olmayan yönetici maskeli görünen bir hesap kaydını düzenlerse
  maske metni (`••••••`) gerçek parola olarak şifreleniyordu. Sunucu artık maskeli değeri reddediyor.
- **Ürün şeması koruması:** stokta canlı kalem varken alan silme/yeniden adlandırma, "gizli"
  bayrağını düşürme ve ürün tipi değişimi 409 ile reddediliyor (sessiz veri kaybı, geriye dönük
  parola ifşası ve mükerrer denetiminin kaçması bu üç değişimden doğuyordu).
- Dağıtım kuyruğunu tüketen uçlar, şablon test maili (hız sınırı) ve giriş/çıkış `Origin` kapısı
  sıkılaştırıldı; prod imajı geliştirme bağımlılıklarından arındırıldı (626 → 145 paket);
  Dockerfile'ların lockfile sabitlemesini sessizce iptal eden yedeği kaldırıldı; parola
  türetme maliyeti 2026 önerisine çıkarıldı (eski parolalar çalışmaya devam eder, girişte
  sessizce yenilenir).

**Performans**

- **Çok kullanımlı (MAK) atama** birim başına ayrı bir veritabanı turu yapıyordu: 200 adetlik bir
  satır = 200 ardışık `UPDATE`, hepsi tek transaction içinde kilitler tutulurken. Artık anahtar
  başına toplu alınıyor. Ölçüldü: süre artık **adetle ölçeklenmiyor** (50 adet 30 ms, 200 adet 34 ms).
- **migration 0042** — yedi sıcak yol indeksi: atama sorgusunun tam karşılığı (sıralama anahtarları
  indekste değildi, aday satır başına heap erişimi yapılıyordu), "Bekleyen Teslimatlar" (sipariş
  durumu üzerinde hiç indeks yoktu), kusurlu stok sıralaması (ifade indeksi), tamamlama motorunun
  FIFO taraması, indekssiz iki yabancı anahtar ve müşteri e-postası araması. Yenilerinin kapsadığı
  iki gereksiz indeks düşürüldü.
- Geri-kanal webhook işçisi tek iş yerine beşe çıkarıldı (erişilemeyen tek mağaza tüm kuyruğu
  baş-blokluyordu); envanter sayımı tavanlandı (her sayfa görüntülemesinde tüm tabloyu sayıyordu);
  bildirim/dağıtım/bağlan-kodu tabloları için budama eklendi.

**Müşteri deneyimi (eklenti 1.0.6)**

- Çok ürünlü siparişte müşteri sayfası **düz bir liste** basıyordu: hangi anahtarın hangi ürüne ait
  olduğu görünmüyor, çok kullanımlı anahtarın kaç aktivasyon taşıdığı hiçbir yerde yazmıyordu
  (9 aktivasyon satın alan müşteri 2 çıplak anahtar görüyordu). Aynı siparişin **e-postası bunu
  doğru yapıyordu** — üç yüzeyden biri geride kalmıştı. Sayfa ve `.txt` indirmesi artık ürün adına
  göre gruplu ve kullanım hakkını yazıyor.
- Hesap alanları çözülemediğinde teslim edilmiş sipariş müşteriye kalıcı olarak "Teslimat
  hazırlanıyor" diyordu (ilerleme çubuğu ise "3/3 teslim edildi"). Artık düz değere düşülüyor.
- Panele iletilemeyen istekler **sonsuza dek** 5 dakikada bir tekrar deneniyor ve her denemede
  siparişe not yazıyordu (yanlış imza durumunda günde ~288 not/iş). Artık 1dk/5dk/30dk, en fazla
  3 deneme; 401/403'te hiç denenmiyor (yapılandırma hatasıdır) ve tek kalıcı uyarı yazılıyor.

**Doğruluk**

- Teslimat e-postası iptal edilmiş satır filtresini uygulamıyordu (okuma yolu yazma yolundan iyi
  korunuyordu); mağaza panelindeki "Göster" süresi dolmuş lisansı açabiliyordu; "süreniz doldu"
  bildirimi süpürme işi koşar koşmaz kayboluyordu; hesap payload'ı maskelenirken parolanın son
  karakterleri sızıyordu; garanti penceresi lisansın kendi süresini hesaba katmıyordu (süresi
  dolmuş lisans "garanti içi" görünüp bedava yenileniyordu); stok girişi ile kalem düzenleme
  farklı normalizasyon uyguluyordu (baştaki/sondaki boşluk mükerrer denetimini kaçırıyor, aynı
  anahtar ikinci kez stoğa girebiliyordu).

**Test kapsamı** — denetim, çok kullanımlı ürünün **satış** yolunun ve **karışık tipli siparişin**
hiç test edilmediğini ortaya çıkardı (MAK yalnız iade/red yollarında testliydi). 26 yeni entegrasyon
testi eklendi: MAK satışı (kapasite aşımı invaryantı dahil), MAK eşzamanlılığı, karışık tipli tek
sipariş, süre türetimi, hesap iadesi semantiği, şema değişimi koruması, süre görünürlüğü.
Toplam entegrasyon **383/383**, birim 142/142, yarış 3/3.

### Proje geneli 6-lensli denetim: 40 doğrulanmış bulgu (migration 0041)

Altı lens (auth/2FA · veri ifşası/RBAC · sipariş invaryantları · rapor/DB · arayüz · ops/betik/WP)
çekişmeli-doğrulamalı ajanlarla tarandı — her bulgu **çürütme** denemesinden geçti — sonra beş
paralel işçi ayrık dosya kümeleriyle düzeltti.

**En değerli iki bulgu CANLI SİSTEMDEN geldi, statik analizden değil:**

- **Dört süpürme işi üretimde iki kez koşuyordu.** Redis'te `expiry`/`low-stock`/`reconcile`/
  `daily-digest` (+`security`) kuyruklarının **ikişer** aktif zamanlayıcısı vardı: biri kararlı
  kimlikli yenisi, diğeri eski `queue.add(repeat)` çağrısından kalan hash anahtarlı yetim. Redis
  dağıtımlar arasında kalıcı olduğu için kod düzeltildiğinde eski kayıtlar silinmemişti — "yetim
  schedule kalmaz" güvencesi yalnız *ileriki* değişiklikler için doğruydu. Kanıt: `digest_alert`
  günde tam iki satır, damgalar `08:00:00.121` ve `08:00:00.132`. Telegram açık olsaydı operatör
  her sabah aynı kritik alarmı iki kez alırdı.
- **`ADMIN_TOKEN` her admin isteğinde düz metin loglanıyordu** (prod logunda son bir saatte 30
  satır). Bu token `AdminGuard`'ın tek kapısı ve rol başlığı gönderilmediğinde `OwnerGuard`'ı da
  geçiyor → log okuma yetkisi tam panel kontrolüne yükseliyordu.

**Düzeltildi — çekirdek para yolu**
- `syncRefunds` iptal defterini uzlaştırmıyordu: aynı iptal iki kez sayılıyor, doldurma hedefi
  teslim edilenin altına düşüyor ve **değişim yolu kalıcı kilitleniyordu** (stok varken "stok yok").
- Admin manuel iptali MAK kapasitesini havuza geri veriyordu — aktivasyon sağlayıcı tarafında
  harcanmışken kalem yeniden satılabilir hale geliyordu (sessiz aşırı-satış).
- `rejectHeld` kaçak atamaları ham UPDATE ile kapatıyordu: tek-kullanımlık kalem kalıcı
  `assigned` limbosunda kalıyor ve mutabakat kalıcı kritik alarm üretiyordu.
- Satır durumu üç yerde ham `qty` ile hesaplanıyordu → satır kalıcı `partial`, mağazada "eksik
  teslimat", bekleyenler kuyruğunda hayalet iş.
- Geri çekilen partideki çok-kullanımlı anahtar, kapasite iadesiyle satış havuzuna dönebiliyordu.
- Toplu geçersiz kılma, canlı müşteri ataması olan kalemi void'liyordu (tekil yol 409 verirken).

**Düzeltildi — raporlar ve veritabanı**
- "Kaç birim eksik" yükleminin iki tanımı vardı → stok girişi onay modali, bekleyen kuyruğu ve
  "neden bekliyor" tanısı yanlış sayı gösteriyordu; tek paylaşılan fragmana bağlandı.
- Teslim edilen mal maliyeti yalnız `active` sayıyordu; aynı ekrandaki satış hızı
  `active+suspended+expired` sayıyordu → `STANDING_STATUSES` tek kaynağa taşındı.
- Yeniden-sipariş raporunun satışsız-ürün sayacı ürün başına alt-plan koşuyordu (tek geçişe indi).
- `/purchase-orders` listesi sınırsız ve indekssiz sıralamaydı → tavan + `truncated` + **0041**
  (`purchase_orders_created_idx`).

**Düzeltildi — güvenlik ve gizlilik**
- Owner olmayan yönetici **iki faktörlü girişi hiç açamıyordu** (aktör başlığı yazma yolunda
  gönderilmiyordu); tek noktadan düzeltildi, yan fayda: tüm yazma yollarında denetim izi gerçek
  yöneticiye bağlanıyor.
- Kendi 2FA'sını kapatmada parola + kod artık rolden bağımsız isteniyor (panel formu ikisini de
  zorunlu topluyordu ama API owner için yok sayıyordu); uca hız sınırı eklendi.
- `rotate-secret` ucuna `OwnerGuard`; `totp_secret_enc` readonly-sql sır listesine.
- Tedarikçi fişinde düz metin dönmeden `reveal` audit'i yazılabiliyordu.
- KVKK anonimleştirme kayıtlı görünüm sorgularını atlıyordu (`URLSearchParams` `@` işaretini
  `%40` kodladığı için mevcut e-posta deseni kaçırıyordu).
- Sentry açılırsa istek URL'i ve başlıkları olaya iliştirilebiliyordu → `beforeSend` ile sanitize.

**Düzeltildi — yedekleme ve işletim**
- Yedek yolu hiçbir alarm kanalına bağlı değildi: cron kurulmamışsa aylarca sessiz kalırdı →
  `backup_stale` (kritik) / `drill_stale` (uyarı) bildirimleri.
- 30 dakikalık zombi eşiği 2 saatlik kurtarma hedefiyle çelişiyordu: uzun bir tatbikat "başarısız"
  sayılıp tek-aktif kilidini açıyor, dağıtım tatbikat sürerken koşuyordu → hedefe göre eşik +
  `finish` yalnız çalışan işi günceller.
- Rotasyon, başarısız/doğrulanamamış yedekten sonra da eski dump'ı siliyordu.
- `SITE_SILENCE_HOURS` compose'tan geçmiyordu → `.env`'e yazmak sessizce etkisizdi.
- Sürekli sweep'lerden biri (güvenlik taraması) alarmsızdı.
- CI'a kabuk doğrulaması eklendi; **ilk koşuda `wp-dev.sh`'ta dengesiz tırnak buldu — yerel WP
  geliştirme komutu fiilen çalışmıyordu.**

**Düzeltildi — arayüz**
- Kayıtlı görünüm tablo içi süzgeçleri sessizce kaybediyordu (uyarı yalnız adres tamamen boşken
  çıkıyordu) → `/stock` ve `/customers` süzgeçleri adrese yazıyor, diğer iki ekran görünür uyarı
  veriyor.
- Rehberdeki iki yanlış vaat düzeltildi: "gecelik yedek otomatiktir" (gerçekte elle kurulan bir
  zamanlanmış görev) ve "filtreler adrese yansır" (beş ekranın dördünde yansımıyordu).
- 2FA kurtarma yolu tarayıcı doğrulamasıyla kilitliydi; `/admins/security` breadcrumb'ı
  `/security` ekranıyla çakışıyordu; boş tabloda "kayıt yok" ile "süzgeçle eşleşen yok" ayrıldı.


### Sekiz öneri maddesi (B1–B8): denetim izi · iki rapor · 2FA · yedek · görünümler (migration 0040)

Önceki turda "eklenebilir" diye önerilen sekiz maddenin tamamı uygulandı. Altı paralel işçi
ayrık dosya kümeleriyle çalıştı; şema değişiklikleri (üç madde şema istiyordu) **tek elde**
toplandı — üç işçi eşzamanlı migration üretse drizzle journal dosyasında çakışırdı.

**Eklendi**
- **Denetim izi ekranı `/audit`.** `audit_log` doluydu ama listeleyen bir uç YOKTU: "bu anahtarı
  kim gösterdi", "bu siparişi kim iptal etti" ancak veritabanına elle bağlanarak yanıtlanıyordu.
  Salt-okunur (yazma ucu bilerek yok — denetim izinin değeri değiştirilemez olmasından gelir),
  aktör/hedef/eylem/tarih/iz-kimliği süzgeçleri, `meta` redaksiyon kalkanı, `LIMIT CAP+1` ile
  sınırlı sayım (aşımda `totalCapped` — sessiz yanlış toplam yok).
- **`/reports/sla` — teslimat süresi.** "Anında" ↔ "bekledi" ayrımı uydurma bir eşik DEĞİL:
  sipariş ve atamaları tek transaction'da yazıldığı için anında teslimde fark tam `0`.
  Ortalamanın yanında **p50/p95** (birkaç uzun bekleme ortalamada kaybolur), incelemedeki
  siparişler / iptal satırlar / bonus kalemler / değişimle verilen taze anahtarlar hariç ve
  **kaç tanesinin elendiği yanıtta yazılı**; tamamlanmamış siparişler `stillOpen` ile ayrı.
- **`/reports/reorder` — yeniden sipariş önerisi.** Hız + o ürünün tedarikçisinin GERÇEKLEŞEN
  tedarik süresi; formül ekranda açıkça yazılı. Tedarik süresi bilinmiyorsa **öneri üretilmez**
  (varsayılan uydurulmaz), yalnız tükenme tahmini gösterilir.
- **İki faktörlü giriş (TOTP).** RFC 6238 elle yazıldı — **sıfır yeni bağımlılık**. Sır
  AES-256-GCM envelope + `admin_user:<id>` AAD ile şifreli; tekrar-oynatma defteri Redis
  (`SET NX`, fail-closed); lockout parola denemeleriyle AYNI kovada; oturum çerezi YALNIZ
  ikinci adımdan sonra (arada 5 dk'lık, ayrı anahtarla imzalanmış beklet-token'ı); owner
  sıfırlaması açık oturumları da düşürür. Varsayılan KAPALI, hesap bazında açılır.
- **Panelden yedek + geri-yükleme tatbikatı.** Dağıtımla aynı kuyruk (tek aktif iş garantisi),
  ayrı runner + hedef filtresi; `/deployments`'ta yaş / boyut / **dış kopya** durumu ve
  bayatlık bantları. Panel konteynerine Docker soketi verilmez — istek/çalıştırma ayrımı korundu.
- **Kayıtlı görünümler + lisans envanteri dışa aktarma.** Görünümler artık `/orders`, `/stock`,
  `/customers`, `/mappings`, `/quarantine/records` ekranlarında. Dışa aktarma ayrı sunucu ucu;
  düz metin **yalnız owner** ve tek `reveal` audit kaydı, owner-olmayan maskeli dosya alır.
- **Mağaza sessizlik alarmı** (`sites.last_seen_at`) — geçmişte bir kesinti tam da bu sinyal
  olmadığı için günlerce fark edilmemişti. Damga imza doğrulandıktan SONRA yazılır.

**Değişti**
- `DataTable` opt-in **`syncUrl`**: arama/facet/sıralama adres çubuğuna yazılır
  (`tq` / `tf.<kolon>` / `tsort`). Sayfanın kendi parametreleri korunur; facet listesinde
  olmayan bir `tf.*` tabloya filtre enjekte edemez. `/orders`'ta kayıtlı görünüm menüsü
  bağlıydı ama süzgeçler istemci state'inde durduğu için **BOŞ görünüm kaydediyordu**.
- Güvenlik olayı etiketleri tek kaynağa (`labels.ts`) toplandı; ekrana özel yerel sözlük
  kaldırıldı. Breadcrumb: `sla` / `reorder` / `costs`.

**Düzeltildi**
- **`/audit` tarih aralığı süzgeci her zaman 500 veriyordu**: ham `sql` fragmanına `Date`
  nesnesi konmuştu, postgres.js bind aşamasında `ERR_INVALID_ARG_TYPE` atıyor. Projenin
  mevcut deseni (ISO dize + açık `::timestamptz`) uygulandı. **Entegrasyon paketi yakaladı —
  typecheck ve build temiz geçiyordu.**
- TOTP entegrasyon testleri kurulum onayı ile girişte aynı 30 sn'lik adımı kullanıyordu;
  tekrar-oynatma defteri bu ikisi arasında ORTAK (RFC 6238 §5.2, kasıtlı) → "geçerli kod
  reddedildi" gibi görünen üç başarısızlık. Test düzeltildi, davranış açıkça kilitlendi.
- Rehber: yeni beş ekran eklendi; "kayıtlı görünüm yalnız Siparişler'de" iddiası ve
  "filtreler adres çubuğuna yansır" vaadi artık gerçeğe uyuyor.

### 5-lensli proje denetimi: 31 doğrulanmış bulgu + 3 sessiz regresyon (migration YOK)

Kullanıcı isteğiyle proje beş lensten (regresyon · güvenlik · performans/DB · UI-UX/a11y ·
test kapsamı) çekişmeli-doğrulamalı bir workflow ile denetlendi; her bulgu **çürütme**
denemesinden geçirildi. Düzeltmeler altı paralel işçiye ayrık dosya kümeleriyle dağıtıldı.

**Güvenlik**
- **[YÜKSEK] keyFormat ReDoS.** Ürünün "anahtar biçimi" alanı sınırsız serbest metindi ve stok
  girişinde 10.000 payload'a karşı senkron çalıştırılıyordu; Node'da regex zaman aşımı yoktur →
  `^(a+)+$` gibi tek bir desen sipariş teslimatı dahil **tüm API'yi** üstel süre dondururdu.
  Üç katmanlı kapı: kayıt anında uzunluk + derleme + katastrofik kalıp sezgisi (create ve update),
  kullanım anında aynı kapı (denetimden önce kaydedilmiş desenler için), payload uzunluk tavanı.
  Yeni bağımlılık eklenmedi; sezgi 25 vakayla sınandı.
- `/ops` sunucu aksiyonu yol parçalarını doğrulamadan API yoluna gömüyordu (server action'lar TS
  tiplerini çalışma anında zorlamaz) → beyaz liste + UUID + `encodeURIComponent`.
- Müşteri kaynaklı `reason` üst sınırsızdı; `?siteId=` doğrulanmıyordu (22P02 → 500).

**Bağımlılıklar** — `pnpm audit --prod` 11 açık (9 high + 2 moderate) → **0**. drizzle-orm
0.38→0.45, nodemailer 8→9, geçişli overrides (postcss/nanoid/fast-uri/find-my-way/sharp).

**Yükseltmenin ortaya çıkardığı sessiz regresyonlar** (hepsi test tarafından yakalandı)
- drizzle 0.45 sürücü hatalarını `DrizzleQueryError` içine sarıyor → `e.code === '23505'` ve
  `String(e).includes('unique')` desenleri devre dışı kaldı; **409 dönmesi gereken beş yol ham 500**
  dönüyordu (kategori ikizi, admin e-posta, eşleme). Yeni `db/pg-error.ts` tek kaynak + 8 birim testi.
- `clampPageSize` varsayılanı sabit listesinin İLK elemanıydı; listeye 10 eklenince "pageSize
  göndermeyen" her çağrı sessizce 25 → 10 satıra düştü → `DEFAULT_LICENSE_PAGE_SIZE` açıkça yazıldı.
- Test dosyaları hiçbir tip denetiminden geçmiyordu (derleme config'i `*.test.ts`'i dışlıyor, vitest
  tip kontrol etmiyor) → 5 dosyada bayat imza. `tsconfig.tests.json` eklendi, `typecheck` ona bağlandı.

**Doğruluk / kullanım**
- Müşteriye giden teslimat maili sipariş detayında **"Tedarikçiye gönderildi"** yazıyordu.
- Ürün detayındaki "Düzenle" kategori listesini almıyordu → ürünü kategoriye taşımak imkânsızdı.
- Stok girişinde büyük harfli İngilizce başlıklar (`EMAIL`, `LOGIN`, `PIN`, `ID`) başlık sayılmıyor,
  **veri satırı olarak içe aktarılıyordu** (tr-TR katlamasında ASCII `I` → `ı`).
- `includesTr` matrisinin 5 hücresi eşleşmiyordu ("isik" → "IŞIK" bulunamıyordu) → üçüncü katlama
  geçişi (İ/I/ı/i → i), veritabanındaki kategori ikiz kuralıyla aynı dil.
- Toplu geçersiz kılma **başarısız olduğunda yeşil ✓** kutusunda gösteriliyor ve seçim temizleniyordu.
- Çok sayfalı seçim sessizce kayboluyordu → sıfırlama artık bilinçli ve **yazılı**.

**Performans**
- Envanter aramasında hash eşitliği (UNIQUE index) ILIKE'lar ve korele EXISTS ile aynı OR'daydı →
  tam anahtar aramasında bile tam tablo taraması + satır başına 3-join alt-plan. Aday kümesi
  UNION ALL'a ayrıldı, **davranış birebir korunarak**.
- `/stock` giriş ekranı hiç render edilmeyen ürün agregasyonunu her açılışta çekiyordu.
- `/customers` site özeti önbeleksiz tam tablo taramasıydı (60 sn TTL + tek-uçuş eklendi).

**Erişilebilirlik** — CollapsiblePanel açılınca klavye odağı `<body>`'ye düşüyordu; Kusurlu Stok
araması `includesTr`'yi atlıyordu; dar ekran kart görünümünde boş-durum çizilmiyordu.

**Test kapsamı** — 5 yeni entegrasyon dosyası (kategoriler · envanter araması · lisans mutasyonları ·
müşteri site özeti · süre/holder süzgeçleri); `apps/admin`'de **test koşucusu yoktu** → vitest + 74
test; `fill-target` ve `pg-error` birim testleri. quota.guard testi hiçbir rotaya bağlı olmayan bir
guard'ı doğruluyordu (yanlış güvence) → dürüstleştirildi. `smoke-routes.sh` `/categories`'i taramıyordu.

**Migration 0038 sertleştirmesi** — yalnız DROP+CREATE UNIQUE idi: 0037 uygulanmış ve arada Türkçe
ikiz kategori oluşmuş bir veritabanında CREATE patlar ve migration boot'ta koştuğu için **API hiç
açılmazdı**. Ön temizlik eklendi (ikizler deterministik yeniden adlandırılır, ürün silinmez); gerçek
Postgres'te kirli veriyle doğrulandı, ikinci koşu idempotent. Uygulanmış veritabanları etkilenmez.

**Doğrulama:** typecheck 4/4 (artık test dosyaları dahil) · check-use-server 23/77 · admin 74/74 ·
api birim 94/94 · VPS izole test DB: **entegrasyon 240/240 + yarış 3/3** · build 3/3 · `pnpm audit --prod` temiz.

### Ürün kategorileri: kart tabanlı Stok & Ürünler + Kategoriler ekranı (migration 0037, 0038)

Kullanıcı: *"panel ürünleri direkt görünüyor; office/windows/yapay zekâ lisansları, oyun
hesapları gibi ayrıştırabilsek; kart tarzı daha kullanışlı; ayrıca rehber niteliğinde
açıklamalar iyi olur"*. Kategoriler **ayrı ekrandan** yönetilir (kullanıcı kararı) — ürün
formunda serbest metin yoktur, yalnız listeden seçilir.

- **0037:** `product_categories` (ad/açıklama/sıra) + `products.category_id`
  (**ON DELETE SET NULL** → kategori silinince ürün silinmez, "Kategorisiz" olur).
- **0038:** ad benzersizliği **Türkçe-duyarlı** — dev'de ölçüldü: `lower()` tek başına
  `"WINDOWS LİSANSLARI"` ile `"windows lisansları"`yı FARKLI sayıyor ve ikizi kabul ediyordu;
  index artık `lower(translate(name,'İIı','iii'))`.
- **`/stock` üç hâlli** (müşteriler ekranıyla aynı gezinme dili): kategori kartları ·
  `?q=` tüm ürünlerde arama · `?category=` kategori listesi. Kart: ürün sayısı + atanabilir
  kapasite + düşük stok uyarısı.
- **Yeni `/categories`** ekranı: ekle / yeniden adlandır / açıklama / sıra / sil. Silme
  onayında kaç ürünün "Kategorisiz" olacağı yazılı.
- **Rehber şeritler**: `/stock` ve `/categories` üstünde 3 adımlı akış (panel ürünü → stok
  girişi → mağaza eşlemesi).
- Ürünün mevcut kategorisi seçenek listesinde yoksa form onu yine de basar — aksi halde
  "Kaydet" ürünü sessizce kategorisinden çıkarırdı.

### Müşteriler: mağaza → müşteri hiyerarşisi (migration YOK)

Kullanıcı: *"direkt müşteriler çıkıyor; sitelere bölünmeli, sitenin içine girip müşterileri
görmek daha sağlıklı — genel arama yine yapılabilsin"*. Ekran artık üç hâlli, hepsi
paylaşılabilir URL:

- `/customers` → **mağaza kartları** (müşteri / sipariş / son sipariş sayaçları). Siparişi
  olmayan mağaza da listede kalır (LEFT JOIN) — sıfır, yokluk değil bilgidir.
- `/customers?q=<terim>` → **sunucu-taraflı arama**, hiyerarşiyi atlar (tüm mağazalar).
  Arama site süzgecini bilinçli ezer: mağaza içindeyken sonuç o mağazayla sınırlı kalsaydı
  "müşteri yok" yanılgısı doğardı.
- `/customers?site=<id>` → o mağazanın müşterileri (mevcut davranış korundu).

Yeni uç `GET /v1/admin/customers/site-summary` (rota `:email`ten ÖNCE tanımlandı — Nest sıraya
göre eşler). Müşteri kaydı hâlâ e-posta bazlı **global**dir (etiket/not tek kayıt); hiyerarşi
yalnız sunum katmanındadır. API eski sürümdeyse ekran hata vermez, eski düz listeye döner.

### Rozet dili: canlı yüzey + okunur metin (migration YOK)

Kullanıcı: *"tüm badge'lerin renkleri ve tasarımları daha canlı olmalı"* (referans:
shadcnspace badge sayfası + dashboard). Referans tarayıcıda ÖLÇÜLDÜ: rozeti tek renkten
kuruyor (`bg-teal-500/10 text-teal-500`) — metin kontrastı **2.21** (teal) / **3.30**
(kırmızı), yani WCAG AA'nın altında. Bu yüzden kopyalanmadı; canlılık **yüzeye** taşındı.

- **İki katmanlı renk:** `--<hue>` metin/ikon için kalır (AA zorunlu), yeni `--<hue>-vivid`
  yalnız dolgu/halka üretir (kontrast kısıtı yok → çok daha doygun). Rozet dolgusunun
  doygunluğu **1,5–2,3 kat** arttı (oklch C: 0.020→0.039 yeşil, 0.019→0.044 mor).
- **Kontrast ÖLÇÜLDÜ** (tarayıcıda, gerçek dolgu üzerinde): açık tema 4.64–5.34,
  koyu tema 5.35–7.27 — hepsi AA üstü.
- **sRGB dışı 4 renk düzeltildi:** eski `success`/`warning`/`destructive` değerleri gamut
  dışındaydı, tarayıcı kırpıyordu — yani ekrandaki renk yazılan renk değildi.
- **Tek kaynak `--<hue>-fill` / `--<hue>-ring`:** aynı "soluk tint" dili panelde %12/13/14/16
  olmak üzere dört ayrı oranda kopyalanmıştı (rozet, StatTile, uyarı kutusu, satır zeminleri);
  oran artık temaya göre tek yerde tanımlanır.
- **Geometri referanstan ölçüldü:** sabit **20px** yükseklik (eskiden içeriğe göre 20-22px
  oynuyordu), `px-2` · `gap-1` · 12px/**600** · `whitespace-nowrap`.

### Genel Bakış: yeni sipariş artık gözden kaçmıyor (migration YOK)

Kullanıcı geri bildirimi: *"anlık sipariş düşüyor ama yeni sipariş olup olmadığı ekranda pek
ayırt edilemiyor"*. Koddan ölçülen kök neden: yeni kayıt vurgusu **12 sn sonra siliniyordu**
(`live-provider`), vurgunun tamamı 2px sol şerit + soluk zemindi, "Yeni" kelimesi yalnız ekran
okuyucuya gidiyordu ve **sekme arkadayken poll tamamen duruyordu** → başka sekmedeyken gelen
sipariş hiçbir yerde görünmüyordu.

- **Kalıcı "yeni" işareti:** sönen `fresh` kümesinin yanına sönmeyen `unseen` kümesi eklendi —
  satıra tıklanana ya da "Okundu" denene kadar durur. Listeden kayan kayıt her turda budanır
  (sayaç listeyle çelişmez). Satırda görünür `YENİ` rozeti + kart başlığında "N yeni" +
  okunmuş/okunmamış sınır çizgisi (yalnız yeni kayıtlar listenin başında kesintisizse çizilir).
- **Sekme başlığı sayacı** `(3) Lisans Paneli…` ve **tıklanabilir toast** (tek kayıt → doğrudan
  siparişe, çok kayıt → tek özet toast). Kabukta tek mount → her ekranda çalışır.
- **Arka plan poll'u durmak yerine seyreliyor:** 15 sn → **60 sn** koşullu (ETag) istek.
- **Sıcak sipariş ayrımı:** akış kartında "Tümü / İşlem bekleyen" filtresi (`held` + eşlemesiz +
  `pending`/`partial`) ve bekleyen satırda 5 dakikayı geçen sürenin uyarı tonuna dönmesi.
- **Giriş animasyonu:** yeni satır tek atımlık kayarak girer (`prefers-reduced-motion`'da kapalı)
  → "yeni geldi" ile "yeniden sıralandı" ayrışır.

### Admin arayüzü: uyum denetimi — 43 doğrulanmış bulgu düzeltildi (migration YOK)

1.1.0 ile gelen tema uyarlaması, kullanıcı geri bildirimi üzerine ("referanslardan çok alakasız,
UI/UX sorunları var; masaüstü ve mobil detaylıca") **gerçek ekranlar üzerinde ölçülerek** denetlendi.

#### Önce: iki kendi hatam

- **Referansı hiç GÖRMEMİŞTİM.** Tarayıcı paneli kare üretmediği için 1.1.0'da yalnız token
  seviyesinde (font/yarıçap/gölge) uyarlama yapılmış, sayfa kompozisyonu karşılaştırılmamıştı.
  Bu turda ekran görüntüsü alındı. Oluşan "referansın kenar menüsü koyu" izlenimi ise
  görüntünün içine **kalibrasyon şeridi** (siyah / orta gri / beyaz) basılarak **çürütüldü**:
  beyaz bant menü zeminiyle ayırt edilemiyordu → referansın menüsü açık temada gerçekten açık,
  uygulanan palet doğruymuş. (Ders: düşük çözünürlüklü görüntüden renk yargısı verme; ölç.)
- **Dev ortamı güncellenmemişti** — 1.1.0 yalnız prod'a dağıtılmıştı, dev eski temadaydı.

#### Ölçülen kusurlar (dev'de gerçek veriyle)

- **Tablo başlık dili çelişiyordu:** sıralanabilir kolon `12px/500/BÜYÜK HARF/muted`, düz kolon
  `14px/600/koyu` — aynı başlık satırında iki tipografi (15 dosya / 48 çağrı).
- **Mobilde hücreler eziliyordu:** /stock 375px'te kap 341px, tablo 862px, hücre 4 satıra sarıyor,
  satır yüksekliği 85px. **Kök neden:** `width:100%` + `table-layout:auto` bir tablonun kullanılan
  genişliği `max(kap, MIN-CONTENT)`; hücre sarabildiği için min-content "kolonun en uzun kelimesi"ne
  iniyor → tablo daima kaba sığıyor ve `overflow-x-auto` **hiç tetiklenmiyor**.
- **Sipariş detayı mobilde sessizce kırpılıyordu:** ızgara 343px iken çocuğu 380px; sayfa
  `overflow-x-clip` emniyeti yüzünden kaymadığı için taşan 21px **görünmez ve erişilemez** oluyor,
  "İptal" düğmesi (sağ kenarı 383px) tıklanamıyordu.

#### Denetim

6 lensli çekişmeli-doğrulamalı workflow (54 ajan; kabuk · tablo · form · kart · mobil · tema):
**48 bulgu incelendi → 43 doğrulandı** (10 yüksek · 26 orta · 7 düşük), 5 çürütüldü. Düzeltmeler
4 ayrık-dosya işçisine + çekirdek primitifler tek elde toplandı.

#### Düzeltildi — çekirdek (tüm paneli etkiler)

- `ui/table.tsx`: `th`/`td` → `whitespace-nowrap` (yatay kaydırma artık gerçekten çalışıyor);
  uzun serbest metin taşıyan 4 hücreye `whitespace-normal` muafiyeti. Ölü
  `[&:has([role=checkbox])]:pr-0` kuralı silindi — bu panelde seçim kutusu **native**
  `<input type="checkbox">` ve native input `role` **özniteliği taşımaz**, seçici hiç eşleşmiyordu.
- `data-table/*`: başlık tipografisi `TableHead`'e bağlandı, `h-10` ezmesi kaldırıldı, tablo yüzeyi
  kart sözleşmesine alındı (`rounded-xl bg-card shadow-xs`), **kolon görünürlüğü menüsü mobilde
  açıldı** (geniş tabloların dar ekrandaki tek kaçış yoluydu ve tam orada kapalıydı).
- `ui/sidebar.tsx`: ikon modunda **dikey kaydırma açıldı** (25 menü öğesi ikon modunda ~1170px yer
  kaplıyor; kısa ekranda alttaki 5-6 öğe kırpılıp erişilemiyordu). `SidebarInset` `<main>` → `<div>`
  (iç içe iki `main` landmark'ı vardı).
- **Mobil:** sheet menüde bağlantıya dokununca kapanma + `aria-current="page"`; Dialog `vh` → `svh`
  (mobil tarayıcı çubuğu açıkken onay düğmeleri ekran dışında kalıyordu); kapat düğmesi 16 → 32px
  daire; Popover `max-w` + kaydırma; sipariş detayı ızgara çocuğuna `min-w-0`.
- **Odak göstergesi tek-kaynak kuralı:** "içeriğe atla" ve `TabsList` halkaları kaldırıldı,
  `live-feed` halkası eşik-altı `/60`'tan tam opaklığa çekildi.
- **Form dili:** `Select` ve `Combobox` artık `controlBase` tek kaynağını kullanıyor (h-8/h-9 karışıklığı bitti).

#### Düzeltildi — ekran katmanı

- Ad-hoc kart div'leri → `Card`; elle kurulmuş iki modal → `Dialog` primitifi; süzgeç çipleri tek
  bileşene; kontrol yükseklikleri tek rejime.
- Ham enum sızıntıları `lib/labels.ts`'e (`adminRoleLabel` eklendi); elle uyarı kutuları → `Alert`.
- `canceled` tonu `danger` → `neutral` (aynı durum bir ekranda gri, diğerinde kırmızıydı).
- Ctrl+K paleti **gerçek modal** oldu (odak tuzağı, `aria-modal`, kapanışta odak iadesi Radix'ten) —
  kısayol, arama ve gezinme davranışı değişmedi.
- Dokunma hedefleri: satır seçim kutusu 16 → 44px, satır içi ikon düğmeleri 24 → 32px; mobilde
  DataTable araması tam genişlik.

Salt **sunum**: backend sözleşmesi, form `name=`, API alan adları ve iş mantığı değişmedi.

## [1.1.0] - 2026-08-14

### Admin arayüzü: shadcnspace tasarım diline uyarlandı (migration YOK)

Panel görsel dili, kullanıcının paylaştığı **shadcnspace** panolarına (`dashboard.shadcnspace.com`
— analytics + ecommerce) göre yeniden düzenlendi. Referans tarayıcıda **ölçülerek** çıkarıldı
(tahmin değil): CSSOM'dan token'lar, hesaplanmış stiller ve yerleşim kutuları okundu. Palet
**değişmedi** — ölçüm, referansın da standart shadcn nötr oklch paletini kullandığını gösterdi;
değişen tipografi, yarıçap ölçeği, kabuk düzeni ve yoğunluk.

#### Değişti — tasarım sistemi

- **Tipografi: Inter / JetBrains Mono → Geist / Geist Mono.** `next/font/google` üzerinden
  (eskisi de öyleydi) → **yeni bağımlılık yok**. `latin-ext` alt kümesi şart: Geist'in `latin`
  setinde ş/ğ/İ/ı/ç yok, eksik olsaydı Türkçe metin yedek fonta düşerdi.
- **`--radius` 0.625rem → 0.5rem** (kart `rounded-xl` = 12px, düğme/alan `rounded-lg` = 8px).
- **Kabuk `variant="inset"`:** sayfa zemini `bg-sidebar`, içerik `m-2 ml-0 rounded-xl outline
  shadow-sm` ile yüzen bir kart; kenar menü kenarlıksız ve zeminle aynı düzlemde.
- **Kenar menü:** aktif öğe artık **dolu pill** (`bg-primary`/`primary-foreground`; eskiden soluk
  `bg-sidebar-accent`), hover `bg-primary/5 text-primary` + `translate-x-1` kayma (ikon modunda ve
  `motion-reduce` tercihinde kapalı), grup etiketi 12px/600 uppercase.
- **Tablo:** başlık `h-11`, 14px/600, **koyu** metin (uppercase 11px muted kalktı); hücre `px-4 py-3`.
- **Gölge dili `shadow-sm` → `shadow-xs`** (referansla birebir: `0 1px 2px rgb(0 0 0/.05)`);
  kart iç boşluğu 24px, kart başlığı 16px, açıklama 14px; **yalnız-ikon düğme = daire**;
  select/combobox/popover/dropdown/command yarıçapları form diliyle hizalandı; StatTile etiketi
  normal cümle düzeninde 14px muted.

#### Bilinçli sapmalar (referans kopyalanmadı)

- **Sticky başlık korundu.** Referansın `main`'i `overflow:hidden` olduğu için sticky başlıkları
  fiilen çalışmıyor (ölçüldü: 600px kaydırınca başlık −592'ye gitti). Bizde `overflow-x-clip` +
  `sticky top-2` + `rounded-t-xl` ile başlık gerçekten sabit kalır.
- **`--ring` 0.48'de bırakıldı** (referans: 0.708). Odak göstergesi bu panelde tek kaynaklı bir
  outline'dır; referans değeri kontrastı 6.54:1'den ~2.5:1'e düşürür, belgelenmiş a11y kararını
  bozardı.
- **Hücre dolgusu `py-3`** (referans `py-6`): 8-12 kolonlu operasyon tablolarında satır başına
  ~95px ekranı kullanılamaz kılardı.
- **5 hue'lu semantik durum dili** (`success/info/warning/attention/destructive`) korundu.

#### Eklendi

- `apps/admin/theme-backup/` — eski temanın (Inter + klasik kabuk) **birebir yedeği** (16 dosya),
  `README.md` ve tek komutluk `restore.sh`. Klasör `tsconfig.json` `exclude` ve
  `check-use-server.js` `SKIP_DIRS` içinde: build'e ve taramaya girmez (girseydi göreli
  import'lar typecheck'i kırardı).

### Re-doğrulama: 16 bulgu — kendi H1 regresyonum dahil (migration 0036, eklenti v1.0.4)

Yukarıdaki denetim partisinin düzeltmeleri, bu kez onları **çürütmeye çalışan** 5 lensli bir
workflow'dan (27 ajan) geçirildi → **16 doğrulanmış / 6 çürütülmüş**. En ağır bulgu benim
düzeltmemdi ve bu, projenin kayıtlı dersini bir kez daha doğruladı: *kendi düzeltmen yeni bir
yol açar.*

#### Düzeltildi — correctness

- **[ORTA, kendi regresyonum] Per-atama iptalinde satırı terminal yapmayıp `qty` düşürmek,
  H1 bedava-lisans yolunu YENİDEN AÇTI.** `reconcileOrder`'ın iade koruması tek bir yükleme
  dayanıyor (`if (line.canceled) continue`); satır artık terminal olmadığı için mağazadan
  gelen bir yeniden-gönderim adedi geri yükseltiyor ve partial-auto iptal edilen birime taze
  anahtar teslim ediyordu. Ters yönde de: iptal sebebi "kusurlu anahtar" ise adet düşüşü
  müşterinin **ödediği hakkı** sessizce kısıyor ve satırı 'fulfilled' işaretliyordu.
  **Kök neden:** `qty`'ye iki anlam birden yüklenmişti — hem *mağaza gerçeği* hem *doldurma
  hedefi*. **Düzeltme:** `order_lines.canceled_units` defteri (migration 0036, additive).
  `qty` mağazadan gelir ve dokunulmaz; iptaller ayrı kolonda birikir; hedef tek noktada
  `qty − canceled_units` (`orders/fill-target.ts`) — teslimat motoru, all-or-nothing kapısı,
  satır durumu, "neden bekliyor" tanısı, müşteri ilerlemesi ve mağaza yoklaması hepsi oradan
  okur. Mağaza adedi düşerse defter aynı miktarda azaltılır (aynı iptal iki kez sayılmaz);
  adedi artıp defter doluysa görünür olay yazılır.
- Tam iadede (`revokeOrderForSite`) satır zaten terminalken defter şişiyor ve yanıltıcı olay
  yazılıyordu.

#### Düzeltildi — güvenlik

- **[ORTA]** Tedarikçi fişindeki `key_snapshot` kolonu salt-okunur SQL denylist'inde yoktu →
  fiş maskesi AI NL→SQL yolundan **tamamen atlatılabiliyordu** (AI varsayılan kapalı; savunma
  derinliği). Kolon ve iki tablo denylist'e eklendi, regresyon testiyle kilitlendi.
- Hesap tipli fiş kaleminde maskeleme sır **olmayan** alanları da siliyordu → tedarikçi raporu
  bilgisiz kalıyordu; karantina listesiyle aynı alan-farkında davranışa çekildi.

#### Düzeltildi — UI/UX

- **[ORTA] `includesTr` ASCII büyük 'I'da sessiz boş sonuç veriyordu**: Türkçe katlamada
  'I' → 'ı' olduğu için "ai" araması "AI Operasyon"u bulamıyordu. Bir önceki parti bu kusuru
  5 yeni yere yaymıştı. Merkezî düzeltme (iki geçişli katlama) ~15 çağıranı birden onarır.
- Stok girişindeki parti seçicisi artık sunucu-taraflı `?productId=` süzgeci kullanıyor —
  global 500'lük pencere + istemci süzgeci, geçerli bir partiyi "yok" gösterebiliyordu.
- Kırpma bayrağı hata/temizleme yollarında bayat kalıyordu; iptal onay modali artık gerçekleşen
  davranışı anlatıyor ("diğer N lisans geçerli kalmaya devam eder"); maskeli fiş raporu sessizce
  indiriliyordu → uyarı bandı.
- `truncated` tam sınırda yanlış pozitifti (tam 500 parti / 2.000 müşteride "liste eksik") →
  "tavan+1 çek, kırp" desenine geçildi.

#### Düzeltildi — WP eklentisi (v1.0.4)

- Bir önceki partide eklediğim "paket adresi reddedildi" uyarısı, Docker/aynı-sunucu
  kurulumlarında **kalıcı ve kapatılamaz bir kırmızı banda** dönüşüyordu: paket doğrulaması,
  1.0.3'te genişletilen panel-adresi kuralıyla çelişiyordu. İki kapı tek tanıma bağlandı
  (indirme host'unun panel host'una eşit olma şartı aynen korundu).
- Multisite'ta bayrak kapsamı, çok baytlı karakterde boşalan mesaj ve panele ulaşılamazken
  bayat kalan uyarı düzeltildi.

#### Doğrulama

typecheck 4/4 · admin production build · VPS izole test DB **entegrasyon 210/210 + yarış 3/3**
(mağaza yeniden-gönderiminin iptal edilen birimi taze anahtarla dolduramadığını kanıtlayan yeni
regresyon testi dahil) · **PHP-lint 12/12** (bir önceki partide hiç koşulmamıştı) · prod
`/health` 200 v1.0.0, migration tracking 37, `canceled_units` canlı, api ERROR 0 ·
eklenti v1.0.4 panele yayınlandı.

### Proje geneli denetim: 17 doğrulanmış bulgu (migration 0035)

Kullanıcı: *"Projeyi baştan sona incele, denetle — güvenlik, performans veya UI/UX ile ilgili
sorunlar varsa ilgili ajanlarına görev dağılımı yapıp iyileştirmeler yap. Kullanım rehberi ve
menüdeki tüm sayfaları test araçlarınla kontrol et."*

5 boyutlu (güvenlik · correctness · performans · UI/UX · WP+docs+ops), her bulgusu ikinci bir
ajanla çürütülmeye çalışılan denetim → **17 CONFIRMED** (0 yüksek, 2 orta, 15 düşük).
Düzeltmeler 3 paralel işçi + merkezî sipariş/şema işiyle yapıldı.

#### Düzeltildi — correctness

- **[ORTA] Tek atamayı iptal etmek, aynı satırdaki DİĞER geçerli lisansları müşteriden
  gizliyordu.** Per-atama "İptal" satırı koşulsuz `canceled` yapıyordu; müşteri görünümü iptal
  satırlarını elediği için qty=3'lük bir satırda tek anahtar iptal edilince müşteri **elinde hâlâ
  çalışan 2 anahtar dururken 0 lisans** görüyordu (veritabanında `active`). Düzeltme iki yönlü
  olmak zorundaydı — tek yönlüsü bu projenin en sık tekrarlayan hatasını (H1 bedava lisans)
  doğururdu: kardeş atama kaldıysa satır **terminal yapılmaz**, ama adet geri alınan birim kadar
  **düşürülür** (`teslim == adet` ⇒ partial-auto taze anahtarla doldurmaz); kardeş kalmadıysa
  eski davranış (terminal). Kalıntı risk sessiz bırakılmadı: mağazada karşılığı olmayan bir panel
  iptalinden sonra mağaza siparişi yeniden gönderirse adet geri yükselir — bu artık sipariş zaman
  çizelgesine açık cümleyle yazılıyor. +3 regresyon testi.
- **bulkStatus** (WP'nin yokladığı teslim/toplam) iptal satırları paydaya katıyordu → müşterinin
  My Account'ta gördüğü ilerlemeyle çelişiyordu; `getDeliveries` ile aynı yükleme hizalandı.

#### Düzeltildi — güvenlik

- **Tedarikçi fişi detayı** `keySnapshot`'ı rol-farkında maskelemiyordu: owner'ın kestiği bir
  fişi owner-olmayan admin **düz metin** görüyordu (A1/M1 kararının fişte kırılması). Artık
  `@AdminRole` + `canRevealPlaintext`; reveal audit yalnız gerçekten düz metin döndüğünde.
- **readonly-sql denylist** (§15, AI varsayılan KAPALI) konfig görünümlerini kapsamıyordu →
  `pg_settings`/`pg_stat_activity`/`pg_config`/`pg_hba_file_rules`/`pg_file_settings` eklendi
  (savunma derinliği; otoriter katman superuser-olmayan DB rolü).

#### Düzeltildi — performans (migration 0035, additive)

- **`assignment_history` tablosunda HİÇ index yoktu** — sipariş detayı, değişim geçmişi ve
  karantina her açılışta tam tablo tarıyordu; `assignments(created_at)` de indexsizdi (satış hızı
  raporları seq-scan). Üç index eklendi.
- **listQuarantine**: fiş bilgisi için satır başına 4 korele alt-sorgu → tek join (kısmi unique
  index fan-out'u engelliyor). **detailVelocity**: 30 günlük budama (sonuç birebir aynı).
- **/batches** tüm envanteri satır satır tarıyordu → `picked` CTE + LIMIT 500;
  **/customers** LIMIT 2000. **İkisi de sessiz kırpmaz**: `truncated` ile ekranda söylenir
  (stok girişindeki parti seçicisi dahil) — geçmişte konan sessiz LIMIT "o müşteri yok"
  dedirttiği için kaldırılmıştı.

#### Düzeltildi — UI/UX ve erişilebilirlik

- **[ORTA] Beş arama noktası Türkçe'de sessizce boş sonuç veriyordu**: /notifications,
  /purchase-orders, /review, başarısız işler ve **Ctrl+K komut paleti** projenin `includesTr`
  standardı yerine ham `toLowerCase()` kullanıyordu ("inceleme" yazınca "İnceleme Kuyruğu"
  bulunamıyordu).
- Aynı dağıtım işi **/releases ile /deployments'ta farklı renk ve harf düzenindeydi** → durum
  sözlüğü tek kaynağa alındı (`deployStatusMeta`).
- Fiş oluşturma sheet'inde etiketsiz alanlar (`htmlFor`/`id`/`ariaLabel`); ürün düzenleme
  formundaki hata mesajına `role="alert"`.
- Kullanıcı bildirimi: fiş oluşturma sheet'i kenardan taşıyor ve kaydırılamıyordu (gövde dolgusu
  + `overflow-y-auto` eksikti); "Bildirilecekler" havuzunda **karantinaya alınış tarihi** yoktu.

#### Düzeltildi — WP eklentisi ve belgeler

- Güncelleyici, paket URL'ini güvenlik kapısında reddettiğinde **sessizce** güncelleme
  sunmuyordu → görünür yönetici uyarısı (reddedilen host + beklenen host). Güvenlik kontrolü
  gevşetilmedi. (Bu projede aynı ders `is_secure_panel_url` kesintisinde alınmıştı.)
- Eski marka kalıntıları temizlendi: `jl_` API anahtarı öneki, `jl_wh_` webhook nonce
  transient'i ve `jl-` HTML id'leri → `wpt_`/`wpt-`. `readme.txt` changelog'una eksik
  1.0.1 / 1.0.2 / 1.0.3 girdileri.

#### Doğrulama

typecheck 4/4 + check-use-server (22 dosya / 74 export) · admin production build · VPS izole test
DB: **entegrasyon 205/205 + yarış 3/3** · yerel birim 72/72 · dev'de **26 rota + 6 detay sayfası
200, hata sınırına düşen yok** · prod `/health` 200 v1.0.0 (db+redis), migration tracking 36,
üç yeni index canlı, api ERROR 0.


### Durum rengi sistemi: 3 hue → 5 hue (migration 0032)

Kullanıcı: *"Teslim edildi rozetlerinin özel renkleri olmalı ve hafif soluk renklerle belli
edilmeli, ilgili tüm yerlerde. `/products` boş 404 görünüyor. Sistemde başka eksik veya sorun ne var?"*

**Sorun ölçüldü.** `available` (Stokta), `assigned`/`fulfilled` (Teslim edildi), `active`,
`approved`, `sent` — hepsi **aynı emerald** tonundaydı. Yani envanterde hangi anahtarın hâlâ
satılabilir olduğu, hangisinin müşteriye gittiği bir bakışta anlaşılmıyordu.

**Palet.** İki yeni token: `--info` (mavi — tamamlanmış iş) ve `--attention` (mor — insan kararı
bekleyen). Kontrast tahmin edilmedi, **hesaplandı** (oklch → sRGB → WCAG, rozetin kendi %14 tint'li
zemini üzerinde): açık temada 5.29 / 5.67, koyu temada 6.13 / 5.86 — hepsi AA üstü ve sRGB gamut'u
içinde. Ton kuralı artık şu:

| Ton | Renk | Anlamı | Örnek |
|---|---|---|---|
| success | emerald | elimde, satılabilir | Stokta · Aktif · Teslim alındı |
| info | mavi | tamamlandı, müşteride | **Teslim edildi** · Gönderildi · Onaylandı |
| warning | amber | bekliyor, kendiliğinden ilerler | Bekliyor · Kısmi · Rezerve |
| attention | mor | insan kararı bekliyor, hata değil | İncelemede · Askıda |
| danger | rose | ölü / hatalı / engelli | Geri alındı · Geçersiz · Eşlenmemiş |
| neutral | gri | kapanmış, eylem yok | Değiştirildi · İptal · Süresi doldu |

Rozetler soluk tint + saç teli halka (`ring-inset`) aldı: tint'i koyulaştırmadan pill'i tabloda
okunur kılar. `Alert` bileşeninin `info` varyantı artık gerçekten mavi (rozetle aynı hue); eski
sessiz gri kutu `muted` adını aldı — aynı adın iki farklı renk üretmesi tasarım sistemi hatasıydı.

**Tutarlılık.** Ad-hoc küçük harfli rozetler cümle düzenine geçti (Aktif/Pasif/En yeni/Eşlenmemiş/
Garanti içi/risk bandı/dağıtım durumları). `pasif` bir tabloda kırmızı, diğerinde çerçeveliydi →
nötr. Katalogdaki "Eşlenmemiş" uyarı sarısından çerçeveliye indi (katalogda eşlenmemiş olmak bir
eksik değildir — mağaza lisans taşımayan ürün de satar). `/orders` kırpma bandı bilgi→uyarı oldu
(ikonu zaten uyarıydı).

### `/products` 404'ü kapatıldı

`/products/[id]` sayfasının breadcrumb'ı `/products`'a link basıyordu ama o adreste sayfa yoktu →
404, üstelik etiket ham İngilizce "products". Ürün listesi `/stock` altında yaşıyor; **ikinci bir
liste eklenmedi** (aynı veriyi iki adreste göstermek hangisinin doğru olduğu belirsiz iki ekran
üretir) — `/products` artık `/stock`'a yönlenir.

Yönlendirme **middleware'de**: sayfa içindeki `redirect()` tek başına yetmiyor, çünkü async root
layout stream'e başladığı için Next gerçek 307 yerine meta-refresh gövdesi üretiyor (dev'de
ölçüldü: 200 + boş kabuk). Kök yol için de aynı sebeple middleware kullanılıyordu.

### Taramada bulunan eksikler

- **Performans (migration 0032).** `license_items.product_id` üzerinde koşulsuz index yoktu —
  mevcut iki index de `WHERE status = 'available'` kısmi index'iydi. "Bu ürünün tüm kalemleri"
  (ürün detayı, envanter, stok girişi önizlemesi) tam tablo taramasıydı. Yeni
  `(product_id, created_at, seq)` index'i sıralamayı da karşılıyor. Koddaki "product_id index'e
  oturur" yorumu yanlıştı, düzeltildi.
- **Operasyon.** Dağıtım kuyruğunda takılı kalan `pending` istek: zombi temizliği `claimNext`'in
  içindeydi, yani tıkanmanın sebebi runner'ın kendisi olduğunda hiç çalışmıyordu → istek sonsuza
  dek bekliyor, guard 409 veriyor ve **panelden bir daha dağıtım yapılamıyordu**. Temizlik istek
  yoluna da kondu (30 dk) ve `/deployments` 3 dakikadan sonra nedeni söyleyen bir uyarı gösteriyor.

### Lisans listesi: içe aktarma sırası korunur (migration 0030 + 0031)

Kullanıcı: *"Windows 11 Pro ürününe bugün sıralı bir stok eklemiştim ama lisans anahtarı
listesinde hepsi karışık, rastgele sırada görünüyor. Verdiğim liste gibi sıralı olmalı — sonuncu
eklenen her zaman en üstte, sıra şaşmadan."*

**Kök neden (dev veritabanında gerçek veriyle ölçüldü, tahmin değil).** Bir içe aktarmanın bütün
satırları tek transaction'da yazılıyor; `created_at` varsayılanı `now()` = *transaction* zamanı
olduğu için o bloktaki her satır **aynı damgayı** taşıyor (ölçüm: 15 satırlık bir giriş tek damga).
Sıralamanın ikinci anahtarı ise rastgele bir UUID'ydi → blok içindeki sıra keyfi görünüyordu.
Aynı boşluk **atama** yolunda da vardı (`ORDER BY expires_at, created_at`, üçüncü anahtar yok):
aynı partiden hangi anahtarın müşteriye gideceği de rastgeleydi.

**Çözüm.** `license_items.seq` (monoton artan) kolonu + iki index. Listeleme
`created_at DESC, seq ASC` → **en yeni giriş en üstte, blok içinde operatörün yapıştırdığı sıra**.
Atamada `seq` üçüncü anahtar olarak eklendi: FEFO önceliği (önce ölecek satılır) bozulmadan
"önce girilen önce teslim edilir".

**Sıra kolonu tek başına yetmiyordu.** Çok-ajanlı tarama, müşteri teslimatı (`getDeliveries`),
teslimat maili ve admin sipariş detayı sorgularında **hiç ORDER BY olmadığını** ortaya çıkardı —
yani panel düzelse bile mail ve My Account farklı sıra gösterebiliyordu; üçü de bağlandı.
Çekişmeli doğrulama ayrıca **kendi değişikliğimdeki bir boşluğu** yakaladı: WP mağaza ekranındaki
meta box tek başına `deliveredAt DESC` kalmıştı (ters yön, tek teslimatta keyfi) → birincil anahtar
korunarak `seq` ile eşitlik çözüldü. Aynı sınıftan üç belirsizlik daha kapatıldı: karantina
listesi (LIMIT'li sıralama tie-break'sizdi → hangi satırların pencereye gireceği keyfiydi),
Ctrl+K anahtar araması (`ORDER BY`sız `LIMIT 10`) ve toplu değiştirme adayları.

**Bilinen sınır (dürüstlük).** Migration'dan **önceki** satırların `seq` değerleri tablonun fiziksel
sırasından gelir; bu satırlar zaman içinde güncellendiği için eski bloklarda sıra garanti değildir.
Yapıştırma sırası daha önce hiçbir yere yazılmıyordu, geri kazanılamaz — **bundan sonraki girişlerde**
sıra kesin. Migration tabloyu yeniden yazar; uygulandığında tablo küçüktü (prod 3, dev 22 satır),
ileride büyük tablolar için rewrite'sız reçete migration dosyasının başına yazıldı.

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
