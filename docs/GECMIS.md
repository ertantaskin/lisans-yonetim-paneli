# Geçmiş — tur-tur çalışma günlüğü

Bu dosya `CLAUDE.md`den **birebir taşınmıştır** (içerik değiştirilmedi, yalnız yeri değişti).
Neden: CLAUDE.md her oturumda bağlama yükleniyor ve 310 KB'a ulaşmıştı; kurallar, geçmiş
anlatılarının arasında kayboluyordu. Damıtılmış kural/ders listesi CLAUDE.md → "Tekrarlayan
tuzaklar" bölümünde; buradaki kayıtlar o maddelerin ARDINDAKİ vakalardır.

Sürüm bazlı özet: [../CHANGELOG.md](../CHANGELOG.md) · Dağıtım kaydı: [DEPLOY-LOG.md](DEPLOY-LOG.md)

> Sıra: eski girdiler üstte değildir — dosya zaman içinde hem başa hem sona eklenerek büyüdü.
> Aradığını `grep` ile bul (ör. `grep -n "advisory-lock" docs/GECMIS.md`).

---

**ŞARTNAME GERÇEĞE HİZALANDI + `check-docs` KAPISI (commit 6fd5581→effa00e, migration YOK):**
Kullanıcı *"kontrolleri sağla, kalan eksikleri tamamla, projeyi daha düzenli bir hale getir,
rehberleri mimariyi karışıklığın önüne geç tamamıyla"* dedi. Doğrulama temeli önce ÖLÇÜLDÜ
(typecheck + beş kapı, birim 411, ölü dosya 0) ve temizdi → aranan şey kodda değil BELGEDEYDİ.

- **[EN AĞIR] Şartname, üretimde aşırı teslimat üreten yazımı ÖĞRETİYORDU.** §2 "Atomik stok
  atama (sistemin kalbi)" başlığı altındaki örnek SQL tam olarak
  `UPDATE … WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` idi — yani bir önceki turda
  düzeltilen, ÖLÇÜLMÜŞ (6 istenirken 20 satır) üretim hatasının ta kendisi. Belgeyi okuyup
  uygulayan biri hatayı yeniden yazardı. Artık `MATERIALIZED` CTE + fail-closed kalkan +
  tie-break gerekçesi (aynı tx'te yazılan satırların `created_at`'i BİREBİR aynıdır) + MAK'ın
  gerçek davranışı (`LEAST(istenen, kalan)` + tek anahtar tercihi + **anahtar başına** kapasite)
  yazıyor; üstte de "bu yazımı KULLANMAYIN" uyarısı var.
- **[Veri modeli] 32 tablonun 15'i belgede HİÇ geçmiyordu; 4 tablo UYDURMAYDI.**
  `stock_batches` / `customer_tags` / `panel_users` / `blocklist` — hiçbiri hiç var olmadı ve
  `panel_users` ayrıca "argon2id" diyordu (gerçek: **scrypt**). Şartnameye güvenip kod yazan
  biri var olmayan bir tabloya yazardı. §3 tamamen yeniden yazıldı (alt sistemlere gruplu).
- **[Rota haritası] 38 admin rotasının 36'sı anılmıyordu** → yeni §13.1 (gruplu tablo). Panelde
  bir ekranın var olup olmadığı ancak kod okunarak öğrenilebiliyordu.
- **[API] Var olmayan uçlar yazılıydı:** `/v1/products/mapped` (hiç olmadı; gerçeği `/v1/catalog`),
  `/v1/replacement-requests` (gerçeği `/v1/replacements`), atama/tamamlama uçları `/v1/admin/`
  önekini taşımıyordu (yetki kararını da karıştıran bir hata). Site-facing/public uçlar eklendi.
- **[KAPI] `scripts/check-docs.js` — 6. kapı** (`pnpm typecheck` + CI): şemadaki her `pgTable`,
  `apps/admin/app` altındaki her rota ve belgede anılan her `/v1/...` ucu denetlenir.
  **Kontrol denemesi yapıldı: üç denetim de kırmızıya düştü.** Kapsam BİLEREK dar — belgeyi
  kopya-şemaya çevirmek onu okunmaz yapar ve her kolon değişikliğinde CI kırardı; denetlenen
  şey "bundan hiç bahsedilmemiş" hatasıdır. (Kontrol denemesi sırasında `git checkout` ile
  gerçek düzenlemeleri de geri aldım; yedekten dönüldü — ders: kapı denemesini AYRI kopyada yap.)
- **[Plan↔gerçek sapmaları, hepsi kodla doğrulandı]** §1 Resend/SES → **SMTP-only** ·
  pgBackRest/S3/WAL → `pg_dump`+cron+tatbikat (dış kopya bir KANCA) · Uptime Kuma kurulmadı ·
  Sentry env-gated varsayılan KAPALI · §2.5 sağlayıcı `delivered/bounced` webhook'u YOK ·
  §8 libsodium DEĞİL (Node `crypto`), **anomali oto-askısı YOK** (yalnız `security_events`),
  "Woo'ya geri doğrulama" YOK, Tailscale/IP kısıtı YOK · §16 **"RPO ≤ 5 dk" HEDEF** olarak
  işaretlendi (PITR yok → gerçek RPO = son yedek anı; `RUNBOOK-DR` zaten doğrusunu söylüyordu,
  şartname onunla ÇELİŞİYORDU) · §18 faz durumları (0/1/2/4 ✅, **3 ❌ düşürüldü** — okuyan
  "Faz 3 bekliyor mu?" diye düşünüyordu) · kapsam-DIŞI listesi tamamlandı.
- **[Belge düzeni] İki elle sürdürülen mimari belgesi vardı** (`MIMARI.md` + `mimari-gorsel.html`,
  ikincisi 3 hafta geride) — bu projede tekrarlayan "aynı kavramın iki tanımı" sınıfı.
  `MIMARI.md` **tek yetkili** ilan edildi; HTML'in KENDİ İÇİNE tarihli uyarı bandı kondu
  (tarayıcıda doğrulandı) — asıl karışıklık dosyayı doğrudan açan kişide oluyordu.
  CLAUDE.md'ye **belge yetki sırası tablosu** eklendi (kod > şartname > CLAUDE.md > runbook >
  geçmiş > görsel kopya). README kendi "Durum" listesini tutuyordu ve aylarca "Faz 1 MVP"
  dedi → durumu tekrarlamayı bıraktı, kaynağa yönlendiriyor.
- **Rehber/menü kapsamı ölçüldü:** panel içi `/guide` 38 rotanın tamamına değiniyor (yalnız
  `/templates/new` alt sayfası anılmıyor, ebeveyni kapsıyor); sol menü eksiksiz (menüde
  görünmeyenler ebeveyninden ulaşılan alt sayfalar).
- **Doğrulama:** typecheck 4/4 + **altı kapı** · birim 68+184+165 · build 3/3 ·
  **VPS izole PG17+Redis7: entegrasyon 429/429 + yarış 3/3** · PHP-lint + eklenti davranış
  108/108 · prod/dev checkout'ları senkron, `/v1/health` 200 v1.1.0. Kod DEĞİŞMEDİ (belge +
  kapı + README/CLAUDE düzeni) → panel yeniden dağıtımı gerekmedi.

---
**İNCELEME TURU: İKİ SESSİZ SAYI HATASI + KİLİTLİ `LIMIT` DESENİNİN İKİ KARDEŞİ + BELGE DÜZENİ
(commit 91f1173→00647b3, CANLI prod+dev, migration YOK):** Kullanıcı *"gerekli dağıtımları yap ve
incelemelere devam et sorunları gider projeyi derli toplu düzenli bir hale getir"* dedi. Prod ve dev
zaten en son commit'teydi (dağıtılacak bekleyen yok) → doğrulama temeli ÖLÇÜLDÜ (typecheck 4/4 + beş
kapı, birim 411, ölü/yetim dosya 0, bildirim/güvenlik/olay sözlükleri TAM) ve temiz çıktı; yani
aranan şey "zaten bozuk olan" değil **henüz görünmeyendi**.

- **[SESSİZ 10× KAPASİTE]** Stok girişinde anahtar başına kullanım hakkını çözümleyen `parseMaxUses`
  noktayı **koşulsuz** atıyordu → sayı biçimli bir Excel hücresinden gelen `500.0` sessizce **5000**
  oluyordu. Bu, özelliğin ÖNLEMEK için yazıldığı aşırı satışın ta kendisidir (panel 5.000 hak sanar,
  anahtar 500'de biter) ve hiçbir katmanda hata üretmez: 5000 geçerli bir tam sayıdır, API kabul eder,
  onay modalinde yalnız TOPLAM görünür. Fonksiyonun **hiç testi yoktu**; hata tam da test yazılırken
  ortaya çıktı (kontrol denemesi: eklenen test önce KIRMIZI). Ayraç artık ancak ardından TAM 3 rakam
  geliyorsa binlik ayracıdır (`1.000`✓ · `500.0`✗ · `1.5`✗).
- **[SESSİZ 1000× MALİYET]** Aynı ekranın para alanı (`liraToCents`) yalnız nokta varken değeri
  koşulsuz ONDALIK sayıyordu → tr-TR yazımıyla `1.234` giren operatör 1234 ₺ sanıp **1,23 ₺**
  kaydediyordu. Birim maliyet her lisansa snapshot'lanır; maliyet raporu ve tedarikçi karnesi onu okur.
  Parada üç ondalık basamak olmadığı için kural belirsiz değil: grup boyutu karar verir.
- **[KİLİTLİ `LIMIT` — atama motorundaki aşırı teslimat hatasının İKİ kardeşi]** (a) MAK kapasite
  tüketimi (`consumeMultiUseCapacity`) CTE kullanıyordu ama **`MATERIALIZED` DEMİYORDU**; üstelik
  `assignAvailableSingleUse` docstring'i "MAK yolu zaten doğru deseni kullanıyor" diye YANLIŞ bilgi
  veriyordu — **açıklamanın kendisi denetimi yanlış yönlendirdi**. Tek referanslı CTE inline
  edilebilir; sonucu "tüm stok" değil daha sinsi olurdu: `taken` güncellenmiş satırdan yeniden
  hesaplanıp tüketilen kapasite ile çağırana dönen birim AYRIŞIRDI. + fail-closed kalkan (1..want
  dışı ⇒ transaction geri alınır). (b) Dağıtım kuyruğunun `claimNext`'i `UPDATE … WHERE id = (SELECT
  … LIMIT 1 FOR UPDATE SKIP LOCKED)` yazıyordu: tek çağrıda birden çok isteği `running` yapabilir ve
  `.returning()` yalnız ilkini döndürdüğü için diğerleri SESSİZCE öksüz kalır — "aynı anda tek aktif
  iş" güvencesi yüzünden panelden yeni dağıtım 409 alır, kilit ancak zombi süpürmesiyle açılır. Seç
  ve güncelle AYRI ifadeye alındı (tek transaction, kilit korunur; `check-tx-pool` 37→38 gövde).
  **Yeni testin gücü hakkında dürüstlük notu:** bu bir invaryant kilidi, arızanın yeniden üretimi
  DEĞİL (kaçak eşzamanlı yazara/EPQ'ya bağlı) — testin docstring'inde açıkça yazılı.
- **[SEMVER TEK KAYNAĞA]** "Hangi sürüm en yeni" kuralının İKİ kopyası vardı: API `updates.service`
  (müşteri sitelerinin fiilen İNDİRDİĞİ paket) ve admin `/releases` ("En yeni" rozeti + düşük sürüm
  yayın kapısı). Davranışları birebir aynıydı; sorun bugünkü sonuç değil YARINKİ SAPMAYDI (biri
  ön-sürüm desteği kazansa panel bir sürümü "en yeni" derken siteler başkasını indirir, hiçbir yerde
  hata çıkmazdı) → `@lisans/shared/domain/semver`. Taşırken `export { X } from '…'` tuzağına düştüm
  (ad YEREL bağlanmaz, tsc yakaladı) — bu kod tabanında daha önce de yaşanmıştı.
- **[TEMA YEDEĞİ ARTIK TUZAK]** `restore.sh` "tek komutta eski temaya dön" diyordu. ÖLÇÜLDÜ:
  `legacy/app/globals.css` bugünkü yüzey token'larını tanımlamıyor (`--success-vivid` yedekte **0**,
  güncelde **6**) → çalıştırılsa sessizce renksiz/eksik bir arayüz bırakırdı. Betik artık fail-closed
  (`THEME_RESTORE_ONAY=1`), README + CLAUDE.md doğru yöntemi (`git checkout <sha> -- <dosya>`) söylüyor.
  Klasör SİLİNMEDİ: hangi kararın neyin yerine geçtiğini gösteren okunabilir bir kayıt.
- **[ARAÇ] `pnpm test:iso`** (`scripts/test-integration.sh`): entegrasyon+yarış paketi için
  tekrarlanabilir giriş noktası — izole ağ + PG17 + Redis7, `--frozen-lockfile` kurulum, migration,
  paket, temizlik. Host'ta node/pnpm GEREKMEZ (VPS'te node PATH'te değil). Elle kurulum üç kez
  sahte/eksik doğrulama üretmişti; **üçüncüsü bu turda ölçüldü**: checkout'ta **vitest 2.1.9**
  dururken lockfile 3.2.6 istiyordu → ilk koşu (428/428) sessizce YANLIŞ araç zinciriyle geçmişti;
  betiğe kurulum eklendikten sonra aynı paket v3.2.7 ile koştu (+53 paket kuruldu).
- **[BELGE DÜZENİ]** `CLAUDE.md` **310 KB**'a ulaşmıştı — her oturumda bağlama yüklenen dosyada elli
  turluk geçmiş anlatısı kuralları boğuyordu; geliştirme komutları paragrafı da **birebir iki kez**
  yazılmıştı. Tur-tur günlük BİREBİR bu dosyaya (`docs/GECMIS.md`) taşındı ve kayıpsızlığı
  **satır-satır kanıtlandı** (eski dosyanın 2958 dolu satırından 2857'si burada, 208'i yeni
  CLAUDE.md'de; "bulunamayan" 15 satır bilinçli yeniden yazılanlar). CLAUDE.md **18 KB**: damıtılmış
  durum özeti + **20 maddelik "tekrarlayan tuzaklar"** (her maddesi bu projede en az bir kez üretime
  çıkmış arızadan damıtıldı) + doğrulama tablosu + geliştirme komutları. README doküman indeksi
  genişletildi; CHANGELOG'a bu tur **ve yazılmamış önceki tur** (MAK sayılarının anlatımı, eklenti
  1.1.6/1.1.7) eklendi.
- **Doğrulama:** typecheck 4/4 + beş kapı (use-server 26/89 · nest-wiring 42/133+13 · env 51 ·
  workflows 2/4/47 · tx-pool **38**) · birim **68+184+165** · build 3/3 · şema sapması YOK
  (`db:generate` "No schema changes") · **VPS izole PG17+Redis7: entegrasyon 429/429 + yarış 3/3** ·
  PHP-lint temiz + eklenti davranış **108/108** · prod `deploy.sh api admin` (sağlık kapısı +
  rollback) → `/v1/health` **200 v1.1.0**, admin `/pending` 200, api **0 ERROR** · dev yığını güncel.

---
Tasarım (v2.6) + **Faz 0 + Faz 1 (panel) + WP eklentisi CANLI, uçtan uca e2e doğrulandı ve VPS'e
deploy edildi.** `docker compose up` ile 6 servis (PG17+Redis7+API+admin+Caddy+Mailpit) ayakta. WP
test ortamı: `docker-compose.wp.yml` (WordPress+WooCommerce+MySQL). **Tam zincir kanıtlandı:** Woo
sipariş → HMAC push → panel atomik atama → My Account'ta çözülmüş key → geri kanal webhook (HMAC
doğrulandı). **Prod: Ubuntu VPS + Docker Compose + Caddy TLS (canlı).**

**Çalışan Faz 1 (MVP):**

- Kripto: AES-256-GCM envelope (per-payload DEK + master key), payload_hash dedupe
- Auth: HMAC imza guard (nonce replay, ±300sn) + admin token; site oluşturma
- Sipariş akışı: `POST /v1/orders` — idempotency, transaction içinde atomik atama
  (SKIP LOCKED), kısmi teslimat (partial-auto/approval/all-or-nothing), 201/207/202
- Tamamlama motoru: stok gelince partial-auto FIFO + manuel "Kalanları Ata"
- Teslimat: `GET /v1/orders/:id/deliveries` (çözülmüş, aktif atamalar, site scope)
- Mail: BullMQ + Mailpit, şablon, email_log; aksiyonlar: reveal(loglu)/suspend/revoke/resend
- Geri kanal webhook: HMAC imzalı, outbox, WP eklentisine hazır (order.fulfilled/partial)
- Admin UI (Next.js, sunucu-taraflı): Bekleyen Teslimatlar / Siparişler+detay / Stok / Siteler
- audit_log: reveal/revoke/suspend/import/… ; migration 0000-0005
- **WP eklentisi** (`apps/wp-plugin/wpteslimat`, ince istemci): HMAC istemci, sipariş push
  (Woo→panel), webhook alıcı, My Account teslimat, admin meta box; lisans verisi WP'de durmaz

**e2e doğrulandı** (gerçek stack, 50+ assert): yarış (çifte atama=0), sipariş→atama→çözülmüş
teslimat, idempotency, kısmi/all-or-nothing, tamamlama motoru, mail→Mailpit, webhook→imza,
revoke recompute, FEFO, eşzamanlı-tamamlama over-fulfillment kilidi.

**Adversaryel review yapıldı** (37 ajan): 30 doğrulanmış bulgudan tüm HIGH (7 tekil) +
etkili MEDIUM'lar düzeltildi ve regresyon testiyle sabitlendi.

**Faz 2 — güvenlik sertleştirme TAMAM** (ertelenen 6 madde kapandı, geriye dönük uyumlu,
regresyon + canlı smoke ile doğrulandı):

- **HMAC anahtar rotasyonu** (24s dual-secret): `sites.hmac_secret_prev_enc` +
  `hmac_secret_rotated_at`; `findForAuth` grace penceresinde eski+yeni secret'ı kabul eder;
  `POST /v1/admin/sites/:id/rotate-secret` (migration 0005).
- **Envelope AAD** (kayıt-id bağlama): payload_enc v2 formatı, DEK cipher'a `license_item:<id>`
  / `site_secret:<id>` AAD → ciphertext satır-taşıma imkânsız; v1 (eski kayıt) AAD'siz
  geriye dönük çözülür. id'ler uygulamada üretilir (stock.import, sites.create).
- **Nonce TTL sınır kenarı**: `HMAC_NONCE_TTL_SEC = 2×tolerans + 60` → replay penceresini
  kesin kapsar (invaryant testli).
- **İmza yolu kanonikleştirme**: `canonicalizePath` (fragment atar, query param sıralar),
  `buildSignaturePayload`'a gömülü + PHP `canonical_path` ile birebir senkron.
- **Mask format**: sabit `••••••` gövde + yalnız son 4 hane → uzunluk/segment yapısı sızmaz.
- **autoComplete erken-çıkış**: partial-auto FIFO döngüsü yalnız GERÇEK stok tükenişinde
  durur (SKIP LOCKED kilit-çekişmesinde erken çıkmaz).

Üretimde: SMTP_SECURE=true (TLS).

**Faz 2 — hesap ürünleri (yapılandırılmış payload) omurgası TAMAM** (Commit A; adversaryel
review 3 bulgu düzeltildi; regresyon + canlı smoke 17/17 ile doğrulandı):

- **Paylaşılan payload kontratı** (`packages/shared/src/domain/payload.ts`): `AccountPayloadSchema`
  (alan tanımları: key/label/secret/required), `serializeAccountPayload` (kanonik JSON →
  dedupe stabil; boş payload reddedilir), `parseAccountPayload`, `maskSecret` (key: son-4),
  `maskAccountFields` (secret alan: KUYRUKSUZ maske — parola son-4 sızmaz).
- **Ürün oluşturma**: `payloadSchema` + `onExpiry` + `warrantyDays` kabul; `multi⇒maxUses>1`
  ve `account⇒payloadSchema` refine'ları.
- **Stok import**: account yapılandırılmış payload doğrulama + kanonik serialize; `keyFormat`
  regex; multi maxUses guard; reddedilenler `rejected`/`rejections` ile raporlanır (sessiz yutma yok).
- **Teslimat/mail/mask/reveal**: `kind` + `fields` (account alan-alan); mail alan render;
  admin mask/reveal alan-farkında (secret kuyruksuz).
- **WP eklentisi**: My Account + meta box alan-alan render (`kind` üzerinden dallanır);
  meta box `title`'daki TAM plaintext KALDIRILDI; `validUntil` yerelleştirilmiş.
- **Admin stok formu**: `rejected` yüzeye çıkar (imported=0 → yeşil değil, uyarı).

**Faz 2 — süreli hesap süre-bitişi motoru TAMAM** (Commit B; adversaryel doğrulama 6 risk
çürütüldü; canlı smoke 8/8):

- **ExpiryService** (`apps/api/src/maintenance/`): BullMQ tekrarlı iş (5dk) `valid_until`
  geçmiş AKTİF atamaları, ürün `onExpiry='hide'` ise `status='expired'` yapar (payload artık
  teslim edilmez). `onExpiry='keep'` atamalar aktif kalır. Elle tetik: `POST /v1/admin/maintenance/expire`.
- **getDeliveries savunma filtresi**: job gecikse bile `hide`+süresi-geçmiş payload SIZMAZ
  (`or(validUntil IS NULL, validUntil > now, onExpiry='keep')`); yanıta `expired` bayrağı eklendi.
- **Kısmi indeks** `assignments_expiry_idx` (status='active' AND valid_until IS NOT NULL) —
  sweep seq-scan'i önler (migration 0006).
- Expired atamanın license_item'ı serbest bırakılmaz ("hak geri gelmez", §2).

**Admin UI + çoklu-admin auth TAMAM** (detay yukarıda "Görsel kimlik" + memory `admin-auth`):
UI satnaing/shadcn-admin nötr diline taşındı (Siparişler/Stok/Siteler TanStack DataTable, sipariş
detayı kart/timeline, shadcn form primitifleri, iki temada WCAG AA); çoklu-admin auth (§8) 4 fazda
eklendi (`admin_users` scrypt/role/token_version, imzalı oturum + her-istek revocation, owner-only
RBAC) — **env-gated (`SESSION_SECRET`+`ADMIN_SEED_*`), varsayılan KAPALI**. VPS'e deploy edildi (canlı).

**Faz 2 — Dalga 1-8 (paralel-workflow inşası, hepsi CANLI + deploy):** Kalan roadmap, ayrık-dosya
paralel işçi dalgalarıyla tamamlandı (her dalga: 3-5 işçi + merkezî glue → tek build → VPS deploy).
Detay: memory `dalga-build-progress`.

- **D1** (§16/§17): mutabakat/tutarlılık cron (`reconcile` — multi kapasite/fulfilled=Σunits/tek-kullanım
  ≤1; düzeltmez, kritik loglar) · admin güvenlik başlıkları (X-Frame/CSP-Report-Only/HSTS) ·
  HMAC secret rotasyon UI · products.list stok agregasyon perf (partial index).
- **D2** (§13): `replacement_requests` (site-facing POST /v1/replacements HMAC + garanti penceresi;
  admin destek kuyruğu /support Onayla/Reddet/Bilgi-İste; onay stok-ön-kontrollü değişim makinesi) ·
  müşteri 360 (/customers + /customers/[email], değişim-oranı suistimal işareti, etiket/not) ·
  WP "Sorun Bildir".
- **D3** (§12/§13/§18): `notifications` + düşük-stok tespiti (BullMQ 30dk dedupe) + Telegram (env-gated) ·
  /notifications · Raporlar (/reports, recharts: stok/velocity/tükenme-tahmini).
- **D4** (§12): tedarik zinciri — `suppliers`/`purchase_orders`(kısmi teslim-al, over-receive kilidi)/
  `batches`(recall→satılmamış 'voided')/`stock_adjustments`(sebepli+audit). /suppliers /purchase-orders /batches.
- **D5** (§5/§9/§14/§15): `sites.sales_daily_quota`+`sandbox` · SalesQuotaGuard (429, çekirdek atama korundu) ·
  sandbox mail-yönlendirme · `security_events` + anomali/velocity tespiti (auto-suspend YOK) ·
  KVKK anonymize (PII maske, kayıt silinmez). /security.
- **D6** (§13/§16): Ctrl+K global arama (sipariş/e-posta/key-son5, payload sızmaz) · şablonlar
  (/templates CRUD+önizleme+test) · dead-letter/outbox (/ops + replay) · /settings durum.
- **D7** (§13): toplu-değiştirme sihirbazı (recall'lı partide satılanları değiştir) · akıllı stok önizleme.
- **D8** (§12/§13): ürün detayı · tedarikçi karnesi · site detayı · genel-bakış dashboard.
- `audit_action` enum: +site_update/+anonymize. Bilgi mimarisi (§17) tam canlı ("Yakında" kalktı).

**Faz 2 — Dalga 9-11 (son dalgalar, hepsi CANLI + deploy + smoke):** Ertelenen tüm roadmap
maddeleri kapatıldı — proje mimari kapsamı %100 tamamlandı.

- **D9** (§14): onboarding — tek-seferlik "bağlan kodu" (`site_connect_tokens`, 15dk TTL, atomik
  tek-kullanım, şifreli kimlik; `sites.rekey`) + 3 adımlı admin sihirbazı (/sites/new) + WP "Panele
  Bağlan" (PUBLIC `POST /v1/connect/claim`) · operatör presence (Redis sorted-set 30s heartbeat,
  çakışma uyarısı) · kayıtlı görünümler (`saved_views`, aktör-kapsamlı CRUD). migration 0013.
- **D10** (§16): private update endpoint (`plugin_releases`; PUBLIC update-checker JSON + zip indir;
  admin publish) + WP `class-updater` (WP eklenti güncelleyici) · k6 yük testi (`load/`) + Playwright
  e2e (`e2e/`, workspace-dışı standalone) · trace-id uçtan uca (Fastify req.id = gelen x-trace-id =
  yanıt başlığı = log izi). migration 0014.
- **D11** (§15): AI-destekli operasyon — **env-gated, VARSAYILAN KAPALI** (AI_ENABLED=true +
  ANTHROPIC_API_KEY yoksa AI uçları 503, sistem AI'sız tam çalışır). `AiService` (Anthropic Messages
  API ham fetch, SDK yok; refusal/timeout; AiUnavailableException) + `ReadonlySqlService` (tek-ifade +
  SELECT/WITH + SALT-OKUNUR transaction + 5s timeout + 200 satır). Özellikler: triyaj (destek talebini
  AI kategorize+taslak öner, MASKELİ bağlam, yalnız ÖNERİ — eylem yok), NL→SQL rapor (üretilen SQL HER
  ZAMAN gösterilir), günlük anomali (metrikler HER ZAMAN döner; AI kapalı/hata → paragraph=null,
  GRACEFUL, 503 atmaz). Admin UI /ai (proxy'lerde ADMIN_TOKEN sunucu-taraflı). "AI önerir, insan onaylar."
  Migration YOK (mevcut tabloları salt-okunur okur). API anahtarı KULLANICI sırrı — üretilmez, aktivasyon
  kullanıcının adımı. Canlı OFF-path smoke geçti (status disabled / 503 / graceful özet metrik döndü).

**Faz 2 — Faz-4 dalgaları + adversaryel denetim (CANLI + deploy + smoke):** Kalan roadmap paralel
belirleme-workflow'u (5 alan veri modeline dayalı analiz) ile kapsamlandı; build-now dalgalar + 31
CONFIRMED denetim bulgusu düzeltildi (commit 1dee35f). typecheck 4/4, api birim 20/20.

- **D12** (§12/§13) Maliyet raporu: `costs.service/controller/module` + `/reports/costs` (recharts) —
  tedarik harcaması (tedarikçi/ürün/ay) + stok değerleme + zayi; para birimi AYRI; maliyeti bağlanamayan
  'kapsanmayan' olarak dürüst. **KÂR DEĞİL** — satış fiyatı Woo'da (panel ödemeye dokunmaz). Migration YOK.
- **D13** (§8/§9) Risk skoru: `risk-score.*` + `packages/shared/domain/risk` + `risk-badge` — müşteri başına
  okuma-anında advisory skor (0-100, faktör kırılımlı). **OTOMATİK EYLEM YOK** (§15 "insan onaylar"). Migration YOK.
- **D14** (§16) Günlük Telegram özeti: `daily-digest.*` — BullMQ cron 08:00, metrik özeti + sabit-eşik kritik
  alarm; Telegram env yoksa no-op. Migration YOK.
- **D15** (§10) Reseller katalog ucu: `channel-catalog.*` — HMAC salt-okunur stok-durumu, **FİYAT DÖNMEZ**.
- **D16** (§16) DR: `scripts/backup-drill.sh` (ayrı `*_drill` DB, çifte-atama=0 kontrolü) + `docs/RUNBOOK-DR.md`
  (RPO≤5dk/RTO≤2sa, MASTER_KEY DB'den ayrı). **D18** stok import 'kuru çalıştırma' (validateOnly, commit'siz).
  **D19** `.github/workflows/load-e2e.yml` (k6 smoke + Playwright e2e; mevcut CI'a dokunmaz).
- **Denetim düzeltmeleri:** **[H1]** iade/iptal edilen satır partial-auto ile taze key'le yeniden teslim
  ediliyordu (bedava lisans) → migration **0015** `order_lines.canceled` terminal işareti; revoke→canceled,
  autoComplete/completeLine iptal satırı hariç, recompute iptalleri aktif saymaz (hepsi iptalse 'revoked').
  **[H2]** WP Updater + Order_List `wpteslimat_init`'te örneklenmiyordu (ölü) → düzeltildi. **[M3]** readonly-sql
  OOM → CTE+DB-LIMIT. **[M4]** plugin latest SEMVER. **[M5]** completeLine enqueue try/catch. LOW: WP https
  zorlama · webhook timeout · x-trace-id sanitize · onboarding claim atomik-öncesi doğrulama · AI butonları
  kapalıyken disabled · site-oluşturma yetki tutarlılığı. Testler: readonly-sql yazma-reddi + AI maskeleme +
  onboarding claim atomik.

**Auth yönlendirme + kalan iş partisi (CANLI):**
- **Auth login/logout yönlendirme fix** (commit 270d7a8): Caddy `reverse_proxy` arkasında
  `NextResponse.redirect(new URL(path, req.url))` iç host/yanlış-protokol Location üretiyordu → giriş/çıkış
  "sayfada kalıyor" (cookie doğruydu, manuel yenileme çalışıyordu). Çözüm: iki route handler **göreli**
  `Location` döndürür (tarayıcı gerçek istek URL'ine göre çözer → proxy-bağımsız). Curl doğrulandı (303 göreli).
- **D17 (§12) teslim-edilen COGS** (migration 0016, additive): `license_items.unit_cost_cents/cost_currency`
  snapshot (import anında yazılır, batch→PO backfill); `costs.service.deliveredCogs` (aktif+delivered atamalar,
  satır snapshot'ı, currency ayrı, snapshot'sız=uncovered); `/reports/costs` "Teslim Edilen COGS" kartı.
- **Onboarding sertleştirme:** `sites.create` app-düzeyi domain dedup (ConflictException); `issueConnectCode`
  rekey+kod tek transaction (yetim/lockout site yok); wizard kurtarma yolu (`issueCodeForSite`).
- **API hardening:** public plugin update uçları IP rate-limit (429); `readonly-sql` sır-kolon denylist (400);
  AI report/suggest IP rate-limit. **presence** actor'ı `@AdminActor` header'dan (body-spoof kapalı).
  Testler: reconcile/expiry cron (PG) + AI env-gate graceful (birim). api birim 27/27.

**Kalan minör parti (CANLI, commit 4b6464d, migration 0017):**
- **api_key rekey grace** (0017 additive): `sites.api_key_hash_prev + api_key_rotated_at` (hmac grace aynası);
  `findForAuth` current-or-prev'i grace penceresinde kabul → rekey sonrası eski api_key anında 401 yemez
  (LOOKUP başta patlıyordu, hmac grace'e sıra gelmiyordu). prev hash admin yanıtlarından soyulur.
- **Redis rate-limit**: `common/rate-limit.service` (@Global, Lua INCR+EXPIRE atomik, `rl:` ad-alanı) — updates/
  AI/connect-claim bellek-içi Map yerine Redis (dağıtık + restart-dayanıklı). Smoke: info 60×200→5×429 (tam).
- **trustProxy: true → 1** (main.ts): tek Caddy hop → `@Ip()` X-Forwarded-For spoof edilemez, IP hız sınırları
  gerçekten etkili (smoke tutarlı-IP doğruladı). CDN eklenirse hop güncellenmeli.

**İyileştirme partisi (6-boyutlu analiz → yüksek+orta değer; CANLI, commit 6f82b3f, migration 0018):**
- **PERF (0018):** en hızlı büyüyen tabloların FK/sıcak-yol index'leri — assignments(order+status/line/
  license_item), order_lines(order + partial pending-product), orders(created desc / site+created) +
  orders `lower(customer_email)` fonksiyonel. Additive; getDeliveries/detay/autoComplete seq-scan → index scan.
- **Kenar-durum:** günlük özet `availableStock` artık kapasite (Σ max_uses-use_count; MULTI/MAK yanlış alarm
  düzeldi); maliyet raporu boş-currency 'kapsanamayan' + tek-para artık 'karışık' göstermiyor.
- **Gözlem:** reconcile çifte-satış/tutarlılık ihlalleri → `NotificationsService` critical (Telegram alarm),
  yalnız stdout değil; `/v1/health` degraded'da **503**; health version package.json'dan; `.env.example` AI(§15)+TZ+digest.
- **Kod-kalite:** replacements actor yalnız `@AdminActor` header (body.actor spoof kaldırıldı); admin proxy'ler
  `lib/api.apiRaw` ile x-trace-id taşır (inline fetch kopyası kalktı).
- **A11y (WCAG):** skip-to-content + aria-live duyurucu. **TZ:** compose postgres+api Europe/Istanbul (gün sınırı yerel).
- **Test:** HmacGuard + findForAuth api_key grace(0017) + RiskScore + getDeliveries expiry filtresi (integration).

migration 0000-0020. **Yapısal kapsam-DIŞI (uydurulamaz):** fiyat senkronu/kâr-marj (panelde satış fiyatı
YOK — §2/§6/§10), marketplace dış-API adaptörü, Faz-3 WP-migrasyon (greenfield), abonelik/EFT/3DS (YAGNI).
(db.execute tipli-helper + Sentry + zip depolama kararı → aşağıdaki "Eksik-giderme partisi"nde kapandı.)
Yol haritası §18.

**Tam test doğrulaması + H1 REGRESYON düzeltmesi (CANLI, commit fa4c05e):** "eksiksiz çalışıyor mu" için VPS'te
izole test DB'sine karşı entegrasyon+yarış paketi koşuldu — **ilk koşuda 59'da 4 fail** çıktı (testleri koşmanın
değeri): 1 GERÇEK regresyon + 3 bayat test. **[REGRESYON]** H1'in `order_lines.canceled` bayrağı FAZLA GENİŞ'ti —
`revokeAssignment` her çağrıda `canceled=true` yapıyordu → `replacements.approve` / `supply-ops` recall-bulkReplace /
`orders.revokeExcess` revoke SONRASI `completeLine` ile MEŞRU yeniden-atama yapar ama `canceled` satır no-op'lanır →
"Değişim için stok yok" (stok VARKEN). DÜZELTME: `revokeAssignment(...,markLineCanceled=true)` — GERÇEK iade/iptal
(revokeOrderForSite + admin manuel revoke) `true` (H1 korunur), değişim/recall/qty-düşür üç çağıranı `false`.
Bayat testler: readonly-sql rowCount (OOM cap sonrası 200), onboarding.claim (RateLimitService). Düzeltme sonrası
**entegrasyon 59/59 + yarış 1/1 GEÇTİ**. Ayrıca **canlı HMAC e2e** (deploy edilmiş prod'a, gerçek signHmac ile):
sipariş push 201 → çözülmüş key teslimat 200 → revoke 200 — tam zincir (envelope AES-GCM çözüm dahil) doğrulandı.
**Ders:** H1 gibi terminal-durum eklerken revoke'un TÜM çağıranlarını (iade vs değişim) ayır; değişim testleri
H1'den sonra koşulmadığı için regresyon kaçmıştı — entegrasyon paketi her davranış-değişikliğinden sonra koşulmalı.

**Eksik-giderme partisi (5-boyutlu mimari-kapsam + adversaryel audit → 25 bulgu; CANLI):** Kullanıcı isteğiyle
kalan eksikler paralel analiz workflow'uyla belirlenip (mimari-kapsam/correctness-güvenlik/test-kapsam/tip-kalite/
ops-kenar) triyaj edildi; migration EKLENMEDİ (0000-0018 sabit). Yapılanlar:

- **Zip depolama (§16):** `updates.latest()` artık tüm .zip base64 gövdelerini belleğe YÜKLEMEZ (yalnız meta kolon);
  indirmeye `content-length`+`ETag`(sha256)+koşullu 304 eklendi. **Karar (kullanıcı): DB'de tutuldu** — plugin ≤1MB
  (bodyLimit), API stateless/çoğaltılabilir (yerel disk paylaşılmaz), DB replikasyon-güvenli + DR yedeğinde; disk net
  getiri sağlamaz, risk katar. (Önceki "tek kalan mimari karar" böylece kapandı.)
- **db.execute → tipli helper:** `db/raw-query.rawRows<T>(exec, query)` — 16 dosyada 55 `as unknown as` cast tek noktaya
  toplandı (davranış-nötr; `Pick<Database,'execute'>` ile tx+Executor da kapsanır). suppliers `poAgg` şekil-uyuşmazlığı
  bilinçli bırakıldı.
- **Sentry (§16):** `observability/instrument` + global `SentryExceptionFilter` (yalnız 5xx/beklenmeyen; PII göndermez,
  trace örneklemesi kapalı). **env-gated, VARSAYILAN KAPALI** — `SENTRY_DSN` yoksa `Sentry.init` HİÇ çağrılmaz (tam
  no-op). DSN kullanıcı sırrı. `@sentry/node` bağımlılığı eklendi (lockfile güncellendi, build doğrulandı).
- **Güvenlik/correctness (audit):** [#9] `sites.list/update` şifreli önceki-secret (`hmacSecretPrevEnc`/`apiKeyHashPrev`)
  sızıntısı → tek `toPublicSite()` mapper ile TÜM sır kolonları strip · [#11] `readonly-sql` denylist `SELECT *`+
  `api_key_hash_prev` ile atlanıyordu → DÖNEN kolon adları (postgres.js `.columns`) denylist'e süzülür + varyant eklendi ·
  [#10] `MailService.mailer()` SMTP auth eksikti (üretimde değişim bildirimleri sessizce fail) → tek `createMailTransport`
  ortak kurucu · [#4] geri-kanal webhook'a monoton `seq` (outbox createdAt epoch-ms) + WP alıcıda `_wpteslimat_seq`
  karşılaştırması → bayat webhook durumu geri yazamaz · [#24] `webhook.processor` attempts atomik (`+1` SQL) · [#25]
  SalesQuotaGuard kota aşımı → `quota_exceeded` security_event (dedupe'lu) + 429'a `Retry-After` (gün sınırı).
- **WP eklentisi (§7):** [#1] kuyruk-log 30 gün BUDAMA cron'u (aktivasyonda schedule, `wpteslimat_prune_queue`) — "DB
  şişmesin" sözü artık kodda · [#8] staging/klon koruması (`wpteslimat_bound_home`; home_url değişince push PASİF + admin
  uyarısı) · [#16] My Account view-order'da `DONOTCACHEPAGE`+`nocache_headers` (çözülmüş key cache'lenmez).
- **Admin UI/kalite:** [#21] `updateMappingAction` try/catch (fail → tüm /stock error-boundary'ye düşmez) · [#22]
  `apiPost/apiSend` artık status-taşıyan `ApiError` + API `message` alanından temiz mesaj (ham gövde sızmaz) · [#23]
  low-stock N+1 → dedupe ana sorguya `NOT EXISTS` ile gömüldü.
- **Testler (audit test-kapsamı):** H1 gerçek-iade `canceled=true` yolu (revokeOrderForSite→autoComplete ATLAR),
  `bulkReplaceBatch` (canceled=false meşru yeniden-atama), `CostsService.deliveredCogs` (para birimi ayrımı+uncovered),
  `RateLimitService.hit` Lua sınır/TTL — 4 yeni entegrasyon testi (+ quota.guard testi yeni imzaya uyarlandı).

**Bilinçli DOC-NARROW (spec-vs-gerçek — kod değil metin daraltıldı):** [#14] mail sağlayıcı delivered/bounced webhook
YOK → SMTP-only bilinçli kapsam (`bounced` durumu üretilmez; §2.5/§6 fiili yeteneğe göre okunmalı) · [#17] §11 kiralık-slot
(multi+validity_days) süre-bitişinde kapasite havuza dönüşü + şifre-rotasyon hatırlatması yapılmıyor (bilinçli; ana
expiry `hide`/`keep` çalışır).

**#7 + #19 + #20 TAMAM (commit 7421b34→2af0ab1, CANLI + deploy + migration 0019 + 82/82 test):** Ertelenen son 3 madde
paralel dalgayla kapatıldı — çekirdek seri (hepsi orders.service/şemada iç içe); UI/WP/test 3 AYRIK-dosya işçi (dalga deseni).
- **[#7] §8 dinamik satış kotası + İnceleme Kuyruğu (held_for_review):** migration **0019** (additive) `sites.dynamic_quota_enabled`/
  `review_multiplier` + `orders.held_for_review`/`held_at`/`held_reason` + kısmi index `orders_held_idx`. **NOT (drift):** drizzle
  snapshot 0012'de kalmış (0013-0018 elle yazılmış); `db:generate` tüm ara tabloları yeniden yaratmak istedi → 0019 SQL yalnız
  gerçek-yeni 5 kolon+1 index'e budandı (IF NOT EXISTS), 0019 snapshot tam şemayı yakalar → drift buradan iyileşir. Dinamik eşik =
  `max(ceil(30g-ort × review_multiplier), 20)`. Aşımda sipariş REDDEDİLMEZ; `held_for_review` ile KABUL edilip manuel onaya alınır
  ("insan onaylar", §15). **VARSAYILAN KAPALI** (`dynamic_quota_enabled=false`) → hiçbir mevcut site etkilenmez. createOrder held-branch
  (atama yok, satır pending, `body.held=true`, 202); autoComplete + completeLine held siparişi ATLAR (job gecikse bile payload sızmaz).
  `AdminOrdersService.listHeldOrders`/`releaseHeld`(onayla→completeLine)/`rejectHeld`(reddet→satır canceled→'revoked'). Uçlar:
  `GET /v1/admin/review`, `POST /v1/admin/orders/:id/release|reject`. Admin UI **/review** kuyruğu (Onayla/Reddet) + sidebar +
  site config dinamik-kota alanları. WP: 202 held → `_wpteslimat_held_for_review` meta + My Account inceleme bildirimi + metabox rozeti.
- **[#20] TOCTOU:** sert kota (`salesDailyQuota`) artık createOrder içinde `pg_advisory_xact_lock(hashtext(site.id))` ALTINDA →
  say-sonra-ekle yarışı kapandı; idempotent retry advisory-lock'a HİÇ ulaşmaz (kotaya takılmaz). 429'a gerçekten Retry-After +
  `security_event` (quota_exceeded) — guard route'a bağlı DEĞİLDİ, #25'in Retry-After'ı latent'ti; artık servis yolu üretiyor.
- **[#19] birim-granüler revokeExcess:** MAK/multi'de `revokePartialUnits` ile yalnız fazlalık birim geri alınır (over-revoke düzeldi);
  kapasite tam `take` kadar döner (`use_count -= take`). Tek-kullanımda davranış birebir korunur (units=1 ⇒ hep tam revoke).
- OrdersService 8. arg (`SecurityService`) → 3 bayat test instantiation güncellendi (H1 dersi: yeni ctor arg = TÜM çağıranları güncelle).
  `cleanupByTag`'e `site_product_mappings` step-0 eklendi (products'a RESTRICT FK; yeni testler mapping-temizliği atlarsa FK ihlali
  almaz — elle yapanlar için no-op, merkezileştirildi). Testler: dinamik hold/release/reject (6) + revokeExcess partial (3) +
  hard-cap TOCTOU (3). **VPS izole test DB: entegrasyon 82/82 + yarış 1/1** (ilk koşuda 4 fail = 3 teardown FK + 1 REDIS_URL env,
  ikisi de harness/env; DÜZELTİLDİ). typecheck 3/3 + build 3/3 (/review dahil). Prod migration 0019 `db:migrate` (tracking 19→20);
  api+admin rebuild → `/v1/admin/review|release|reject` map'lendi, `/health` 200 (db+redis ok), boot hatasız.

**Kalan feature partisi — #6+#5 TAMAM (commit c4e9b26, CANLI, migration YOK):** [#6] Admin PROAKTİF değişim ucu
(`POST /v1/admin/assignments/:id/replace`) — kusurlu key'i müşteri "Sorun Bildir" beklemeden aynı üründen TAZE key ile
değiştirir. `AdminOrdersService.replaceAssignment` = replacements.approve deseni (MAK reddet, stok-ön-kontrol→409 eski
korunur, revoke `markLineCanceled=false` → satır 'canceled' DEĞİL, eski karantina). Sipariş detayı "Değiştir" butonu
(reason prompt) + "Değişim Geçmişi" kartı (eski key maskeli). [#5] `assignment_history` artık YAZILIYOR: paylaşılan
`orders/assignment-history.recordReplacementLineage` (eski→yeni + reason + actor) → **üç değişim yolu** (admin replace /
replacements.approve / supply-ops bulkReplace) bağlandı; ölü şema canlandı. `AdminOrdersService`→`FulfillmentService`
enjekte edildi (asiklik; boot "OrdersModule dependencies initialized" doğruladı). 6 test wiring güncellendi + yeni
`replace-assignment` testi (karantina/farklı-key/canceled=false/history + no-stock=409 + MAK=400). Entegrasyon **70/70**
+ yarış 1/1; deploy sonrası replace rotası map'lendi, /health 200.

**#18 + #R TAMAM (commit 7af3e89, CANLI):** [#18] mail şablonu DESTEKLENMEYEN değişken uyarısı — `templates.preview`
artık `unknownVars` döner (şablonda kullanılan ama SAMPLE_VARS dışı token'lar) + template-editor CANLI uyarı
("{{password}} gönderimde boş çıkar"); render sessizce '' yapmaya devam eder ama admin artık sessiz veri kaybını görür.
`usedTemplateVars` birim testi (birim 30/30). ({{key}}/{{password}} TAM besleme değil — çok-kalemli mailde belirsiz;
uyarı-yaklaşımı bilinçli.) [#R] reconcile testine `NotificationsService.create` stub'ı → "reading 'create'" best-effort
WARN'i kalktı (prod'da DI'dan gelir, etkisizdi). **Kalan:** yok — #7/#19/#20 de tamamlandı (yukarı: #7+#19+#20 TAMAM).
Kodlanabilir mimari eksik kalmadı; yalnızca yapısal kapsam-DIŞI maddeler (fiyat senkronu/marketplace/abonelik — §2/§6/§10) dışarıda.

**#7 SONRASI ADVERSARYEL DENETİM → 17 BULGU DÜZELTİLDİ (commit 89b9003, CANLI + deploy + migration 0020):**
Kullanıcı "gerçekten tamam mı?" diye sordu → #7/#19/#20 partisi 6-boyutlu denetim workflow'undan (25 ajan, bul→çürüt)
geçirildi: **17 doğrulanmış bulgu** (2 yüksek, 6 orta, 9 düşük; 0 belirsiz). Hepsi düzeltildi. **DERS:** #7 held_for_review
yeni bir terminal-durum ekledi ve H1'in ("iade edilen satır taze key ile yeniden teslim = bedava lisans") held için
TEKRARINI + all-or-nothing/eşzamanlılık/alarm boşluklarını doğurdu — yeni durum eklerken TÜM revoke/refund/deliver
yollarını + spec'in yan-şartlarını ("+ alarm") gözden geçir.
- **[YÜKSEK] Held-iade → bedava lisans:** `revokeOrderForSite` yalnız aktif atama geri alıyordu; held siparişte atama
  yok → no-op, held kalıyordu → admin sonradan "Onayla"→bedava lisans. Artık held ise `rejectHeld` (idempotent +
  `pg_advisory_xact_lock(order.id)`) ile kapatır + aktif atamaları da geri alır.
- **[YÜKSEK] §8 eksik alarm:** hold sessizdi. `SecurityService.recordQuotaHeld` → `quota_review` güvenlik olayı
  (dedupe'lu, createOrder held-dalında commit sonrası best-effort) → /security + daily-digest (reject yoluyla simetri).
- **[ORTA] release/reject yarışı:** her ikisi advisory-lock + FOR UPDATE altında CAS (held bayrağı temizleme kazananı
  belirler); `getDeliveries` artık iptal-satır (`canceled`) atamasını ASLA döndürmez (savunma derinliği).
- **[ORTA] all-or-nothing ihlali:** `completeLine` politikayı onurlandırır (tam karşılanamıyorsa `releaseAllocations`
  ile kapasiteyi geri verir, kısmi teslim etmez) → releaseHeld dahil tüm çağıranlar korunur.
- **[ORTA] eşik tabanı suistimali:** dinamik 30g taban yalnız meşru-teslim (fulfilled/partial), held-olmayan,
  bugün-öncesi siparişleri sayar → held/reddedilmiş yükseliş gelecekteki eşiği şişiremez.
- **[ORTA] held-sızıntı testi + CI Redis:** autoComplete/completeLine held-skip testleri; CI `race` job'una redis:7 +
  REDIS_URL (rate-limit beforeAll artık patlamıyor → yeni testler gerçek gate'li).
- **[DÜŞÜK] ×9:** advisory-lock koşullu (kota-kapalı sitede paralel) · idempotent re-push `held` taşır (`loadOrderResult`) ·
  `DYNAMIC_MIN_FLOOR` yalnız yetersiz-geçmişli siteye · migration drift: `orders_email_lower_idx` şemaya + **0020** (IF NOT
  EXISTS) → schema tekrar tek doğruluk kaynağı · WP held meta terminal-durumda temizlenir (my-account/webhook/metabox
  bayat notice/rozet düzeldi) · TOCTOU gerçek-eşzamanlılık race testi · dinamik-kota update()+DB-load kalıcılık testi.
- **Doğrulama:** typecheck 3/3 + build 3/3 · VPS izole test DB **entegrasyon 87/87 + yarış 2/2** (yeni held-iade
  regresyonu/all-or-nothing/held-sızıntı/TOCTOU-race/DB-kalıcılık dahil) · prod migration 0020 (tracking 20→21,
  `orders_email_lower_idx` CANLI) · api rebuild → boot hatasız, /health 200 (db+redis). migration 0000-0020.

**UX NETLEŞTİRME + PROJE-GENELİ DENETİM PARTİSİ (commit f27b4e7, CANLI + deploy + entegrasyon 88/88 + yarış 2/2):**
Kullanıcı "düzenleme ekranları çok karışık, ne işe yaradığı anlaşılmıyor; daha çok ürünmüş gibi davranan bir
tasarım gerek; ayrıca proje genelindeki eksikleri tespit edip düzelt — birden fazla işçi çalıştır" dedi →
paralel ekip (4 UX işçisi + 5 düzeltme işçisi + 26-ajanlı adversaryel denetim workflow'u; bul→çekişmeli doğrula).
- **UX (admin SUNUM — backend `name=`/kontrat DOKUNULMADI):** yeni primitifler `components/ui/field.tsx`
  (**Field** = görünür etiket + tek-satır yardım metni; **FormSection**; **FieldRow**) + `lib/labels.ts` (**TEK
  KAYNAK** Türkçe enum sözlüğü — ham `partial-auto`/`voided`/`MAK`/UUID/`payloadSchema`/regex kullanıcıya ÇIKMAZ,
  bilinmeyen anahtar→ham geri düşüş). Uygulandı: ürün oluştur/düzenle formu **4 bölüme** ayrıldı (Temel bilgiler
  / Hesap alanları / Süre & garanti / Stok & gelişmiş), her alan etiket+açıklama, Türkçe seçenekler; ürün detay
  hub İngilizce StatTile'lar Türkçe (Kullanılabilir/Teslim edilen/…) + "Stok durumu"/"Satış & tükenme" başlıkları
  + her karta amaç açıklaması; key-import/eşleme/stok-düzeltme/site-config/satın-alma-emri formları etiketlendi;
  sipariş zaman çizelgesi ham event tipi (`assignment_created`) → Türkçe; /stock tablosu ham enum temizlendi.
  `components/ui.tsx` ÇİFT (legacy) PageHeader/Card/StatusPill/Empty kaldırıldı → 17 sayfa tek canonical primitife
  (dosya silindi; `desc`→`description`, legacy Card→CardContent p-5 korunarak).
- **Denetim düzeltmeleri (backend/wiring/WP/tip; 21 doğrulanmış / 1 çürütülen; 20 düzeltildi):**
  **[YÜKSEK]** WP staging-clone guard `revoke()`+`Report_Issue::handle()`'de EKSİKTİ → klon/staging site
  iade/iptalde CANLI müşteri lisansını geri alabiliyordu; `is_clone()` guard TÜM panel-yazma yollarına eklendi
  (push/resync/revoke/report-issue; retry hook revoke'tan geçtiği için kapsanır). **[ORTA]** all-or-nothing
  `completeLine` regresyonu (#7'nin kendi guard'ından): kısmi satırda tek-birim değişim stok VARKEN "stok yok"
  verip eski key'i karantinaya atıyordu (bedava lisans kaybı) → hedef-farkında guard (`maxUnits` set ise
  `min(qty, fulfilled+toAssign)`) + regresyon testi (3/6 satır → taze key, 409 değil). **[ORTA]** `payloadSchema`
  `required` round-trip: form 4. alanı düşürüyordu → "Zorunlu" onay kutusu (opsiyonel hesap alanı mümkün, düzenlemede
  sessizce zorunlulaşmıyor). **[ORTA]** `WPTESLIMAT_WEBHOOK_SECRET` panelde karşılığı yok; ayarlanırsa TÜM webhook'lar
  401 → hayalet ayar kaldırıldı (verify hep site HMAC secret'ıyla). **Düşük (16):** kota↔idempotency yarışı (spurious
  429 → advisory-lock altında re-check), iade↔releaseHeld yarışı (§2 canlı key → per-order advisory-lock + tüm satır
  canceled + teslim-sonrası savunma), createMapping FK→404/409, stok import `@AdminActor`, opsiyonel ürün alanı
  temizleme (edit→`null`, DTO `.nullable()`), yetim `GET /mappings` kaldırıldı, `?status=` enum→500 doğrulaması
  (orders+replacements), `site_update`/`anonymize` gereksiz cast+bayat yorum, compliance `rawRows`, WP held/durum
  meta bayatlığı (metabox/liste/revoke → panel `held` bayrağı YETKİLİ, `getDeliveries`+`bulkStatus`'a eklendi).
  Atlanan: #9 (import-stock/mappings ölü dal — zararsız, yeni refaktör). Çürütülen: dinamik kota `todayCount`
  asimetrisi (bilinçli anti-suistimal tasarımı, §8). **Migration YOK** (`held` mevcut `orders.held_for_review`
  kolonunu döndürür). Doğrulama: typecheck shared+api+admin temiz; VPS izole test DB entegrasyon 88/88 + yarış 2/2;
  api+admin rebuild → /v1/health 200, admin /stock 3xx (auth). WP eklentisi (thin-client) ayrı kurulum — commit'lendi.

**RE-DOĞRULAMA + PANEL REHBERİ (commit 198b077, CANLI + entegrasyon 89/89 + yarış 2/2):** Kullanıcı
"sistem tamamen çalışır halde mi, başka eksik var mı? tamam ise panele detaylı kullanım rehberi ekle"
dedi → 7-ajanlı re-doğrulama workflow'u (bul→çekişmeli doğrula; 4 lens: orders-regresyon / WP / admin-form
/ completeness) yukarıdaki partiyi (f27b4e7) denetledi ve **2 KENDİ-regresyonu** yakaladı (WP/admin-form/
completeness lensleri TEMİZ çıktı). İkisi de orders backend'in en riskli değişikliklerinden:
- **[ABBA deadlock]** `revokeOrderForSite` iade tx'i (F3) orders→order_lines sırasıyla kilitliyordu;
  `completeLine`/`revokeAssignment` satır→sipariş sırasıyla → eşzamanlı iade + stok-import süpürmesi ABBA
  deadlock (SQLSTATE 40P01→500; veri-güvenli ama aralıklı 500). Düzeltme: iade tx satır kilitlerini ÖNCE
  alır + `orders FOR UPDATE` kaldırıldı (advisory-lock zaten refund/release'i serileştirir) → kilit edinim
  sırası tüm yollarla aynı (satır→sipariş).
- **[all-or-nothing kısmi teslim]** F1 hedef-farkında guard yalnız `maxUnits!=null`e bakıyordu; manuel
  "N Adet Ata" ucu (`POST /admin/fulfillments/:lineId/complete?units=N`, revoke YOK) all-or-nothing satırı
  kısmen teslim ediyordu (§5 ihlali). Düzeltme: rölaks YALNIZ `isReplacement=true` (3 değişim çağıranı:
  replacements.approve / admin replaceAssignment / supply-ops bulkReplace); manuel/taze/releaseHeld yolu
  hedef=qty korur. + regresyon testi (manuel N=3 < qty=5 → added=0). **DERS:** [[denetim-regresyon-dersleri]]
  tekrar doğrulandı — kendi guard/kilit düzeltmen yeni yol açar; her davranış-değişikliğinden sonra re-doğrula.
- **Panel rehberi:** `/guide` "Kullanım Rehberi" sayfası (14 bölüm — panel nasıl çalışır / site bağlama /
  ürün-stok / eşleme / sipariş-teslimat / inceleme kuyruğu / değişim-garanti / tedarik / stok düzeltme /
  müşteri / rapor / şablon-ayar / güvenlik / kısayol; hepsi gerçek rotalara bağlantılı) + sidebar
  "Yapılandırma" altında. **Sistem durumu: tam çalışır** (typecheck 3/3, entegrasyon 89/89 + yarış 2/2,
  deploy /health 200). Kodlanabilir mimari eksik yok; yalnız yapısal kapsam-dışı (fiyat senkronu/marketplace/abonelik).

**3. KAPSAMLI DENETİM (ROUND-3) → 19 BULGU DÜZELTİLDİ (commit bed499d, CANLI):** Kullanıcı "başka eksik
kaldı mı? tespit ettiğin gibi agent'larınla düzelt" dedi → daha önce DERİN denetlenmemiş alanlara odaklı
5-lensli workflow (27 ajan, bul→çekişmeli doğrula): queue/cron-işler · güvenlik/crypto/public-uç · mail/
notif/AI · tedarik/müşteri/rapor · kalan-UX-tutarlılık. **19 doğrulanmış / 3 çürütülen.** 5 paralel işçiyle
(hepsi disjoint dosya) düzeltildi. **Migration YOK.**
- **Queue/işler:** webhook başarısız işleri `removeOnFail`'siz → Redis sınırsız büyürdü; +removeOnFail 5000
  (webhook.emit + ops.replayOutbox + global defaultJobOptions) · 5 tekrarlı sweep `queue.add(repeat)` →
  `upsertJobScheduler` (stable schedulerId: daily-digest/expiry/low-stock/reconcile/security-scan) → interval/
  cron değişince orphan çift-zamanlama yok (daily-digest çift Telegram/alarm düzeldi) · reconcile kritik alarm
  12s dedupe (15dk spam → tek uyarı; logger.error her sweep korunur — low-stock deseni).
- **Güvenlik/AI:** readonly-sql denylist +api_key_enc/code_hash/payload_suffix_hash · admin login lockout
  per-account (`authfail:id:<user.id>`) → e-posta+kullanıcı adı 2× deneme bütçesi kapandı (bilinmeyen kimlik
  identifier-key'de, enumeration sızmaz) · AI triyaj müşteri `reason`'ını `scrubSecrets` ile maskeler
  (key/e-posta/telefon/uzun-alfnum → [GIZLENDI]) + birim testi.
- **Mail/şablon:** `resolve()` deterministik ORDER BY (createdAt desc) + `product_id IS NULL` (site-geneli +
  global varsayılan) tier'leri onurlandırır (dead-config düzeldi) · DeliveryTemplatesService paylaşılan
  `createMailTransport`'a geçti (SMTP drift kapandı).
- **Tedarik/rapor:** tedarikçi karnesi maliyeti para-birimi başına dizi (karışım yok; admin per-currency
  render) · stok düzeltme zayi qty voidlenen item'dan türetilir (void/damage: tek→1, MAK→kalan kapasite) ·
  recall MAK kapasiteyi sayar (sabit 1 değil) · `recallBatch` FOR UPDATE (TOCTOU idempotent, çift audit yok) ·
  aylık maliyet `batches.received_at` (teslim ayı) ile bucketlanır.
- **UX (kalan ham enum):** /security `quota_review` · /notifications `digest_alert`+`reconcile_violation`
  (ölü `daily_summary` kaldırıldı) · /sites tip enum · /ai kategori/öncelik Türkçeleşti (labels.ts
  +siteTypeLabel/aiCategoryLabel/aiPriorityLabel; security/notifications yerel map+facet) · /guide h1→h2 (a11y).
- **Doğrulama:** typecheck shared+api+admin temiz · AI birim 11/11 · VPS entegrasyon+yarış · deploy /health 200.
  Çürütülen 3 (yanlış-pozitif/bilinçli): webhook seq ms-çakışması · security dedupe TOCTOU · updates Host-header.

**MÜŞTERİ HİYERARŞİSİ + 5-LENS DENETİM (commit 04f8f5f + 712e328, CANLI + deploy + entegrasyon 89/89 + yarış 2/2):**
Kullanıcı "müşteriler bölümünü site → müşteri hiyerarşisine göre düzenle (çok site = karışıklık); ayrıca tüm sistemi
kontrol edip eksikleri düzelt" dedi → (a) hiyerarşi + (b) 5-lensli genel denetim (bul→çekişmeli doğrula).
- **(a) Site → müşteri hiyerarşisi (04f8f5f, migration YOK):** müşteriler global e-posta bazlı kalır (etiket/not per-email);
  YENİ site boyutu SUNUM katmanında. `customers.list({search?, siteId?})` — siteId verilince YALNIZ o sitenin müşterileri +
  o siteye kapsanmış sipariş/atama/değişim sayıları (koşullu WHERE + kapsam alt-sorgu süzgeçleri); global görünüm
  `array_agg(DISTINCT st.domain)` ile "Siteler" kolonu döner. `/customers` üstünde aranabilir **site süzgeci** (Combobox,
  `?site=<id>`) — daralınca "Siteler" kolonu gizlenir + açıklama siteye özelleşir; **site detayında** "Müşteriler" kartı
  (o sitenin ilk 8 müşterisi + "Tümünü gör"→`/customers?site=`). Tümü `?? []` savunmalı (api/admin deploy sapmasına dayanıklı).
- **(b) 5-lens denetim → 9 doğrulanmış bulgu (1 medium + 8 low), hepsi düzeltildi (712e328, migration YOK):**
  **[medium]** `completeLine` yan-etki bloğunda mail + webhook.emit TEK try/catch'te, mail ÖNCE → mail enqueue patlarsa
  webhook HİÇ çalışmaz → `order.fulfilled` outbox'a yazılmaz (kalıcı kayıp, /ops replay edilemez); İKİ AYRI try/catch'e
  bölündü (createOrder deseni). **[low×2]** `reports.velocity`+`products.detailVelocity` statü filtresiz `sum(a.units)` →
  iade (revoked) + değişimde geri alınan atama satış sayılıyordu (çift-sayım/şişik tükenme tahmini); FILTER'a
  `status IN ('active','suspended','expired')` (reconcile ile tutarlı). **[low]** `stock.preview` iptal (canceled) satır +
  incelemedeki (held) siparişi 'karşılanacak talep' sayıyordu ama autoComplete doldurmaz → orders join + canceled=false +
  heldForReview=false. **[low]** `security.scanReplacementAnomaly` zaman-filtresiz tam-tablo group-by + assignments×talep
  çapraz çarpımı (15dk'da bir) → iki ayrı per-site CTE alt-sorgu (çarpım yok, approved 24s pencereli). **[low]**
  SentryExceptionFilter degraded /health 503'ünü her poll'da capture ediyordu (kesinti=Sentry sel) → sağlık probu hariç.
  **WP eklentisi: [high]** klon/staging guard sabit-tabanlı/el-ile kurulumda (ÖNERİLEN güvenli kurulum) KALICI no-op'ti
  (`wpteslimat_bound_home` yalnız "Panele Bağlan" akışında yazılıyordu, const install o akışa girmez → is_clone() hep false
  → klon canlı lisansı revoke/tüketebilir); taban çizgisi artık **aktivasyonda** yazılır + `WPTESLIMAT_BOUND_HOME` sabiti de
  onurlandırılır. **[low]** My Account okuma yolu klon guard'sızdı (klon GERÇEK maskesiz key gösterebilir) → render() başında
  is_clone() kısa devre. **[low]** `handle_bulk` panel YETKİLİ `held` bayrağını yok sayıyordu → toplu yenileme bayat rozeti
  temizlemiyordu; held=false ise meta silinir. **[low]** kuyruk-log budama cron'u yalnız aktivasyonda (WP güncelleme
  aktivasyonu tetiklemez) → `wpteslimat_init`'te yeniden kur. **Doğrulama:** typecheck+build temiz, api birim 31/31, VPS izole
  test DB **entegrasyon 89/89 + yarış 2/2**, api rebuild → /health 200 (db+redis). **NOT:** denetim workflow'unda 3 ajan
  "haftalık limit" ile düştü (admin-shape lensi + 2 doğrulama); kalan 9 bulgu tam doğrulandı, admin-shape lensi bir sonraki
  turda tekrar koşulabilir.

**MARKA SADELEŞTİRME — 1. AŞAMA (commit 49cf534, CANLI):** Kullanıcı "sabit 'jetlisans' adı kullanma" dedi →
önce YALNIZ kullanıcıya görünen metinler değişti (WP eklentisi görünen adı "WP Teslimat Eklentisi", menü
"Teslimat Eklentisi", sipariş-notu öneki "Teslimat:", mail fallback 'Mağaza', örnek site_name 'ornek-site.com').

**TAM YENİDEN ADLANDIRMA — 2. AŞAMA (CANLI):** Kullanıcı "jetlisans ile alakalı HİÇBİR ŞEY kalmasın; sistematik
proje adları kullan" dedi → iç tanımlayıcılar dahil TÜM `jetlisans` kaldırıldı (402 atıf / 74 dosya). **İki
sistematik ad:** (a) **panel** paketleri `@jetlisans/*` → **`@lisans/*`** (kök paket `jetlisans`→`lisans-panel`,
tüm import/config/Dockerfile/CI/lockfile); (b) **WP eklentisi** her tanımlayıcı `jetlisans`/`JETLISANS`/`Jetlisans`
→ **`wpteslimat`/`WPTESLIMAT`/`Wpteslimat`** (klasör `apps/wp-plugin/wpteslimat` + ana dosya `wpteslimat.php`,
sınıf/fonksiyon/sabit/option/cron/meta prefiksleri, text-domain `wpteslimat`, REST ns `wpteslimat/v1`, updater slug,
DB tablosu `{prefix}wpteslimat_queue`). Panel<->eklenti slug/filename senkron (`updates.controller` slug `wpteslimat`).
DB kimlik ŞABLONLARI (.env.example/CI/drizzle default) `jetlisans`→`lisanspanel`; MAIL_FROM `Lisans Paneli
<teslimat@localhost>`. **GERİYE DÖNÜK UYUM (mevcut kurulumlar kopmaz):** (1) eklenti eski `JETLISANS_*` wp-config
sabitlerini yeni `WPTESLIMAT_*`'a köprüler (define-if-not-defined); (2) tek-seferlik göç eski `{prefix}jetlisans_queue`
tablosunu + `jetlisans_*` connect-option'larını yeni adlara taşır (`plugins_loaded` öncelik 5, sürüm option'ıyla
korunur); (3) webhook alıcı eski `jetlisans/v1/webhook` REST rotasını da AYNI işleyiciye bağlar (panelde kayıtlı eski
webhook_url 404 yemez). **NOT (bilinçli kalan):** yalnız `wpteslimat.php` içindeki uyum köprüsü + göç kodu eski
`jetlisans`/`JETLISANS` adlarını referans eder (mecburen — eski kurulumları okur). Kod tabanının geri kalanında sıfır
`jetlisans`. Prod DB adı/kimlikleri `.env`'de olduğu gibi kalır (deploy git ile gelir, `.env`'e dokunmaz).

**YAYIN YÖNETİM SİSTEMİ + DEV ORTAMLARI (commit 8f2dee1→60d46bf, CANLI):** Kullanıcı "gerçek yazılım
şirketi gibi, sürüm-bazlı, güncelleme geçmişi görünür, sohbet hafızasından bağımsız sistematik bir
yayın/dağıtım sistemi + izole dev" istedi. Kuruldu (4 parça). **SÜRECİN TEK KAYNAĞI: [[release-deploy-sistemi]]
+ `docs/RUNBOOK-RELEASE.md`.**
- **(A) Repoda kalıcı geçmiş:** `CHANGELOG.md` (SemVer, root paket 0.0.0→**1.0.0**) · `docs/DEPLOY-LOG.md`
  (prod dağıtım geçmişi — ne/ne zaman/hangi sha) · `docs/RUNBOOK-RELEASE.md` (adım adım yayın rehberi).
- **(B) Tek-komut araçlar (hepsi `scripts/`, exec bit 100755):** `deploy.sh` (panel→prod: git pull+build+
  up+/health+**otomatik rollback**+ham log; VPS'te çalışır, **sahada doğrulandı** — admin dağıtımı /health 200) ·
  `release-plugin.sh` (eklenti: sürüm artır+`git archive` zip+panele publish) · `wp-dev.sh` (yerel WP dev) ·
  `dev-stack.sh` (VPS izole dev: up|wp|down|status).
- **(C) Panelde görünür sürüm yönetimi:** admin **`/releases` (Sürümler)** — eklenti sürüm geçmişi tablosu +
  yeni sürüm yayınlama formu (zip→base64→`POST /v1/admin/updates/plugin`). Backend zaten vardı; UI + sidebar eklendi.
- **(D) İZOLE DEV/STAGING (VPS, prod'a DOKUNMAZ, CANLI+doğrulandı):** ayrı proje `-p lisansdev` → ayrı
  container/ağ (`lisansdev_default`)/volume; ayrı `/opt/lisans-dev` klonu + `.env.dev` (dev sırları, auth KAPALI) →
  ayrı DB (`lisansdev`). `docker-compose.dev.yml` (localhost 3002/3006, Caddy'siz) + `docker-compose.wp.yml`
  parametreleştirildi (PANEL_NETWORK/WP_SITE_URL/WP_BIND). Dev API :3002 /health OK, prod :443 /health 200 (etkilenmedi).
  Dış erişim: SSH tüneli veya prod Caddy'ye dev alt-alan adı (henüz eklenmedi — istenirse).
- **İki dağıtım hedefi:** panel (git→prod, `deploy.sh`) vs WP eklentisi (git→müşteri siteleri, `release-plugin.sh`+updater).
  Dev'in VERİSİ prod'a GİTMEZ — sadece KOD git ile terfi eder.

**PANELDEN DAĞITIM YÖNETİMİ (CANLI, migration 0021):** Kullanıcı "sh ile elle değil, panelden görüp
yönetmek" istedi → admin **/deployments (Dağıtımlar)**: canlı sürüm + sağlık + dağıtım geçmişi (salt-okunur)
+ owner'a özel "Prod'a dağıt" (API/Admin/ikisi). **Mimari (güvenli):** panel yalnız `deployments` tablosuna
bir **istek** yazar (`POST /v1/admin/deployments`); VPS host'undaki `scripts/deploy-runner.sh` (cron, flock,
jq) bekleyeni **atomik claim** eder (`POST .../claim`, FOR UPDATE SKIP LOCKED), `deploy.sh <target>`'ı çalıştırır,
sonucu (success/failed + SHA + log) `PATCH .../:id/finish` ile yazar. **Panel konteynerine Docker soketi
VERİLMEZ** (konteyner→host tam erişim riski) — istek/çalıştırma ayrımı bu yüzden. Aynı anda TEK aktif dağıtım
(request 409'lar); runner çökerse 30dk'dan eski "running" server-side otomatik "failed" (kilit açılır, self-heal).
Owner-only Next katmanında (`isOwner()`); auth kapalıyken panel zaten açık. İlk yayın SSH+deploy.sh ile; sonrası
panelden. `DeploymentsModule` app.module'e eklendi. Kurulum: `docs/RUNBOOK-RELEASE.md` §A2.

**TESLİMAT-HAZIRLIK DENETİMİ → 16 BULGU DÜZELTİLDİ (commit ada9e12, CANLI):** Kullanıcı "kalan sorunları
tespit et + düzelt, dağıtımı iyileştir, WordPress performansını optimize et, eklenti bağlantılarını yap,
teslimata hazır hale getir — ekibinle" dedi → 5-lensli çekişmeli-doğrulamalı workflow (deploy / wp-perf /
wp-connect / genel-boşluk / wp-doğruluk; bul→sentez): 24 ham → **16 CONFIRMED (2 yüksek-bloker) + 1 DUBIOUS**
(elle-deploy geçmişi = bilinçli). Çekirdek lisans-teslimat yolu SAĞLAM; blokerler yalnız yeni dağıtım
araçlarındaydı. **Migration YOK** (advisory-lock mevcut tablo; webhookUrl mevcut `sites.webhook_url` kolonu).
- **Dağıtım [YÜKSEK]:** `deploy.sh` rollback `git checkout <sha>` → **detached HEAD** bırakıp SONRAKİ tüm
  deploy'ları `git pull --ff-only`'da kilitliyordu → dala BAĞLI `git reset --hard` + boot'ta detached self-heal;
  ayrıca build/up hatası da (yalnız sağlık değil) rollback tetikler; **admin runtime health probu** (admin-only
  deploy artık doğrulanır, auth-ON 3xx sağlıklı sayılır); renk kodları yalnız TTY'de (runner logu/panel kirlenmez).
- **Dağıtım [YÜKSEK]:** `deploy-runner.sh` deploy çıktısını göndermeden **jq içinde 20000 char'a** kısaltır
  (>200KB build logu `finish`'i 400'leyip başarılı deploy'u 'stuck/failed'+30dk kilit yapıyordu; jq codepoint
  slice UTF-8-güvenli); controller Zod cap servis `.slice` ile hizalı; `deployments.request()` **advisory-lock**
  (çift-tık iki 'pending' üretmez).
- **Sürüm:** `apps/api`+`apps/admin` **0.0.0→1.0.0** (health/deployments/settings artık doğru; admin kendi
  package.json'ından okur). **Eklenti bağlantısı:** `onboarding.claim` artık `webhookUrl` (host-doğrulamalı)
  kabul edip `sites.webhookUrl`'e yazar → connect-KOD akışıyla kurulan sitede geri-kanal webhook GERÇEKTEN
  gönderilir (eskiden NULL→sessiz atlama); WP `handle_connect` kendi `rest_url`'ini yollar; testConnection
  null-webhook 'beklemede' (yanlış-yeşil önlendi).
- **WP performans (kullanıcı isteği):** `order-sync` push/revoke/resync **Action Scheduler ile ARKA PLANDA**
  (checkout thank-you / ödeme-callback / admin isteği 15sn BLOKLANMAZ; AS yoksa senkron fallback; idempotency
  `_wpteslimat_pushed/_revoked` + klon guard + resync $syncing korunur); render OKUMA yolları (my-account+metabox)
  **5sn** timeout (sır → cache YOK, §7). **WP doğruluk:** `is_clone()` **şema-bağımsız** (HTTP→HTTPS geçişi klon
  sanılıp sipariş durmuyordu); guest 'Sorun Bildir' **order_key** ile yetkilendirilir (eskiden guest checkout'ta
  hep 403); updater changelog `sections`'tan; 'unmapped' Türkçe etiket; `.env.example` `API_URL`/`PUBLIC_API_URL`.
- **Doğrulama:** typecheck api+admin temiz · **PHP-lint 9/9** (throwaway php:8.2 container) · VPS izole test DB
  **entegrasyon 94/94** (2 yeni onboarding webhookUrl persist+host-validation) **+ yarış 2/2** · yeni `deploy.sh`
  ile prod dağıtım (admin probe SAHADA çalıştı) → `/health` 200 **v1.0.0** (db+redis ok), api boot hatasız.
  **DERS [[denetim-regresyon-dersleri]]:** yeni terminal-durum/araç eklerken (deploy rollback git-state, async
  offload) TÜM yolların ardışık davranışını gözden geçir; test DB'sini de prod migration seviyesine getir.

**§7 WP-PARİTE D2+D3 + PERF/GÜVENLİK/UX DALGASI → 5-LENS DENETİM (commit 74a53e6, CANLI + eklenti v0.4.0):**
Kullanıcı "kalan tüm dalgalar/eksikler için planla, takıma böl, hem panel hem eklenti UI/UX+perf+güvenlik en iyi
hale getir, testi+güvenliği denetle" (uyurken sürece başla) dedi → 5-lensli gap-analizi (WP-§7/admin-UX/perf/
güvenlik/test) + paralel ekip (P1-P4 işçi + W5 WP-D3) + 5-lensli çekişmeli denetim (bul→doğrula). **migration YOK.**
- **D2 meta box operasyon katmanı (§7):** yeni SITE-SCOPED HMAC uçları (mevcut reveal/replace/suspend/resend
  ADMIN_TOKEN'lı, WP çağıramıyordu) — `/v1/orders/:remoteOrderId/assignments/:aid/{reveal,replace,suspend,bonus}`
  + `:remoteOrderId/resend` + `:remoteOrderId/admin-view`; her uç ÖNCE hedefin çağıran siteye ait olduğunu
  doğrular (assertAssignmentInSite: remoteOrderId+siteId birlikte → çapraz-site 404); actor `wp:kullanıcı@site`
  (WpActor decorator, x-wp-actor yalnız audit, yetki site-HMAC'te). WP metabox TAM yeniden yazıldı: key-bazında
  Göster (loglu, **yalnız manage_options** → shop_manager açamaz, §7 rol→scope) / Değiştir (sebepli) / Askıya
  al-Geri aç / +1 Bonus / Tekrar Mail (60sn) + **değişim geçmişi**; nonce + capability + is_clone her AJAX'ta.
  bonusAssign: **AYRI sentetik order_line** (remoteLineId `bonus:<uuid>` → Woo asla göndermez) → reconcile/
  syncRefunds bonusu görmez (qty şişirme YOK). "Farklı ürünle değişim" bilinçli panelde (Woo kalemi senkron kalsın).
- **D3 eşleme kutusu + filtre + bundle:** site-scoped `/v1/site-mappings` (katalog/liste/upsert/sil; upsert
  advisory-lock → null-varyasyon çift-satır kapandı, fiyat/sır DÖNMEZ). WP ürün-düzenleme "Panel Eşlemesi" kutusu
  + sipariş listesi panel-durum filtresi (klasik restrict_manage_posts + HPOS; webhook durumu artık
  `_wpteslimat_panel_status`'a da yazılır → filtre webhook-teslimatını da bulur). **Bundle/Composite: TÜM kalemler
  push edilir** — teslimat kararı panel eşlemesine bırakıldı (konteyneri koşulsuz atlamak, konteyner lisans
  taşıyorsa SESSİZ EKSİK-TESLİMAT üretiyordu → denetimde yakalandı, kaldırıldı).
- **P1 admin UX:** ham enum sızıntıları (Ctrl+K/import-stock/pending), (ops.)→(opsiyonel), PO/stok-adjust label
  tek-kaynak (supplyStatusLabel), /sites çift site-oluşturma akışı birleştirildi (sihirbaz kanonik), Field/
  FormSection uygulandı (create-site/po-forms/wizard), 9 segmente loading/error, deployments savunmalı.
- **P2 perf (migration-free query-rewrite):** getDeliveries Promise.all (WP render 4→1 round-trip), customers.list
  CTE (korele olmayan tam-tablo agg kapandı; **LIMIT denetimde kaldırıldı** — istemci-arama 200+ müşteride eskiyi
  "yok" gösteriyordu), reports.velocity 30g WHERE, dashboard.lowStockCount tek-geçiş.
- **P3 güvenlik:** readonly-sql (§15, AI varsayılan-KAPALI) — **tablo denylist** (admin_users/site_connect_tokens)
  + **dönen-tip guard** (composite/json/jsonb/xml/record OID reddi; enum typtype='e' MEŞRU geçer) + genişletilmiş
  fonksiyon denylist → çıplak-composite `SELECT t`/`*_to_xml`/`array_agg` bypass kapandı; replacements.create
  yabancı assignmentId order-scope'a bağlandı (latent siteler-arası revoke kapandı).
- **5-lens çekişmeli denetim → 3 CONFIRMED HIGH + 2 MED (hepsi düzeltildi):** **[H1-sınıfı]** suspend() koşulsuz
  'active' yapıyordu → revoked/replaced key YENİDEN teslim (bedava lisans/over-deliver); artık YALNIZ active↔
  suspended (atomik UPDATE WHERE) + siteReveal terminal-durum kapalı. **[H]** bundle sessiz eksik-teslimat
  (yukarıda). **[H]** readonly-sql bare-composite bypass (yukarıda). **[M]** bonus qty şişirme→reconcile revoke
  (ayrı satır). **[M]** customers LIMIT (kaldırıldı). **DERS [[denetim-regresyon-dersleri]]:** yeni durum-geçiş
  ucu (suspend) eklerken TÜM terminal durumları guard'la — H1 sınıfı 3. kez tekrar etti (deploy-öncesi denetim yakaladı).
- **Testler:** +6 dosya (sync-refunds/stock-import/admin-users.auth/held-refund.race/reports.velocity + metabox-ops
  scope+bonus-invaryant). **Doğrulama:** typecheck+build (shared+api+admin) temiz · VPS izole test DB
  **entegrasyon 114/114 + yarış 3/3** · PHP-lint 11/11 · deploy /health 200 v1.0.0 (tüm yeni rota map'lendi) ·
  eklenti v0.4.0 panele publish (201). **migration YOK** (şemaya dokunulmadı; mevcut tablolar kullanıldı).

**§7 PER-LINE LİSANS + KART UI YENİLEME (commit 811df48→48513d7, CANLI + deploy + eklenti v0.5.0):**
Kullanıcı "lisanslar sağdaki uzun metabox yerine her ürünün SİPARİŞ KALEMİ altında görünmeli (çok
ürünlü sipariş = karışık liste); ürüne göre değiştir/bonus; daha kolay/düzenli olsun" dedi → iki dalga:
- **811df48 (per-line + 16 WP denetim):** panel admin-view her atama/geçmiş için `remoteLineId` döner →
  WP `woocommerce_after_order_itemmeta` ile lisansları o ürünün kalemi altında gruplar; **+1 Bonus
  ürün-bazlı** (ayrı sentetik satır `bonus:<item>:<uuid>` → reconcile/syncRefunds bonusu görmez, qty
  şişmez); **kritik iade düzeltmesi** (collect_lines NET adet → re-sync iade edilen birimi yeniden teslim
  etmez; syncRefunds `remoteProductId` gönderir → panel `resolveBundleQty` ile bundleQty ölçekler, aşırı-
  revoke kapandı). Yeni site-scoped HMAC uçları: `/lines/:remoteLineId/bonus`. Sağ metabox inceldi
  (yalnız durum + Tekrar Mail + bağlanmayan atamalar).
- **48513d7 (kart UI/UX yenileme — SAF SUNUM, backend değişmedi):** her ürün kendi KARTINDA — başlık
  özet sayaç ("N lisans · X aktif · Y askıda"), renkli durum rozetleri, ikonlu + hiyerarşik butonlar
  (nötr Göster / mavi Değiştir / amber Askıya al / yeşil Geri aç), ürün-bazlı "Bonus Ekle" alt aksiyonu,
  katlanır değişim geçmişi (`<details>`); **5+ anahtarda kart kaydırılır** (`wpt-keys--scroll`, max-height
  ~232px) → çok anahtarlı üründe sipariş ekranı asla uzamaz. İptal/değiştirilen anahtarda aksiyon butonu
  görünmez (suspend guard'la tutarlı). Sınıf-tabanlı stil sayfada bir kez basılır; dashicons ikonlar.
- **Doğrulama:** PHP-lint temiz; dev sipariş #17'de gerçek render tarayıcıda doğrulandı; VPS izole test DB
  **entegrasyon 115/115 + yarış 3/3** (per-line/bonus/held/refund/TOCTOU/ABBA dahil); prod deploy.sh api+admin
  (rollback'li) → /health 200 v1.0.0; eklenti v0.5.0 panele publish (201, id 411e750b). **migration YOK.**

**SİPARİŞ DETAYI + DESTEK AKIŞI UX/CORRECTNESS DALGASI (commit 1a0d219, CANLI + deploy + eklenti v0.5.1):**
Kullanıcı "'order.fulfilled' anlaşılmıyor; sipariş detayı karışık, iptal lisanslar listede; değişim geçmişi
gizlenmeden açık görünsün; support'tan 'değiştir' dediğimde siparişte görünmüyor; tüm eksikleri deneyimleyip
düzelt" dedi → somut düzeltmeler + 4-lensli çekişmeli denetim workflow'u (32 ajan, bul→doğrula, **23 bulgu**).
Migration YOK (tümü okuma/sunum). Paralel: 3 ayrık-dosya işçi (WP / replacements / tutarlılık) + merkezî
order-detail zinciri. **Dev'de canlı uçtan-uca deneyimlendi** (SSH tünel + gerçek approve).
- **Sipariş detayı (/orders/[id]):** aktif vs iptal/değiştirilen/expired atama ayrımı (katlanır "Geçmiş");
  ürün adı (detail() products JOIN — satır+atama); başlıkta site domain (sites JOIN); held uyarı bandı +
  /review linki + held/canceled satırda "Kalanları Ata" gizli; **"Kalanları Ata" added=0 dürüst raporlar**
  (eskiden hep "başarılı" — yanıltıcıydı); değişim geçmişinde **eski key TAM** (key-tipi ölü key; account
  secret maskeli, `oldValue`); revoke sebep sorar; askıdaki atama doğrudan iptal.
- **Destek↔sipariş:** sipariş detayına "Değişim/Destek Talepleri" kartı (backend detail() `replacements`;
  inline Onayla/Reddet — `approveReplacementForOrderAction` order+/support revalidate) + /support link;
  /support Sipariş No → siparişe link. **replacements.approve TOCTOU:** advisory-lock + tx FOR UPDATE
  re-check → çift-tıkta "Talep zaten çözülmüş" (409), sahte "stok yok" DEĞİL; onayda `enqueueReplacementNotice
  ('approved')` (reject/info simetrisi); requestInfo `@AdminActor`.
- **WP (v0.5.1):** webhook notu ham event→Türkçe cümle (`human_note`); revoke sebebi `wc_get_order_status_name`;
  push/revoke/refund başarısızlığında sipariş notu (sessiz takılma bitti); metabox durum fallback'leri
  `order_status_label`'dan + 'unmapped'→'Ürün eşlenmemiş' + bonus i18n.
- **Tutarlılık:** StatusBadge `revoked`→'Geri alındı' (labels.ts tek kaynak); /orders faceti 'Geri alındı';
  customers/[email] paylaşılan StatusBadge.
- **Doğrulama:** typecheck 4/4 + PHP-lint temiz · VPS izole test DB **entegrasyon 115/115 + yarış 3/3** ·
  dev canlı: seeded talep→approve 201 (ATAMA 7→8, "onaylandı", eski key TAM görünür, "Değişim talebiniz" maili)
  + double-approve **409 "zaten çözülmüş"** · prod deploy.sh api+admin → /health 200 v1.0.0 · eklenti v0.5.1 publish.
  **DERS [[denetim-regresyon-dersleri]]:** yeni durum-geçiş ucu (approve) eklerken advisory-lock ekle (TOCTOU);
  istemcide backend added/status'unu yut**ma** (sessiz no-op yanıltıcı "başarılı" üretir).

**UI/UX DALGASI 2 — sipariş detayı cila + panel-geneli kompakt + KARANTİNA ekranı + ultracode denetim
(commit 8242c2b→46741ee, CANLI + prod deploy 46741ee):** Kullanıcı sipariş detayı üzerine ardışık geri
bildirim verdi (kartlar hâlâ büyük/karışık; Göster ayrı satır; site+Woo id belirgin değil; sonra: ikon-only
butonlar anlaşılmıyor → etiketli olsun; admin girişliyim, maskeleme yapma; değiştirilen eski anahtarları
nerede saklıyorsun; geçmiş satırında sebep; çok üründe kart rengi farkı) + "projeyi kapsamlı değerlendir,
agent'larınla çöz". İki analiz ajanı + 4 disjoint işçi (kompakt panel) + 5-parça sıralı workflow (analiz→
uygula→3-lens adversaryel doğrula) ile yapıldı. **migration YOK.**
- **Sipariş detayı yerleşim:** 2-kolon (sol geniş ürünler+lisanslar, sağ dar rail destek+mail+timeline);
  başlıkta **Site + WooCommerce sipariş no belirgin çipler**; aksiyonlar önce ikon-only'ye indi sonra
  kullanıcı isteğiyle **etiketli+ikonlu** butona geri döndü; çok ürün kaleminde **kart sol-kenar aksan
  rengi** (chart paleti, yalnız >1 ürün); "Geçmiş" satırında en sağda **iptal sebebi** (audit_log.meta).
- **MASKELEME KALDIRILDI (kullanıcı isteği, güvenlik notu):** admin `detail()` artık düz `payload`+`fields`
  döndürür (Göster tıklaması yok); "reveal audit'e düşer" DEĞİŞMEZ kuralını korumak için her görüntülemede
  TEK `reveal` audit kaydı (per-key→per-view granülerlik). YALNIZ admin `detail()` maskesiz — WP My Account /
  müşteri `getDeliveries` §7 gereği MASKELİ KALDI. **Bağımlılık:** auth AÇIK olmalı (env-gate KAPALIykense
  panel zaten herkese açık — plaintext exposure auth'a bağlı, denetimde işaretlendi).
- **Panel-geneli kompakt:** yeni `StatStrip` primitifi (ince tek-satır özet şeridi) → tedarikçi/ürün/site/
  müşteri/satın-alma-emri detaylarındaki büyük StatTile ızgaralarının yerini aldı (ürün detayı 2-kolon + SKU
  çipi); Güvenlik/Bildirim ekranı `(§N)` iç-referans + İngilizce jargon temizliği + ham UUID yerine site domain
  (security.service leftJoin); inceleme kuyruğu kompakt dropdown; 8 UX düzeltmesi (PO formu Sheet'e, Dead-letter→
  "Başarısız İşler", "Teslim Edilen COGS"→"…Mal Maliyeti", AI anomali StatStrip, ayarlar tekrar-kart temizliği).
- **YENİ /quarantine (Karantina / Değiştirilen Anahtarlar):** "eski anahtarları nerede saklıyorsun" cevabı —
  `quarantined`/`voided` TÜM ölü anahtarlar tek DataTable'da (ürün, durum, anahtar, **kaynak sipariş linki**,
  müşteri, **sebep**, tarih). `listQuarantine()` + `GET /v1/admin/quarantine` (salt-okunur, migration YOK —
  license_items/assignments/assignment_history/audit_log/stock_adjustments okunur). key-tipi TAM düz (ölü key
  sır değil); account listede yalnız secret-olmayan alanlar (tam hesap kaynak siparişte). Sidebar "Sistem"→Karantina.
- **Adversaryel doğrulama (3 lens → 8 bulgu, hepsi düzeltildi):** [MED] voided (recall/void/damage) sebebi
  `stock_adjustments`'tan (eskiden hep '—') · MAK/multi voided leftJoin fan-out → licenseItem başına tek satır
  (dedup) · `assignedAt DESC NULLS LAST` + birleşik-zaman JS sıralaması (voided listeyi kaplamasın) · `detail()`
  audit-on-view try/catch (yazım hatası okuma yolunu 500'lemez) · account `fields=null` → ham JSON DÖKME (yer tutucu).
- **Doğrulama:** typecheck api+admin temiz · admin production build (/quarantine route dahil) · dev canlı:
  sipariş detayı **maskesiz** (0 mask char, 0 "Göster", tam key'ler) + `/quarantine` API **6 satır gerçek veri**
  (tam key, sebep, kaynak sipariş, sıralı) · prod deploy.sh api+admin (rollback'li) → **/health 200 v1.0.0**,
  quarantine route mapped, boot hatasız. **AÇIK SORU (kullanıcıya soruldu):** görüntüleme-audit'i kalsın mı,
  yoksa tamamen kaldırılsın mı (kullanıcı henüz yanıtlamadı; mevcut: kalıyor).

**PLATFORM-BAĞIMSIZ ETİKETLER + ÜRÜN EŞLEŞTİRME İYİLEŞTİRMESİ (commit d5c958c + ba19811, CANLI + eklenti v0.6.0):**
Kullanıcı iki şey sordu: (a) "sistem başka altyapılara da entegre edilebilir mi, WooCommerce sabit mi?" → çekirdek
zaten platform-bağımsız (jenerik HMAC `remote*` kontratı + tipli site kanalı), yalnız UI etiketleri Woo-sabitti →
nötrleştirildi (bkz [[platform-agnostik-mimari]]); (b) "ürün eşleştirmeyi daha iyi yap, doğruluğu belirsiz, neye göre
eşleşiyor?".
- **Platform-bağımsız etiketler (d5c958c):** sunum katmanı WooCommerce→"mağaza/satış kanalı"; sipariş detayı çipi
  `siteType`-farkında (detail() +siteType; woocommerce→WooCommerce / marketplace→Pazar yeri / reseller→Bayi / null→Mağaza);
  "Mağaza ürün ID" vb. WooCommerce yalnız gerçek platform adı olduğu yerde kaldı (tip label + dropdown + "hazır entegrasyon" notu).
- **Eşleştirme sistemi — nasıl çalışıyordu:** `site_product_mappings` = `(siteId, remoteProductId[, variation]) → productId +
  bundleQty`. Eşleme ELLE tanımlı ID→ID bağı; sipariş gelince `resolveMapping` (varyasyon-özel→ürün-seviyesi fallback, aktif,
  en-eski). Fail-safe: eşleme yoksa satır pending (yanlış teslim YOK). Zayıflık: elle ham ID → typo riski; panelin adı doğrulama
  yolu yoktu (push adı taşımıyordu).
- **İyileştirme (ba19811, migration 0022):** order_lines += `remote_product_id/remote_variation_id/remote_name` (additive,
  nullable). WP eklenti **v0.6.0** push'a `remoteName` (`$item->get_name()`) ekler → panel gerçek siparişlerden ürün adını
  ÖĞRENİR. `listUnmapped()` + `GET /v1/admin/mappings/unmapped` + YENİ **/mappings "Ürün Eşleştirme"** ekranı: gerçek
  siparişlerde gelmiş ama eşlenmemiş ürünleri ADIYLA gör → **tek-tıkla eşle** (site+remoteProductId+varyasyon gerçek veriden
  hidden input, ELLE ID YAZMA yok → typo riski biter; yalnız panel ürünü seçilir). **Doğruluk sertleştirme:** `createMapping`
  NULL-varyasyon çift-eşleme açığı kapatıldı (Postgres unique NULL'ı ayrı sayar) — advisory-lock `upsertSiteMapping` ile
  BİREBİR aynı anahtar (`site:remote:variation`) → panel-formu + WP-kutu iki yazar aynı kilitte serialize.
- **Adversaryel denetim (deploy-öncesi, 2 bulgu düzeltildi):** [MED] createMapping kilit anahtarı 'map:' önekiyle
  upsertSiteMapping'den farklıydı → çapraz-yazar dedup kapanmamıştı (anahtar birebir eşitlendi + 23505 catch) · [LOW]
  `remoteName` z.max(255) astral/emoji adda tüm siparişi 400'lerdi → transform-kırp + .catch(null) (kritik-olmayan ad siparişi
  ASLA reddetmez). Defect-değil doğrulanan: listUnmapped SQL varyasyon eşleşmesi resolveMapping ile denk, HMAC remoteName'i
  kapsıyor, createOrder tüm dallar. **Bilinçli kapsam-dışı:** eşleme sonrası ESKİ bekleyen unmapped sipariş otomatik teslime
  dönmez (mağaza resync gerekir; ileride eklenebilir).
- **Doğrulama:** typecheck api+admin+shared temiz · admin build · **dev E2E** (eşlenmemiş→tek-tıkla-eşle 201→listeden düştü→
  dedup 409) · PHP-lint temiz · migration 0022 prod (api boot auto-migrate) · /health 200 v1.0.0 · unmapped route 200 ·
  eklenti v0.6.0 panele publish (201). migration 0000-0022.

**PROAKTİF KATALOG SENKRONU + EŞLEME DEĞİŞTİR/KALDIR (commit b4ca486→10c20d9, CANLI + eklenti v0.7.0 + migration 0023):**
Kullanıcı "reaktif (sipariş gelince eşle) saçma — mevcut ürünleri sipariş BEKLEMEDEN adıyla seçip eşleyebilmeliyim;
ayrıca eşlediğim ürünü değiştirebilmeli/kaldırabilmeliyim; OTOMATİK EŞLEŞTİRME OLMAMALI (güvenlik) — elle seçeyim"
dedi. **Migration 0023** `site_remote_products` (mağaza ürün katalog SNAPSHOT'ı; ad/sku/tip/varyasyon — **SIR YOK**;
eşlemeler AYRI `site_product_mappings` tablosunda → katalog yenilense de kopmaz).
- **Katalog senkronu (WP→panel):** site-facing HMAC `POST /v1/site-mappings/catalog` — WP eklentisi mağazanın
  yayınlanmış ürünlerini TAM SNAPSHOT (delete+insert) gönderir. `remoteProductId/remoteVariationId` collect_lines
  ile BİREBİR türetilir (basit→get_id; variable→parent + her varyasyon) → katalog satırı sipariş satırıyla eşleşir.
  **Yalnız LİSTE gelir — otomatik eşleştirme ASLA yok; eşleme %100 elle (güvenlik).**
- **Panel proaktif eşleme (/mappings):** `GET /catalog/summary` (site picker: ürün sayısı+son senkron) + `GET /catalog?
  siteId=` (katalog + her ürünün eşleme durumu; DISTINCT ON = resolveMapping mantığı, varyasyon-özel>ürün-seviyesi,
  eşlenmemiş üstte). "Site Kataloğu" bölümü → site seç → TÜM ürünleri adıyla gör → sipariş beklemeden tek-tıkla eşle.
- **Eşleme DEĞİŞTİR/KALDIR:** `updateMapping` artık `{active?,productId?,bundleQty?}` kısmi güncelleme (productId→remap;
  (site,remote,varyasyon) anahtarı sabit → unique çakışma yok, lock gerekmez); yeni `DELETE /mappings/:id` (404 idempotent).
  Katalog eşli satırında **Değiştir** (MapProductSheet edit modu, mevcut ürün ön-seçili) + onaylı **Kaldır**. Kaldırınca
  ürün çözülmez (unmapped→pending, yanlış teslim YOK). listCatalog `mappingId` döner.
- **Tarama/tazeleme modeli (kullanıcı kararı: en stabil):** POLLING YOK; **olay-güdümlü** — WP `woocommerce_new/update/
  trash_product` → Action Scheduler ~3dk debounce+dedup (editör bloklanmaz) + WP manuel "Ürünleri Panele Aktar" butonu.
  **WP yük optimizasyonu:** run_sync katalog HASH'ini saklar; değişmediyse (yalnız stok/fiyat düzenlemesi) push'u ATLAR →
  gereksiz HTTP+yeniden-yazma yok. Manuel buton hash'i yok sayar (zorla tazele/kurtarma).
- **Adversaryel denetim (deploy-ÖNCESİ, 4-lens/9-ajan → 4 CONFIRMED low, 1 REFUTED; hepsi düzeltildi):** [advisory-lock]
  syncCatalog eşzamanlı aynı-site snapshot'ı serileştirmiyordu (çift satır/23505→500) → `pg_advisory_xact_lock(catalog:<siteId>)`
  (upsertSiteMapping deseni) · [boş-wipe] boş dizi kataloğu SİLİYORDU (uzunluk kontrolü DELETE'ten önceye alındı → boş=no-op) ·
  [limit] listCatalog LIMIT 2000<5000 kabul → LIMIT 5000 · [sayfa-boşalma] geçersiz ?site= tüm /mappings'i boşaltıyordu →
  katalog fetch ayrı try/catch + UUID guard · [WP 413] (refuted-security) büyük katalog gövde sınırını aşarsa anlamlı mesaj.
- **Doğrulama:** typecheck api+admin temiz · admin build · **dev E2E** (gerçek WP collector→HMAC push→snapshot; summary/catalog/
  unmapped; proaktif eşle 201→dedup 409; **varyasyon çözümü** parent→ürün-seviyesi/501→varyasyon-özel/502→fallback;
  remap 200; delete 200→404; **boş-push no-op** 3→3 satır wipe YOK) · migration 0023 prod boot auto-migrate.

**İŞ İSTASYONU PARTİSİ + 5-LENS DENETİM (commit 916080d→73062fe, CANLI + prod deploy, migration 0024+0025,
eklenti v0.8.0):** Kullanıcı uyumadan önce 13 maddelik liste bıraktı ve çok-ajan orkestrasyonuna açıkça izin
verdi. 5 backend + 6 UI + 3 düzeltme işçisi + 32-ajanlı çekişmeli denetim workflow'u ile yapıldı.
- **[ANA ŞİKÂYET] Bekleyen satır (§3/§4):** mağaza ürünü SONRADAN eşlenince eski siparişler "eşlenmemiş"
  kalıyor, "Kalanları Ata" no-op diyordu. Kök neden: teslimat motoru satırları `product_id` üzerinden tarar,
  eşlemesiz satırda o alan NULL → hiçbir sweep'e girmez. YENİ `orders/pending-lines.service|controller`:
  `GET /v1/admin/pending-lines` (gruplu özet + `mappedNow`), `GET .../diagnose/:orderId` (satır başına
  reason/action/message), `POST .../resolve` (geriye dönük uygula). `linkLine`: advisory-lock +`FOR UPDATE` +
  `productId` hâlâ NULL re-check (TOCTOU) · **canceled satır ASLA bağlanmaz** (H1) · **held sipariş teslim
  edilmez** · `fulfilledQty≠0` ise dokunmaz · teslimat NORMAL `completeLine`'dan geçer (all-or-nothing/held
  guard'ları bypass edilmez) · `fulfillment_events` `mapping_resolved` + audit `assign`/`meta.op=pending_resolve`.
  **OTOMATİK EŞLEŞTİRME YOK** — yalnız operatörün elle kurduğu aktif eşleme uygulanır. Eşleme kurulunca
  best-effort otomatik çalışır ("N satır bağlandı, M teslim edildi"). UI: `/mappings` "Eşleme Bekleyen Sipariş
  Satırları" paneli + sipariş detayında tanı şeridi (tek-tık aksiyon: Eşle/Uygula/İncele/Stok).
- **Yeni yüzeyler:** lisans envanteri (`GET/PATCH/DELETE /v1/admin/license-items`, sunucu sayfalama 25/50/100,
  ürün detayı + `/stock` "Son Eklenen Lisanslar", teslim edilen kalemde sipariş + **mağaza admin linki —
  SALT YÖNLENDİRME**, şablon `sites.admin_order_url_template` http(s)+`{orderId}` zorunlu) · **canlı iş
  istasyonu** (`GET /v1/admin/live` ETag/304 + TEK paylaşılan poller: 15sn, gizli sekmede DURUR, üstel geri
  çekilme, oturum bitince /login; SSE bilinçli REDDEDİLDİ) · bildirim çanı (ses varsayılan KAPALI, WebAudio —
  dosya/ağ YOK) · destek yazışması (iç not müşteriye gitmez) + suistimal sayacı · karantina CSV (Envanter
  menüsüne taşındı) · WP: işlemi yapan kullanıcı, "İptal"→**"Değiştirildi"**, ürün kalemi altında lisans kartları.
- **Denetim (5 lens/32 ajan, bul→çürüt): 23 doğrulanmış / 4 çürütülen — hepsi düzeltildi.**
  **[YÜKSEK]** destek yazışması HİÇ açılmıyordu: API `{messages:[...]}` sarmalı döndürürken istemci düz dizi
  sanıyordu → `.map is not a function` → /support + sipariş detayı error boundary'ye düşüyordu.
  **[ORTA] bundleQty ÇİFT ÖLÇEKLEME → bedava lisans** (`syncRefunds` eşlemesiz satırı da çarpıyordu, sonra
  `linkLine` bir kez daha) **+ ÖLÇEK KAYBI → canlı anahtar geri alınıyor** (eşleme pasifleştirilince ölçek
  sessizce 1'e düşüyor, resync satırı "aşırı teslim" sanıp müşterinin İADE ETMEDİĞİ anahtarlarını revoke
  ediyordu) → **0025 `order_lines.bundle_qty`** teslimat-anı anlık görüntüsü + ortak `resolveLineScale`
  (eşlemesiz→1 · anlık görüntü → o · canlı eşleme → o · **hiçbiri yoksa null ⇒ qty'ye DOKUNMA**). 3 regresyon testi.
  **[ORTA]** karantina listesi düz-metin anahtar döküyor ama `reveal` audit yazmıyordu → per-view audit ·
  `lowStockCount` her poll'da license_items TAM tarama (status JOIN'e taşındı + 60sn önbellek + tek-uçuş) ·
  envanter count+rows tek sorguya (`count(*) OVER ()`), status parametre-cast'i (kolon cast'i index'i
  öldürüyordu), `assigned_desc` LATERAL yerine kolondan · `consumeMultiUseCapacity` `assigned_at` yazmıyordu
  (MAK'ta teslim tarihi hep boş) → `COALESCE(assigned_at, now())` · destek kuyruğu 200 kayıtla SESSİZCE
  kırpılıyordu (sunucuda kapsam + uyarı bandı) · karantina CSV'si müşteri e-postası + tam anahtarı aynı
  dosyada birleştiriyordu (KVKK) → "Tedarikçi bildirimi" / "İç denetim" ayrımı.
  **[DÜŞÜK ×16]** replaceAssignment advisory-lock (revoke↔atama arasında son anahtar kapılırsa müşteri
  lisansını KALICI kaybediyordu) · pending-lines `orderCount` çift sayımı + `truncated` · `:id` ParseUUIDPipe ·
  site-facing yazışma OKUMA hız sınırı · WP: panel `replaced` bayrağı YETKİLİ (account'ta etiket hiç
  çıkmıyordu), aktör kalıcı meta yerine İŞE bağlandı (oturumsuz tetikte yanlış kişi yazılıyordu), `held`
  rozeti, kontrast AA, ağ-hatası mesajı · UI: yazışmada ardışık mesaj form reset, dürüst sonuç raporu, /notifications okundu durumu.
- **0025 (additive):** `order_lines.bundle_qty` + 5 sıcak-yol index (`license_items_created/status_created/
  assigned/batch_idx`, `replacement_requests_created_idx`).
- **Doğrulama:** typecheck api+admin temiz · admin build (tüm yeni rotalar) · **VPS izole test DB: entegrasyon
  124/124 + yarış 3/3** (6 yeni pending-lines + 3 ölçek regresyon testi) · PHP-lint 13/13 · **dev E2E:** gerçek
  eşlenmemiş sipariş (mağaza ürünü 18 "testo") tanı→çöz→teslim edildi, TEKRAR çalıştırma no-op (çifte teslimat
  YOK), sipariş 'fulfilled', olay zinciri `mapping_resolved`→`fulfilled`→`line_completed`, audit `pending_resolve` ·
  prod deploy.sh (rollback'li) → **/health 200 v1.0.0**, 0024+0025 uygulandı, 12 yeni rota mapped, boot hatası 0 ·
  eklenti v0.8.0 panele publish (201). migration 0000-0025.

**EŞLENMEMİŞ GÖRÜNÜRLÜK + GECİKME + KARANTİNA + MAĞAZA URL (commit d18e442, CANLI + migration 0026 +
eklenti v0.9.0):** Kullanıcı 4 şikâyet bildirdi; hepsinin kök nedeni dev'de GERÇEK veriyle ÖLÇÜLDÜ
(tahmin yok). 3 dalga paralel işçi + 5 lensli çekişmeli denetim (23 ajan → 32 doğrulanmış bulgu).
- **[1] Eşlenmemiş sipariş görünmüyor — İKİ ayrı sebep.** (a) Kayıp sipariş `wc-on-hold` (havale/EFT)
  idi; eklenti yalnız `processing`/`completed` dinliyordu → panele HİÇ push edilmedi. Ödenmemiş
  sipariş yine TESLİM EDİLMEZ (§2, değişmedi) ama mağaza listesinde **"Panele iletilmedi — ödeme
  bekleniyor"** etiketi + filtresi eklendi (sessiz kayıp bitti). (b) `GET /v1/admin/pending` yalnız
  `pending`/`partial` filtreliyordu → `unmapped` sipariş "Bekleyen Teslimatlar"da HİÇ görünmüyordu;
  artık dahil (ayrı limitler 200+100 → eşlemesiz sel eski siparişi pencereden düşürmüyor) + satır
  başına `hasUnmappedLine` + tek-tık "Eşleştir". **`unmappedOrders` SATIR-tabanlı oldu**
  (`product_id IS NULL AND canceled=false AND status IN ('pending','partial')`) — eski sayaç yalnız
  `orders.status='unmapped'` sayıyordu, o da ancak satırların HEPSİ eşlemesizse yazılıyor ve
  `recomputeOrderStatus` hiç üretmiyordu → **çok kalemli siparişte tek eşlemesiz kalem kaçıyordu**.
  Sayaç artık `/mappings` + `/pending` ile AYNI yüklem (üç ekran çelişmez). **ALARM TASARIMI:** pano
  kırmızı bandı GERÇEK TALEPTEN (`unmappedOrders`) türetilir; `unmappedCatalogProducts` **BİLGİ**
  sayacıdır ("eşlenmemiş ≠ eşlenmesi gereken" — katalog mağazanın lisans taşımayan ürünlerini de
  taşır; ondan alarm üretmek hiç sönmeyen bant + operatörü TEHLİKELİ catch-all eşlemeye iten baskı
  demekti). Varyasyon EBEVEYN satırı sayımdan+rozetten çıkarıldı (SQL üç-değerli mantık: varyasyon-özel
  eşleme ebeveyne asla eşleşmez).
- **[2] Gecikme — ÖLÇÜLDÜ: 41 sn → 0,6 sn.** Sipariş 13:07:22 `processing`, panele 13:08:03 düştü;
  geçmişte 12/27/30/65/75 sn. Kaynağın TAMAMI WP: Action Scheduler async loopback dispatch'i
  güvenilmez, iş wp-cron dakikalık kuyruğuna düşüyor, wp-cron ancak sayfa isteğinde koşuyor.
  **Panel suçsuz** (API 9-16 ms). Çözüm: iş, yanıt gönderildikten SONRA aynı istekte koşar
  (`fastcgi_finish_request` → `litespeed_finish_request` → ikisi de yoksa SINIRLI satır-içi:
  1 iş / 2 sn / yalnız push+revoke); AS güvenlik ağı KORUNUR. **REST DIŞLANMAZ** — WooCommerce'in
  varsayılan blok checkout'u (Store API) REST'tir, dışlansaydı düzeltme en yaygın yolda çalışmazdı;
  yalnız CLI + cron dışlanır. Atomik iş kilidi (`INSERT IGNORE`, `add_option` atomik DEĞİL) +
  satır-içi iş bitince kuyruktaki ikizin `as_unschedule_action` ile iptali (çift `/refund` + yanıltıcı
  "0 birim geri alındı" notu bitti). **Kilit alınamazsa SESSİZ VAZGEÇME YOK** → yeniden planlanır
  (takılı kilit AS ağını yutup siparişi KALICI kaybettirebiliyordu; TTL 300→60 sn).
- **[3] Karantina:** sunucu-taraflı süzgeç (durum · **tarih SQL'de** · tedarikçi · ürün · arama);
  `truncated` HAM SQL satır sayısından (eskiden süzme sonrasına bakıyordu → tam da liste eksikken
  uyarı kayboluyordu); indirme kapsam (görünen/tümü) + biçim (CSV/TXT) seçimli; KVKK ayrımı korundu
  ve "İç denetim" uyarısı artık **CSV'de de** var; arama debounce + önceden hesaplanmış hay string.
- **[4] "Mağaza panelinde aç" URL'i:** origin `sites.webhook_url`'den türetiliyordu — o adres
  makineden-makineye ve İÇ hostname olabilir (gerçek veri: `http://wordpress/wp-admin/...`); ayrıca
  HPOS yolu TAHMİN ediliyordu (HPOS kapalı + alt-dizin kurulumunda yanlış). Artık link YALNIZ
  mağazanın kendi bildirdiği şablonla üretilir (eklenti HPOS'u tespit edip `admin_url()` ile şablonu
  katalog senkronuyla bildirir; aktivasyon/güncelleme/günlük heartbeat tetikleri eklendi). Şablon
  yoksa **link GÖSTERİLMEZ** ("ya doğru olmalı ya hiç link olmamalı"). `buildStoreAdminUrl` TEK
  dosyaya toplandı (iki farklı kopya vardı) + iç/özel hostname reddi + `user:pass@host` reddi.
  **migration 0026** (additive) `sites.admin_order_url_template_manual` = şablon KAYNAĞI: elle giriş
  senkronla ezilmez, otomatik değer de kolonu kalıcı kilitlemez.
- **Yol boyunca kapatılan diğer bulgular:** `syncRefunds` KİLİTSİZ/transaction'sız read-modify-write'tı
  → eşzamanlı iki iade bayat `fulfilledQty` ile GEREKENDEN FAZLA atamayı geri alabiliyordu (müşterinin
  iade ETMEDİĞİ canlı anahtarlar ölür + partial-auto taze stokla doldurur = lisans yanması); artık
  advisory-lock (`hashtext(order.id)` — diğer sipariş-kapsamlı yazarlarla AYNI ad alanı) + tek tx +
  `FOR UPDATE`, tüm satır kilitleri döngüden ÖNCE (ABBA yok) · katalog hash'i `admin_url()` şemasına
  duyarlıydı (proxy arkasında her tetikte tam katalog DELETE+INSERT) → normalize · `hostMatchesSiteDomain`
  ÜST alan adını kabul ediyordu (çok kiracılıda komşu siteye link yazdırma) → yalnız aynı/alt alan adı ·
  `store-admin-url.test.ts` HİÇBİR vitest config'ine girmiyordu (`passWithNoTests` yüzünden sessizce
  0 test) → `src/orders/` altına taşındı, 14 test koşuyor.
- **Doğrulama:** typecheck api+admin+shared temiz · admin build · api birim **45/45** · VPS izole test
  DB **entegrasyon 124/124 + yarış 3/3** · PHP-lint **12/12** · **dev E2E ölçümlü** (mod_php'de 41 sn →
  0,6 sn, sipariş `fulfilled`; unmapped sipariş `/pending`'de `hasUnmappedLine:true`; üç sayaç tutarlı;
  `storeAdminUrl` önce `null` → katalog senkronundan sonra doğru HPOS linki, status `accepted`) ·
  prod migration 0026 (tracking 27) · `/v1/health` 200 v1.0.0 · eklenti v0.9.0 publish 201.
  migration 0000-0026.

**SİSTEM GENELİ TARAMA → 35 BULGU + 6 KENDİ-REGRESYON (commit ee59e14, CANLI + migration 0027 +
eklenti v0.9.1):** Kullanıcı "agent'larınla/işçilerle/workflow'larla sistemi genel tara, sorunları
bul-analiz-düzelt" dedi. 8 lensli keşif (mail-kuyruk-cron · auth/RBAC/proxy · stok/tedarik ·
müşteri-destek-güvenlik-KVKK · rapor/AI/readonly-sql · admin UI · WP eklentisi (dokunulmamış
dosyalar) · altyapı-şema-betik-test) + 4 çekişmeli doğrulayıcı (çürütmeye çalış) → **54 ham,
35 CONFIRMED, 19 çürütüldü**. 8 ayrık-dosya işçi düzeltti → 2 lensli re-doğrulama **6 KENDİ-regresyon**
buldu → 4 işçi kapattı → 3 işçi glue bağladı.
- **[YÜKSEK, CANLIDA KIRIKTI]** `/purchase-orders` + `/suppliers` sunucu eylemleri çalışmıyordu:
  `'use server'` dosyasından obje re-export'u (`export { initial as … }`). Next 15 guard'ı ÇALIŞMA
  ANINDA uygular → `next build` TEMİZ geçer, ekran tıklamada patlar. **9b81c9b'nin tekrarı**; önceki
  tarama metin grep'i olduğu için `export {}` desenini kaçırmıştı. Düzeltildi + **tip-tabanlı**
  `scripts/check-use-server.js` (TS checker; salt-tip export'ları eler, alias çözer) `pnpm typecheck`
  ve CI'a bağlandı, negatif kontrolle yakaladığı doğrulandı → 3. tekrar imkânsız.
- **[ORTA] QueueModule REDIS_URL'i parçalıyordu** (yalnız host+port) → parolalı/TLS Redis'te BullMQ
  NOAUTH alır ama `/health` "redis ok" der (o ayrı bağlantı) ve enqueue hataları best-effort
  yutulur → sipariş 201 döner, **teslimat maili + geri-kanal webhook + TÜM sweep'ler hiç çalışmaz**,
  sistem sağlıklı görünür. Tam URL'den kuruluyor.
- **[ORTA] /api/login** hız-sınırsız + `identifier` uzunluk-sınırsız + kilit KİMLİK başına (farklı
  identifier ile tamamen atlanıyordu) + **senkron scrypt tek event loop'u 60-100 ms blokluyordu**
  (aynı süreç sipariş teslimatını servis ediyor → ucuz istek seliyle teslimat yavaşlatılabiliyordu).
  IP kovası + `.max(200)` + sha256 anahtar + asenkron scrypt; sabit-zaman/enumeration davranışı korundu.
- **[ORTA] Değişim onayı atomik değildi**: revoke ve completeLine ayrı tx'lerde commit ediyordu →
  `added=0` olduğunda ESKİ anahtar çoktan karantinada (müşteri lisans kaybı); üstelik `added=0`
  "stok yok" DEMEK DEĞİL (SKIP LOCKED çekişmesi). `completeLine`'a opsiyonel `exec` eklendi, ikisi
  TEK tx'te → rollback revoke'u da geri alır. 409 mesajı "stok yok" ↔ "şu an atanamadı" ayrıldı.
- **[ORTA] `usageMode` multi→single** düzenlemesi MAK kapasitesini sessizce yok ediyordu (update
  şeması create refine'larını taşımıyordu) · **KVKK anonimleştirme** `security_events`'i atlıyordu ·
  **maliyet raporu** MAK'ta kapasite×anahtar-maliyeti çarpıyordu · **deploy-runner** kendi kilidini
  alamıyordu (cron flock + betik flock aynı dosya → panelden dağıtım HİÇ koşmuyordu) · **WP klon
  koruma tabanı** güncellemede kurulmuyordu (712e328'in tekrarı) · **DataTable araması** Türkçe
  İ/I'da sessizce sonuç bulamıyordu.
- **[ORTA] "Atanabilir stok" tanımı İKİ FARKLIYDI:** gerçek atama sorgusu süresi geçmiş kalemi
  dışlıyor, **11 sayım noktası** dışlamıyordu → dashboard/ürün listesi/rapor/düşük-stok alarmı/
  AI özeti/bayi katalog ucu/sipariş detayı "var olmayan stok" gösteriyordu; "neden bekliyor?" tanısı
  "stok var" derken teslimat 0 atıyordu. Hepsi `assignment/assign.ts` içindeki paylaşılan
  `notExpiredCond(alias)` yüklemine bağlandı. (Bilinçli istisnalar — recall/void yazma yolları ve
  parti satılmış/satılmamış ayrımı — koda gerekçesiyle yazıldı.)
- **migration 0027 (IDEMPOTENT, mevcut kurulumlarda TAM NO-OP):** drizzle meta snapshot'ı 0020'de
  kalmıştı (0013-0018 + 0021-0026 elle yazılmıştı) → `db:generate` aradaki HER ŞEYİ "yeni" sanıp
  yeniden yaratan bir migration üretiyordu; prod'a gitseydi `CREATE TABLE deployments` "already
  exists" ile **API BOOT ETMEZDİ** (auto-migrate boot'ta koşar). Snapshot hizalandı + 0025'in elle
  yazılan 5 index'i şemaya taşındı → `db:generate` artık **"No schema changes"**.
- **KENDİ-REGRESYONLAR (re-doğrulama yakaladı, hepsi kapatıldı):** bildirim mailleri BullMQ'ya
  taşınmış ama işleyiciye dal EKLENMEMİŞTİ → **hiç gitmiyordu** (5 deneme sonunda dead-letter) ·
  `allocatableCountForLine` süre koşulunu atlıyordu → değişimde SONSUZ "tekrar deneyin" ·
  **0027'nin journal `when` damgası 0026'dan KÜÇÜKTÜ → migration hiç uygulanmazdı** (elle yazılan
  migration'larda uydurma zaman damgası kullanıldığında bu tuzağa dikkat) · `/ops` düzeltmesi yarım
  kalmıştı (ölü metot + admin yeni alanları okumuyor + buton 400) · `products.update` guard'ı meşru
  MAK kapasite ARTIRIMINI de blokluyordu · `release-plugin.sh` yeni sürüm kontrolü commit'lenmemiş
  eklenti kodunu fark etmiyordu (git archive HEAD'den paketliyor).
- **Doğrulama:** typecheck api+admin+shared temiz · admin production build ✓ · api birim **56/56**
  (3 yeni mail-processor testi) · `check-use-server` 20 dosya / 65 export TEMİZ · VPS izole test DB
  **entegrasyon 131/131 + yarış 3/3** · PHP-lint temiz · `bash -n` betikler temiz · dev smoke:
  `/purchase-orders` + `/suppliers` **200** (önceden kırık), admin+api ERROR 0 · prod migration 0027
  (tracking 28) · `/v1/health` 200 v1.0.0 · eklenti v0.9.1 publish 201. migration 0000-0027.

**PANELDEN KAYNAKTAN SÜRÜM YAYINLAMA + KURULU SÜRÜM GÖRÜNÜRLÜĞÜ (commit 5a50809, CANLI, migration 0028,
eklenti v1.0.0):** Kullanıcı "sürüm ve dağıtımı sen gerçekleştir, panel üzerinde güncellemeler çalışmıyor gibi
anlayamadım" dedi. **Teşhis (ölçüldü, tahmin değil): iki ekran da KIRIK DEĞİLDİ** (dev'de ikisi de 200 render),
ama panelden uçtan uca **kullanılamıyordu** — `/releases` elde hazır `.zip` istiyordu (panelde paket üretilemez),
`/deployments` yalnız zaten push edilmiş kodu canlıya alıyordu. Ayrıca hangi mağazanın hangi eklenti sürümünü
çalıştırdığı panelde **hiç görünmüyordu**. 3 paralel işçi (API / betik / WP) + admin UI merkezî.
- **Kaynaktan yayınla (yeni birincil akış):** `/releases` → owner-only buton → panel yalnız İSTEK kaydeder
  (`deployments` kuyruğu, `target='plugin'`, `note`=changelog) → host runner `scripts/publish-plugin.sh` ile
  **repo HEAD'inden** paketleyip panele yayınlar. Panel konteynerine Docker/git yazma yetkisi VERİLMEZ (dağıtımdaki
  ayrımın aynısı). Aynı kuyruk → "aynı anda tek iş" güvencesi ikisini birden kapsar.
- **Neden VPS'te commit/push YOK (ölçüldü):** prod checkout'unda `git config user.email` **tanımsız** (commit düşer)
  ve HTTPS remote kimlik bilgisi yok (`push` → "could not read Username"); dahası yerel commit prod'u origin'den
  AYIRIR ve sonraki `deploy.sh`'ın `git pull --ff-only` adımını KALICI kırar. Bu yüzden `release-plugin.sh`
  (geliştirici makinesi: sürüm bump + commit) ile `publish-plugin.sh` (VPS: yalnız yayınla) **bilinçli AYRI**.
  Sürüm numarası formda GİRİLMEZ — kodda tanımlıdır → **"yayınlanan zip = HEAD"** invaryantı korunur.
  Elle `.zip` yükleme kurtarma yolu olarak "gelişmiş" altında kaldı.
- **Kurulu sürüm görünürlüğü:** eklenti **v1.0.0+** her imzalı istekte `X-Wpteslimat-Version` gönderir; HmacGuard
  imza doğrulandıktan SONRA, değer DEĞİŞTİYSE site kaydına yazar (her istekte UPDATE yok; fire-and-forget, hata
  isteği düşürmez). **Başlık İMZA KAPSAMINDA DEĞİL** (`x-wp-actor` ile aynı sınıf) → yalnız gösterim/telemetri,
  yetki kararı ASLA buna dayandırılmaz. `/releases` "Sitelerdeki kurulu sürüm": güncel / eski (vX mevcut) /
  bilinmiyor — "eski" damgası YALNIZ iki sürüm de bilindiğinde basılır.
- **migration 0028** (additive): `sites.plugin_version` + `plugin_version_at`, `deployments.note`. 0027'de
  snapshot hizalandığı için `db:generate` tam olarak bu 3 kolonu üretti. **DİKKAT (tuzak):** elle yazılan
  0021-0027 uydurma GELECEK zaman damgaları kullanıyor; drizzle-kit gerçek saati yazınca 0028'in damgası 0027'den
  KÜÇÜK çıktı → migration sessizce hiç uygulanmayacaktı (API var olmayan kolonlarla boot ederdi). Elle düzeltildi
  (`when` = 0027 + 10000). **Uydurma damgalar gerçek saati geçene (2026-08-05) kadar her yeni migration'da
  `when` elle kontrol edilmeli.**
- **Eklenti düzeltmesi:** panelde hiç yayın yokken uç `200 {}` döndürüyor, güncelleyici bunu "hata" sayıp 15dk
  negatif önbellek yazıyordu → "yayın yok" ile "panele erişilemedi" ayrıldı (kısa pozitif-boş önbellek).
- **Doğrulama:** typecheck 4/4 + `check-use-server` 20 dosya/66 export temiz · api birim 56/56 · admin production
  build · VPS izole test DB **entegrasyon 135/135** (4 yeni plugin-target testi) · PHP-lint 12/12 · prod deploy
  (rollback'li) → `/health` 200 v1.0.0, migration tracking 29, boot ERROR 0 · **panel yolundan v1.0.0 yayını
  uçtan uca kanıtlandı** (istek → cron runner claim → publish → success 42 sn; public update ucu v1.0.0, zip
  94.717 bayt) · **dev E2E:** sentetik daha yeni sürümde WP "GUNCELLEME VAR → 1.0.1" (güncelleme zinciri gerçekten
  çalışıyor; sonra temizlendi) + katalog senkronu sonrası dev panelde `plugin_version=1.0.0`. migration 0000-0028.
- **NOT (ortam):** prod panelde yalnız 1 test sitesi + 1 sipariş var; gerçek WooCommerce testleri **dev ortamında**
  (`dev-wp.167-233-108-12.sslip.io`) yapılıyor. Prod panele gerçek mağaza henüz bağlı DEĞİL.

**GELECEĞE-HAZIRLIK: DAYANIKLILIK + RETENTION + PERFORMANS (commit ed3850c, CANLI, migration 0029):**
Kullanıcı "tüm eksikleri düzelt, geleceğe hazırla, performanslı+güvenli, sistem asla sorun yaratmamalı,
stres testi + tablo" dedi. **Çok-ajanlı 41-öngörülü arıza-modu taraması + fault-injection** (dev izole
ortamda Redis/Postgres GERÇEKTEN kırılarak) ile sistemik açıklar kapatıldı. 4 disjoint-dosya işçi + entegratör.
**KÖK TEMA: hiçbir katmanda zaman aşımı yoktu** → backing servis degrade olunca istekler askıda kalıyordu
(ÖLÇÜLDÜ: Redis donunca push 12sn askı, PG advisory-lock'ta createOrder 50sn askı, /health bile yanıtsız).
- **A (dayanıklılık):** redis.module fail-fast (`commandTimeout` 2s + `enableOfflineQueue:false` +
  `maxRetriesPerRequest:1`; BullMQ AYRI null-retry bağlantısını korur). HMAC nonce Redis-DOWN'da
  **fail-CLOSED-FAST** (503, askı yok); rate-limit **fail-OPEN**; health `Promise.race` 2s → hızlı degraded.
  db.module `statement_timeout 30s`+`lock_timeout 10s`+`idle_in_transaction 60s`+`connect_timeout 10s`
  (postgres.js `connection` option — SET LOCAL 5s AI yolu etkilenmez). main.ts Fastify `requestTimeout 30s`.
  Redis `maxmemory 768mb+noeviction` (docker-compose; prod'a canlı CONFIG SET de uygulandı).
- **HMAC IP başarısızlık-tavanı (KRİTİK TASARIM):** IP limiti **YALNIZ auth-FAIL** (geçersiz api_key/imza)
  sayar — her istekte önce `peekOverLimit` ile "IP cezalı mı" bakılır (findForAuth DB lookup'ından ÖNCE),
  sayaç yalnız başarısızlıkta artar. **Meşru mağaza (imzası hep geçerli) ASLA kısıtlanmaz.** DERS: ilk
  tasarım "tüm istekleri say"dı; **stres testi ortaya çıkardı** ki bir mağazanın TÜM trafiği (push + katalog
  + tüm sunucu-taraflı lisans-görüntüleme fetch'leri) tek sunucu IP'sinden geldiği için yoğun meşru mağaza
  429 yiyordu → auth-fail-only'ye çevrildi. env `HMAC_IP_FAIL_LIMIT` (vars. 120).
- **B (retention, migration 0029 additive index):** `RetentionService` günlük batch-delete: fulfillment_events
  180g · outbox(delivered) 30g · security_events 365g · email_log 365g PII MASKELE+730g SİL (KVKK) · audit
  auto-reveal gürültüsü 90g (gerçek denetim KORUNUR). reconcile 30g pencere (`RECONCILE_FULL` ile tam). Sweep
  `@OnWorkerEvent('failed')` kritik alarm (sessiz ölüm bitti). `POST /v1/admin/maintenance/retention` manuel.
  **migration 0029:** fulfillment_events+email_log `created_at` index; snapshot hizalandı (`db:generate` "No
  schema changes"; spurious 0030 üretti — zaman-damgası tuzağı yine görüldü, temizlendi). env cömert varsayılan.
- **C (perf):** stok import `autoCompleteProduct(maxLines?)` cap 200 inline + kalanı BullMQ'ya (jobId dedupe) →
  büyük backlog import'u dakikalarca asmaz. Geriye-uyumlu (maxLines'sız = eski sınırsız davranış).
- **FAULT-INJECTION KANITI (dev, gerçek kırma):** Redis-down push 12sn→**503/4.5sn** + health hızlı degraded;
  PG-kilit createOrder 50sn→**500/10.5sn** + **/health 18ms** (cascade bitti). **STRES (dev, güncel ~5k sipariş):**
  okuma **652 istek/sn @300VU 0 hata** (regresyon yok); yazma no-wedge + meşru trafik artık 429 yemiyor.
- **Doğrulama:** typecheck+build temiz · api birim **56/56** · VPS izole test DB **entegrasyon 145/145 + yarış 3/3**
  (çifte-satış=0) · prod deploy.sh (rollback'li) → **/health 200 v1.0.0**, migration tracking 30, boot ERROR 0,
  0029 indeksleri canlı, retention ucu smoke OK. Yeni env hepsi opsiyonel+cömert varsayılan (.env.example). DERS:
  [[denetim-regresyon-dersleri]] — "kendi düzeltmen yeni yol açar" (rate-limit ilk hali meşru mağazayı 429'ladı,
  stres testi yakaladı → düzeltildi). migration 0000-0029.

**GÜVENLİK DENETİMİ + SIFIRDAN RE-AUDIT (commit c1e313e→ac4e10c, CANLI prod+dev, eklenti v1.0.1, migration YOK):**
Kullanıcı isteğiyle iki HARİCİ güvenlik-skill kütüphanesindeki (VoltAgent/awesome-agent-skills +
alirezarezvani/claude-skills) ilgili skiller **7-lensli çekişmeli-doğrulamalı workflow'a** dönüştürüldü
(her lens gerçek bir skille bağlı: threat-model / best-practices / insecure-defaults / constant-time /
wp-abilities / variant-analysis / dependency-auditor). 14 ajan → **14 doğrulanmış bulgu (1 HIGH + 1 MED +
12 LOW)**; hepsi düzeltildi, prod+dev'e deploy edildi, sonra **AYNI workflow sıfırdan yeniden koşuldu**
(bias'sız re-audit) — 14 bulgunun kapandığı doğrulandı + **1 SELF-REGRESYON yakalandı** (aşağıda) + kapatıldı.
- **[HIGH] publishRelease RBAC bypass → tedarik-zinciri RCE:** owner-olmayan admin `/releases` "Elle .zip
  yükle" ile TÜM müşteri sitelerine keyfi PHP taşıyan eklenti yayınlayabiliyordu (public updater oto-kurar).
  `isOwner()` guard + form owner-gate + API **`OwnerGuard`** (Next YAZMA çağrılarında `x-admin-role` iletir;
  plugin-publish/deployments/admin-CRUD owner-only — tek eksik UI kontrolü yükselemez).
- **[MED] reconcileOrder over-revoke:** advisory-lock'suz/çok-tx → eşzamanlı qty-azalt re-push'ta müşterinin
  İADE ETMEDİĞİ canlı anahtarlar yanıyordu. Tek advisory-lock'lu tx (syncRefunds deseni) + TAZE re-read +
  `already`-sayaç + canceled-satır skip. Aynı sınıf **bulkReplaceBatch atomikliği** (re-audit MED) da kapatıldı
  (approve/replaceAssignmentLocked deseni: added<=0 ⇒ rollback ⇒ eski key canlı).
- **[LOW×12] sertleştirme:** readonly-sql composite→text cast bypass (CAST_TO_SCALAR_RE) · CreateOrder DTO
  üst sınırları (DoS/int4) · onboarding webhook SSRF host (üst/ata alan reddi) · müşteri e-postası PII log
  maskeleme (KVKK pino serializer) · SESSION_SECRET/ADMIN_TOKEN min-24 fail-closed + `REQUIRE_AUTH` opt-in ·
  logout `tokenVersion` gerçek iptal + fail-open gözlem logu · Docker non-root (`USER node`) · `.dockerignore`
  özyinelemeli · `next`→15.5.22 + `nodemailer`→8.0.4 (drizzle CVE erişilemez→ertelendi) · **[WP W1]** updater
  HTTPS zorlama + paket-URL host/şema doğrulama (MITM RCE) + panel-client https guard.
- **RE-AUDIT SELF-REGRESYONU (yakalandı+kapatıldı):** `CAST_TO_SCALAR_RE` tanımlıydı ama `runSelect`'e
  `.test()` ile HİÇ bağlanmamıştı → `s::text` bypass'ı açıktı; build+typecheck yakalamadı, sıfırdan re-audit
  yakaladı. Ders [[denetim-regresyon-dersleri]] #17: yeni güvenlik sabiti/regex/guard'ın enforcement yolunda
  GERÇEKTEN çağrıldığını grep'le + regresyon testiyle doğrula; fix'i bağımsız re-audit'le re-doğrula.
- **Doğrulama:** typecheck 4/4 + check-use-server temiz · api birim 61/61 · admin build · VPS izole test DB
  **entegrasyon 149/149 + yarış 3/3** (+4 yeni: M1 over-revoke/canceled-skip + readonly-sql cast reddi) ·
  PHP-lint 12/12 · deploy.sh rollback'li (prod+dev) → /health 200 v1.0.0 · eklenti v1.0.1. **migration YOK**
  (tüm düzeltmeler kod/config/şema-nötr). **Kalan (kabul edilen LOW/by-design, raporlandı):** account-lockout
  DoS (anti-enumeration tasarım tercihi) · SESSION_SECRET boş=açık (belgeli env-gate, prod'da auth AÇIK +
  REQUIRE_AUTH eklendi) · webhook internal-host (dev/docker `http://wordpress` meşru kullanır → filtrelenmedi) ·
  `apps/admin/.env.local` canlı ADMIN_TOKEN (OPERATÖR rotasyonu gerekir — .dockerignore ile imaj sızıntısı kapandı) ·
  site-facing katalog tüm-ürün (owner-woocommerce için tasarım; reseller/marketplace kanalı zaten scope'lu).

**ODAKLI DENETİM — ADMIN + WP + WOOCOMMERCE (commit 0734b1c→5efffec, CANLI prod+dev, migration YOK):**
Kullanıcı isteğiyle üç alan (admin yönetimi / WP eklentisi / WooCommerce entegrasyonu) 5-lensli çekişmeli
workflow'la DERİN denetlendi → 12 bulgu (1 çürütüldü) + 2 KULLANICI KARARI. Hepsi düzeltildi + deploy.
- **[A1 — KULLANICI KARARI: owner-only düz-metin]** Sipariş detayı + lisans envanteri + ürün detayı düz
  lisans/parola artık YALNIZ owner'a; owner-olmayan 'admin' MASKELİ görür (getDeliveries disiplini).
  `AdminRole` decorator + `canRevealPlaintext` (rol SUNUM kararında; OwnerGuard yetki kararında) +
  `detail()`/`listLicenseItems` `reveal` param + `apiGet` actor+rol iletir. reveal audit yalnız GERÇEK
  düz-metin gösteriminde (owner). reveal + KVKK anonymize uçlarına API **OwnerGuard** [A3]. **NOT:** önceki
  "maskeleme yapma" kararı OWNER içindi; owner-olmayan admin maskeli — kullanıcı onayıyla değişti.
- **[A2]** sipariş-detayı görüntüleme audit'i artık gerçek admin'e attribute edilir (apiGet x-admin-actor).
  **[A4]** admin auth/hesap yaşam döngüsü (login/başarısız-login/create/disable/reset/remove) → `security_events`
  (brute-force /security'de görünür; type/severity serbest metin → migration YOK).
- **[C2 — KULLANICI KARARI: §2 invaryantı doğru]** MAK/multi İADE'de kapasite havuza DÖNMEZ
  (`revokeAssignment`/`revokePartialUnits` `returnMultiCapacity`; refund yolları [revokeOrderForSite +
  syncRefunds] `false`, re-assign [replace/adet-düşür/recall] `true`). markLineCanceled'dan AYRI param
  (syncRefunds markLineCanceled=false ama iade → false). Sessiz aşırı-satış kapandı. Süre-bitişi deseniyle simetrik.
- **[WP/Woo]** silinen ürünün sipariş satırı push+iade uzlaştırmasında ATLANMAZ (order-item ID'den türetilir,
  eksik teslimat + under-revoke önlendi) [C1]; reconcile'da sonradan eklenen kalem görünür uyarı olayı bırakır
  [C3]; `resolveBundleQty` tipi `Promise<number|null>` [C5]; order_key giriş yapmışta DOM'a gömülmez (misafir-only,
  handle() view_order fallback'i zaten var) [B1]; `plugin_info` download_link host/şema doğrulaması [B3].
- **Çürütüldü:** operatör mağaza ön-yüzünden BAŞKA müşterinin siparişini göremez (WooCommerce `view_order`
  sahip-özel meta yetki). **Doğrulama:** typecheck 4/4 · api birim 65/65 (canRevealPlaintext) · VPS izole test DB
  **entegrasyon 151/151 + yarış 3/3** (+2 C2 MAK-iade + güncellenen sync-refunds — davranış-değişimi testi) ·
  PHP-lint 12/12 · deploy.sh rollback'li → /health 200 v1.0.0. DERS [[denetim-regresyon-dersleri]]: kullanıcı
  KARARIYLA davranış değişince eski davranışı kodlayan testi güncelle (sync-refunds MAK).

**TAM TEST DOĞRULAMASI + ODAKLI EKSİK-GİDERME (CANLI prod+dev+WP v1.0.2, migration YOK):** Kullanıcı "tüm
projeyi test et, eksikler var ise güvenli+performans tamamla" dedi. Önce 86dcc22 sonrası hiç koşulmamış VPS
entegrasyon+yarış koşuldu (izole docker pg17+redis7+node22): **yarış 3/3, entegrasyon 157/157, birim 65/65,
build 3/3, PHP-lint 12/12, drift YOK**. Sonra **5 paralel denetim ajanı** (güvenlik/correctness/perf/WP/admin+
test) — güvenlik+WP+admin DOĞRULANMIŞ TEMİZ; kapatılan gerçek boşluklar: **[perf] SMTP fail-fast timeout**
(connect/greeting 10s + socket 20s; timeout kalkanının tek deliğiydi — yavaş relay tüm teslim maillerini
baş-bloklardı) + mail worker `concurrency:5`; **[correctness] `bulkReplaceBatch` soyağacı `newAssignmentId`**
(eşzamanlı değişimde yanlış-atama etiketi; yalnız denetim-izi, §2 etkilenmiyordu); **[test] `syncRefunds`
suspended kısmi-iade regresyon testleri (f+g)** — H1-düzeltmesinin 3. yolu (WooCommerce kısmi-iade) testsizdi,
**mutasyonla kanıtlandı** (aday→active-only → f+g KIRMIZI); **[güvenlik, savunma-derinliği] readonly-sql
unicode-escape kapısı** (`U&'...'`/`U&"..."` denylist obfuscation); **[WP v1.0.2] webhook nonce TTL 600→660**
(paylaşılan HMAC_NONCE_TTL_SEC hizası). Doğrulama: yarış 3/3 · **entegrasyon 160/160** (+3) · birim 65/65 ·
typecheck 4/4 · build 3/3 · PHP-lint 12/12. Kapsam-dışı (bilinçli): global-arama trgm/GIN (ölçek-kapılı,
extension+migration), WP IPv6 dev-kolaylığı, reconcile checkMultiCapacity recentFilter (arka plan, korumalı).

**DERİN-DENETİM DÜZELTMELERİ + ADVERSARYEL DOĞRULAMA (commit fada750→86dcc22, CANLI prod+dev, migration YOK):**
Kullanıcı "tüm eksikleri ve sorunları gider; sistem stabil/güvenli/performans" dedi → derin-denetimde bulunan
gerçek + güvenli-düzeltilebilir açıklar düzeltildi, sonra **9-ajanlı adversaryel doğrulama workflow'u** (her
düzeltmeyi çürütmeye çalış + 2 kapsam taraması) koşuldu → H1×2/H2/M1/bundleQty **SOUND**; M2/M3 CONCERN +
**sweep 1 kaçırılan H1-yolu (HIGH)** → 3 follow-up bulgu deploy-ÖNCESİ kapatıldı. **DERS
[[denetim-regresyon-dersleri]]:** H1 sınıfı ("terminal-durumu yeni bir kümeye ekleyince TÜM revoke/refund/deliver
yollarını gözden geçir") 4. kez tekrar etti — bu kez `suspended`'ı iade kümesine eklerken revoke'un ÜÇ yolu
(revokeOrderForSite/syncRefunds/revokeExcess) var; ilk iki düzeltme yapıldı, ÜÇÜNCÜSÜ (revokeExcess adet-düşür)
yalnız adversaryel sweep'te yakalandı → yeni bir davranış eklerken o davranışın TÜM eş-yollarını grep'le.
- **[H1 — bedava lisans, 3 yol]** iade/adet-düşür yollarının üçü de yalnız `status='active'` geri alıyordu →
  ASKIDAKİ (`suspended`) atama iadede/adet-düşürde CANLI kalıp "Geri aç" ile bedava lisans üretiyordu (§2).
  `revokeOrderForSite`+`syncRefunds`+`revokeExcess` aday kümesi `active+suspended`; `revokePartialUnits` guard
  suspended kabul; syncRefunds else gerçek dönüşü sayar (over-count savunması). §2 korunur (MAK iadede kapasite
  dönmez, satır canceled). +3 regresyon testi (h1 suspended-refund, revokeExcess suspended qty-düşür).
- **[H2 — latent]** `apiRaw` oturum rolünü DÜŞÜRÜYORDU → envanter reveal-gate'i owner-olmayan admine düz-metin
  gösterebilirdi (`canRevealPlaintext('')=true`) → `getSessionRole()` ile iletir (apiPost/apiGet ile simetrik;
  ikincil admin hesabı YOK → latent). role-plaintext-consistency sweep SOUND.
- **[M1]** karantina listesi rol'e bakmadan TAM düz anahtar döndürüyordu → A1 kararıyla rol-farkında maske
  (`listQuarantine` `reveal` param + controller `canRevealPlaintext(role)`; owner düz, owner-olmayan maskeli;
  reveal audit yalnız düz-metinde). +quarantine-mask testi.
- **[M2] readonly-sql (§15, AI KAPALI)** salt-okunur tx yazmayı engeller ama uygulamanın DB rolü superuser
  olduğundan `pg_read_file`/`dblink`/`lo_*`/adminpack (`pg_file_read`) dosya-ağ + `pg_authid`/`pg_shadow`
  parola-hash katalogları okunabiliyordu → DANGEROUS_FUNCTION denylist + sistem-katalog tablo denylist +
  parola-kolon denylist (savunma-derinliği; otoriter katman superuser-olmayan DB rolü = ops). +M2 vektör testleri.
- **[M3]** KVKK anonymize serbest-metin (`reason`/`resolution_note`/`message.body` + mevcut `subject`/`detail`)
  atlıyor VE farklı-kasada PII bırakıp sayacı "maskelendi" diyordu → **case-insensitive** `regexp_replace(...,'gi')`;
  mesaj gövdeleri talep JOIN'i ile kapsanır (drizzle `ANY(${arr}::uuid[])` **bozuk SQL üretiyordu** — entegrasyon
  testi yakaladı → JOIN'e çevrildi). +üçüncü-kasa regresyon assert'i.
- **[LOW]** `bundleQty` products.controller `.positive()`→`.min(1).max(1000)` (site-mappings ile hizalı; aşırı-teslim DoS).
- **Doğrulama:** typecheck 4/4 + check-use-server temiz · api birim 65/65 · admin build · **VPS izole test DB
  entegrasyon 157/157 + yarış 3/3** · adversaryel workflow (9 ajan) SOUND · prod+dev deploy.sh rollback'li → ikisi
  de /health 200 v1.0.0. **Migration YOK.** Kalan (kabul edilen, raporlandı): M4 migration-`when` konvansiyonu
  (prod `__drizzle_migrations` cerrahisi riski > fayda; bekleyen migration yok → sonraki migration'da `when` bump);
  superuser-olmayan salt-okunur DB rolü (M2 otoriter katman, ops).

**WP SENKRON KESİNTİSİ + YAZILIMSAL DENETİM DÜZELTMELERİ (commit 9face29→6d24ea9, CANLI prod+dev,
eklenti v1.0.3, migration YOK):** Kullanıcı "dev'de atanan lisanslar WP'de görünmüyor; bazı
siparişlerde 'Lisans bilgileriniz şu an görüntülenemiyor'" dedi.
- **KÖK NEDEN — kendi W1 güvenlik düzeltmem:** `is_secure_panel_url()` http'ye YALNIZ localhost izni
  veriyordu; panel+WP aynı Docker ağındayken adres `http://api:3001` (İÇ servis adı) → guard false →
  eklenti isteği HİÇ yapmadan `code=0` dönüyordu. **Ölçüm:** WP'den `http://api:3001/v1/health` 200
  (ağ sağlam) ama dev API'de 24 saatte SIFIR site-facing istek. Sipariş push/iade/katalog senkronu da
  sessizce durmuştu. **Düzeltme:** https her zaman; http yalnız KANITLANABİLİR özel adres (loopback ·
  tek-etiketli Docker servis adı · özel IPv4/IPv6 · .local/.internal/.test) — gerçek alan adı + http
  HÂLÂ RED (10-vaka matrisi). Blok artık GÖRÜNÜR (`insecure_panel_notice` admin uyarısı).
  **DERS [[denetim-regresyon-dersleri]]:** güvenlik kapısı eklerken MEŞRU dağıtım topolojilerini
  (aynı sunucu / Docker iç ağı) test matrisine koy; **fail-safe bir kapı SESSİZ olursa arıza teşhis
  edilemez** (günlerce fark edilmedi).
- **Yazılımsal denetim maddeleri:** sessiz-mail guard (`MailConfigGuardService`: üretimde SMTP hedefi
  mailpit/localhost ise açılışta kritik alarm; fail-closed DEĞİL — **prod'da ilk boot'ta ateşledi ve
  gerçek hatayı buldu: prod SMTP_HOST tanımsız→mailpit**) · docker-compose'un GEÇİRMEDİĞİ env'ler
  (admin `REQUIRE_AUTH`+`TZ`+`APP_VERSION`; api `HMAC_IP_FAIL_LIMIT`/`AUTOCOMPLETE_INLINE_CAP`/
  7×`RETENTION_*`/`RECONCILE_*`/`SWEEP_ALARM_*` — `.env`'e yazmak sessizce ETKİSİZDİ) · log rotasyonu
  (`x-logging` 10m×5, tüm servisler) · api+admin **healthcheck** · `deploy.sh` disk temizliği
  (**prod %57→%13, 64 GB**) · ADMIN-ONLY `GET /v1/admin/system/status` (yalnız boolean; public
  /health'e KOYULMADI) → /settings'te "Telegram hep kapalı" + "sürüm 0.0.0" yanlışları düzeldi,
  "Mail gönderimi" kutucuğu eklendi · CI'a **WP PHP-lint** + **migration drift** denetimi.
- **Bonus (healthcheck ortaya çıkardı):** Next standalone bind adresini `process.env.HOSTNAME`'den
  alır, Docker onu konteyner ID'sine ayarlar → admin loopback'e bind OLMUYORDU → `HOSTNAME=0.0.0.0`.
- **Doğrulama:** typecheck 4/4 · api birim 72/72 · **entegrasyon 160/160 + yarış 3/3** · PHP-lint 12/12 ·
  dev E2E (WP→panel HMAC 200 · metabox admin-view 200 · deliveries 200 gerçek anahtar) · prod+dev
  /health 200 v1.0.0, api+admin **healthy**. **Kalan (ops, kod değil):** otomatik+offsite yedek YOK
  (kritik — MASTER_KEY kopyası dahil) · dışarıdan izleme/alarm yok · firewall/fail2ban · kalıcı domain.

**STOK GİRİŞİ YENİDEN TASARIMI — tek ekranda tedarik bilgisi (commit c202636, CANLI prod+dev, migration YOK):**
Kullanıcı "Key/Stok hesap İçe Aktar karışık; eklerken hangi tarihin partisi, tedarikçiyi vs seçmek mantıklı
değil mi" dedi. **ÖLÇÜLDÜ:** bu bilgiyi girmek **4 ekran/6 adım** sürüyordu (Tedarikçi → Satın Alma Emri →
Teslim Al → Partiler → ürün detayı → yapıştır) ve **alım tarihi hiçbir formda girilemiyordu**
(`batches.received_at = now()`); parti yalnız SEÇİLEBİLİYOR, oluşturulamıyordu (tek yol PO teslim almak).
3 keşif + 3 tasarım ajanı → 7 ayrık-dosya işçi.
- **Yeni `/stock/import`** (tek sayfa): Ürün · **Tedarik bilgisi (katlanır)** · Anahtarlar + canlı önizleme rayı.
  Tedarikçi (listede yoksa **adıyla oluşturulur**) + **alım tarihi** + parti etiketi + birim maliyet (**LİRA**
  girilir, canlı toplam; `unitCostCents` kuruş/lira karışıklığı gerçek risk) AYNI istekte gider → API **TEK
  transaction**'da `received` PO + parti açar, maliyeti lisanslara snapshot'lar. Hesap ürünlerinde **sütunlu
  tablo** varsayılan (Excel yapıştırma, ayraç otomatik, başlık atlanır), ham JSON "Gelişmiş" sekmesinde.
  **.txt/.csv dosya** tarayıcıda okunur (~700 KB kapısı — Fastify bodyLimit 1 MiB, 10.000 satırdan ÖNCE çarpılır).
  Sol menü + `/stock` + `/pending` + `/batches` derin bağlantıları; eski `import-stock-form.tsx` SİLİNDİ.
- **Sözleşme:** `ImportBody.newBatch?` (`batchId` ile karşılıklı dışlayıcı) `{supplierId?|supplierName?, label,
  receivedAt?, unitCostCents?, currency?, notes?}` — **adet alanı YOK**. `import(...)` 6. opsiyonel arg (pozisyonel
  sıra korundu; `load/*.k6.js` ve mevcut testler kırılmadı). `resolveBatchForImport` artık `exec` alır (tx içinde
  oluşturulan partiyi görebilsin + legacy yolda TOCTOU kapandı). `autoCompleteProduct` + BullMQ enqueue **tx DIŞINDA**
  kaldı (tx'e alınsaydı SKIP LOCKED commit edilmemiş satırları görmez → `autoCompleted` hep 0; `exec` ile thread
  edilseydi `deferEffects` yüzünden teslimat maili + webhook HİÇ gitmezdi; ayrıca havuz max:10 ile açlık).
- **KARARLAR (3 ajan çelişti):** parti adedi = **gerçekten girilen kayıt** (beyan DEĞİL — mükerrerler önceki
  partide sayıldı, tekrar saymak `bySupplier` harcamasını ÇİFT gösterirdi) · auto-PO **`ordered_at=NULL`**
  (`avgLeadDays=avg(received_at−ordered_at)`; eşitlemek KPI'ı sıfıra çeker) · tedarikçisiz+maliyetli → **400** ·
  hepsi mükerrer → **409 + tam rollback** (hayalet emir yok) · hepsi reddedildi → parti/PO yaratılmaz ·
  `receivedAt` **[2000-01-01, now+24s]** (gelecek tarih `byMonth`'a kalıcı hayalet ay yazardı) · etiket çakışması
  409 DEĞİL, `labelDuplicate` uyarısı · auto-PO/parti notunda **`AUTO_RECEIPT_NOTE_PREFIX='[oto-giris]'`** →
  `/purchase-orders`'da "Otomatik" rozeti + o satırda "Teslim Al" zaten `remaining=0` ile kapalı.
- **GÜVENLİK (Excel yapıştırmanın getirdiği):** `serializeAccountPayload` değerleri `trim()` ETMİYOR ve şema-dışı
  sütunu SESSİZCE atıyordu → NBSP/akıllı tırnaklı parola olduğu gibi şifrelenip **müşteriye YANLIŞ gider** (panelde
  maskeli, operatör göremez) + `payload_hash` farklılaşıp **dedupe düşer** (aynı hesap iki müşteriye). Yeni
  `normalizeFieldValue` (NFC·BOM·NBSP·akıllı tırnak·sıfır-genişlik·trim) + bilinmeyen anahtar reddi (mesaj anahtar
  ADINI taşır, **DEĞERİ ASLA**). Mevcut hash'ler etkilenmez (yalnız yeni yazımlar).
- **Yol boyunca:** pino `redact` `req.body.payload` diyordu, import gövdesi `items[].payload` → **anahtarlar loga
  sızabilirdi** (wildcard eklendi, runtime smoke) · import sonrası `/batches`+`/purchase-orders` revalidate
  edilmiyordu · `previewStockAction` `getActor()` geçirmiyordu · PO `unitCostCents` üst sınırsızdı (int4 → 500) ·
  `cleanupByTag` batches/PO/suppliers'a dokunmuyordu (yeni testler `afterAll`'da FK ihlaliyle patar, `costs`
  testini kirletirdi) · kenar menü aktif öğesi düz prefix (en-uzun eşleşmeye çevrildi) · breadcrumb ham "import".
- **Doğrulama:** typecheck 4/4 + check-use-server (21/68) · shared **34/34 mutasyonla kanıtlı** · api birim 72/72 ·
  admin build (`/stock/import` 19 kB) · VPS izole test DB **entegrasyon 178/178 (+18) + yarış 3/3** · **dev E2E
  gerçek veriyle:** kuru çalıştırma "3 kabul/1 mükerrer, parti OLUŞTURULMADI" → DB'de 0 yazım; gerçek giriş → PO
  `received` qty **3** (beyan 4 değil) `ordered_at NULL` `received_at 12.08.2026`, parti 3 adet, 3 lisansta 1250
  kuruş snapshot, **`byMonth` 2026-08 = 37,50 ₺**, valuation kapsanamayan **0**, "Otomatik" rozeti · prod deploy
  (rollback'li) → `/health` 200 v1.0.0, 136 rota, boot hatası 0.
  **NOT (tarayıcı paneli):** `loading.tsx`'i olan TÜM rotalar (dokunmadığım `/stock` dahil) bu panelin ilk
  yüklemesinde iskelette takılı kalıyor — React akış tamamlama script'i (`$RC`) çalışmıyor. Sunucu tam HTML +
  script gönderiyor; istemci gezinmesinde sayfa kusursuz açılıyor. Panel-tarayıcı sınırı, kod kusuru değil.

**STOK GİRİŞİ CİLASI — 2 dalga (commit 76deee7 + 9f73221, CANLI prod+dev, migration YOK):** Kullanıcı yeni
ekranı kullandıktan sonra ardışık geri bildirim verdi.
- **Dalga 1 (76deee7)** — "düzen/sıralama kolaylaştırılabilir, parti etiketi tarihe göre otomatik oluşabilir,
  search inputlardaki tasarım sorunlarını düzelt, başka sorun/bağlantı varsa hallet": **[GERÇEK KUSUR,
  PANEL GENELİ] Combobox süzgeci düz `toLowerCase()` kullanıyordu; projedeki `includesTr` YOKSAYILMIŞTI** →
  "ANAHTARI" yazan operatör "Anahtarı" kaydını BULAMIYORDU (hata yok, sessiz boş liste); /mappings ·
  /customers · PO formu · stok girişi/düzeltme dahil TÜM comboboxlar. İki farklı arama görünümü hizalandı
  (aynı ikon + (×) + `bg-muted/40` + "N sonuç" + `"X" için sonuç yok`). Tedarik bölümü: 3 dev radyo kartı
  (~200px) → kompakt segment (34px, ok tuşları/roving tabindex); **parti etiketi otomatik**; "listede yok"
  kutusu alanın İÇİNE (değer kaybolmuyor); maliyette para birimi öneki + canlı toplam. /guide + /batches +
  /purchase-orders + /suppliers açıklamaları, `[oto-giris]` yerine "Otomatik" rozeti. **Çekişmeli doğrulama
  5 bulgu:** en ciddisi KENDİ eklediğim Escape guard'ıydı — odak (×) düğmesindeyken popover'ı KİLİTLİYORDU
  (yalnız dışarı tıklamayla kapanıyordu) → guard TAMAMEN kaldırıldı (popover içinde Escape her zaman kapatır;
  sayfa içi `SearchInput`'ta temizlemeye devam). **DERS:** test edilemeyen zarif davranış yerine yanlış
  gidemeyecek olanı seç (bu tarayıcı panelinde gerçek klavye olayları sayfaya ulaşmıyor).
- **Dalga 2 (9f73221)** — "parti etiketi gün de içerebilir ayırt etme konusunda; yapıştırma ekranında satır
  sınırı var mı, maks belirtilebilir; yapıştırılınca kaç ürün/lisans olduğunu kenarda göster": etiket
  `YYYY-MM-<HARF>` → **`YYYY-MM-DD-<HARF>`** (harf artık yalnız AYNI GÜN içindeki 2./3. girişi ayırır; eski
  ay-bazlı etiketler farklı desen, diziyi kaydırmaz) · yeni **`EntryMeter`** girdi alanının HEMEN ALTINDA
  (kayıt · atlanan boş satır · mükerrer · `N/10.000 satır` · `X KB/700 KB`, %90'da uyarı; sınır eskiden
  yalnız AŞILDIĞINDA görünüyordu). **3 gerçek kusur:** (1) MAK/çok kullanımlıkta anahtar sayısı BİRİM
  talebiyle kıyaslanıyordu → "N bekleyen birimi tamamlar" olduğundan AZ görünüyordu (1 anahtar × 500 = 500
  birim); sayaç + bekleyen etkisi kapasiteye çevrildi ("3 anahtar = 1.500 kullanım hakkı") · (2) görünmez
  karakter denetimi yalnız hesap TABLOSUNDAYDI — düz anahtar yapıştırmasında YOKTU (`trim()` yalnız uçları
  alır; anahtarın ORTASINDAKİ sıfır-genişlik karakter sessizce teslim edilir VE hash'i değiştirip mükerrer
  kontrolünü kaçırır) → sayılır + tek tık temizlenir · (3) hesap TABLO modunda yapıştırma satır tavanı yoktu
  (hücre başına bir `<input>` → binlerce satırlık Excel bloğu sekmeyi kilitler; gövde sınırı render'dan
  SONRA görünür) → tavan **500 satır**, sessiz kırpma yok, kalan için JSON sekmesi önerilir. 1 KB altı ham
  bayt. **Doğrulama:** typecheck 4/4 + check-use-server · admin build · `autoBatchLabel` 10/10 davranış
  testi (derlenmiş `parse.js`) · **dev canlı E2E** (sayaç "5 anahtar · 1 boş · 1 mükerrer · 5/10.000",
  sıfır-genişlik yakalandı→temizlendi, `2026-08-13-A` ön-dolu → tarih 04.11 → `2026-11-04-A`, gerçek giriş
  partisi 13.08.2026 → aynı gün ikinci giriş `-B`; test verisi silindi) · prod /health 200 v1.0.0, ERROR 0.

**İKİNCİ ONAY MODALİ + ROZET DİLİ TEK KAYNAĞA (commit 62bb81b→258ddc6, CANLI prod+dev, migration YOK):**
Kullanıcı "stok girişinde 2. onay gereksin (modal + lisans listesi) — eklenip eklenmediği anlaşılmıyor;
başka yerlerde de teyit gerekiyorsa yapalım; /stock rozetleri /orders ile senkron değil" dedi.
- **Yeni primitifler:** `ui/dialog.tsx` (Radix Dialog — Sheet=çalışma yüzeyi, **Dialog=KARAR yüzeyi**) +
  `ui/confirm.tsx` **`useConfirm()`**: söz-tabanlı (`await confirm({...})`) → `window.confirm`'den geçiş
  birebir. `details` (serbest liste/özet) · `tone:'danger'` (kırmızı onay, odak **İPTAL**'de başlar) ·
  `reason` (zorunlu/opsiyonel; textarea/text/**password**+minLength). Dropdown'dan çağrılınca modal bir
  makro-görev geciktirilir (menü kapanışının odak geri-vermesi modalin odak tuzağıyla yarışmasın).
- **Stok girişi 2. onay:** "Onayla ve Dağıt" modal açar — ürün · kayıt sayısı (+MAK kullanım hakkı) ·
  tedarik özeti · **girilecek kayıtların LİSTESİ** (ilk 20; hesap ürününde secret alan maskeli) ·
  mükerrer/boş satır · **"bu giriş N bekleyen birimi HEMEN teslim eder"**. Gerçek gönderim GİZLİ submit
  düğmesiyle (`name=dryRun value=false` yalnız submitter üzerinden gövdeye girer). Sonuç ayrıca **toast**.
- **19 yerli kutu → panel modali** (kod tabanında `window.confirm/prompt/alert` **SIFIR**): sipariş
  askıya al/iptal/değiştir · değişim onayla/reddet · inceleme onayla/reddet · site askıya al (2 yer) ·
  secret yenile · bağlan kodu · eşleme kaldır (2) · şablon sil (2) · admin sil + parola sıfırla (MASKELİ
  alan) · KVKK anonimleştir · bildirim okundu · görünüm kaydet. /review'ın elle yazılmış modali silindi (−85 satır).
- **Rozet dili:** /stock envanteri ikonsuz düz Badge + yerel sözlük kullanıyordu → `StatusBadge`
  (`available/reserved/assigned/depleted` paylaşılan haritaya) · karantina `voided` amber↔kırmızı çelişkisi ·
  tedarikte **DÖRT ayrı** rozet uygulaması çelişiyordu (`voided` karnede amber/ürün detayında kırmızı;
  `ordered` PO'da gri/ürün detayında amber; PO etiketleri sözlüğü atlayıp elle küçük harf + ikonsuz) →
  yeni **`SupplyStatusBadge`** · `SupportStatusBadge` → StatusBadge. **TON KURALI** `ui/badge.tsx`'e
  yazıldı: success=sağlıklı · warning=bekliyor · danger=ölü · neutral=kapanmış; aynı ton içinde ayrım
  İKON ile (**yeni renk hue'su EKLENMEZ** — monokrom kimlik).
- **DÜZELTİLEN İDDİA (dürüstlük):** ara commit "kapanan menü görünmez tıklama ölü bölgesi bırakıyor"
  diye CANLI hata raporladı; kontrol denemesi çürüttü — doğrulamada kullanılan **tarayıcı paneli CSS
  animasyonlarını hiç koşturmuyor** (sıfırdan 60 ms'lik animasyon bile `animationend` üretmedi), Radix
  unmount için o olayı bekliyor. Gerçek tarayıcıda hayalet katman KANITLANMADI; eklenen durum-kapılı
  giriş/çıkış animasyonu (dropdown/popover/select/tooltip) doğru eşleşme olduğu için kaldı.
  **DERS:** bu panelde klavye olayları ve CSS animasyonları çalışmıyor — oradaki "ölçüm"ü canlı hata
  saymadan önce KONTROL DENEMESİ yap (aynı şey değişikliğin olmadığı yolda da oluyor mu?).
- **Doğrulama:** typecheck 4/4 + check-use-server · admin production build · **dev canlı E2E**: onay
  modali (ürün + 3 anahtarın listesi + partisiz uyarısı), odak modal içinde "Vazgeç"te, 6 kardeş öğe
  aria-hidden, onayla → 3 kayıt + toast; **rozet senkronu ölçüldü** — /stock "Teslim edildi"
  `oklch(0.696 0.17 162.48)`+ikon = /orders ile BİREBİR; dropdown→modal akışı çalıştı ·
  prod `/health` 200 v1.0.0, admin ERROR 0.

**LİSANS SIRASI — GİRİŞ SIRASI KORUNUR (commit f4720a3→6efc038, CANLI prod+dev, migration 0030+0031):**
Kullanıcı "sıralı stok ekledim ama listede karışık; sonuncu eklenen hep en üstte, verdiğim liste
gibi, sıra şaşmadan" dedi. **ÖLÇÜLDÜ (dev gerçek veri):** bir içe aktarmanın TÜM satırları tek
transaction'da yazılıyor → `created_at` = transaction damgası, hepsinde AYNI (15 satır tek damga);
tie-break rastgele `uuid v4` → blok içi sıra keyfi.
- **0030** `license_items.seq` (bigserial) + `created_idx (created_at DESC NULLS LAST, seq)` ·
  **0031** `created_asc_idx (created_at ASC, seq)` — "En eski" eski index'in TERS taramasıyla
  karşılanıyordu; yönler ayna OLMADIĞI için ayrı index ŞART (yoksa büyük tabloda tam sort).
- Listeleme `created_at DESC NULLS LAST, seq ASC` (en yeni giriş üstte, blok İÇİNDE yapıştırma
  sırası). **`NULLS LAST` açıkça yazılır:** DESC'in varsayılanı NULLS FIRST, index NULLS LAST →
  yazılmazsa planlayıcı sıralamayı index'ten karşılamaz.
- Atama (assign.ts ×2): `seq` **ÜÇÜNCÜ** anahtar → FEFO bozulmadan "önce girilen önce teslim".
- **SEQ TEK BAŞINA YETMİYOR** (keşif bulgusu): `getDeliveries` + teslimat maili + admin sipariş
  detayı sorgularında ORDER BY **HİÇ YOKTU** → mail/My Account/panel farklı sıra gösterebiliyordu.
- **Çekişmeli doğrulama KENDİ değişikliğimde boşluk buldu:** WP meta box (`siteAdminView`) tek
  başına `deliveredAt DESC` kalmıştı → `deliveredAt DESC, seq ASC` (birincil anahtar korundu).
  Aynı sınıf: karantina listesi (LIMIT'li ORDER BY tie-break'siz → pencereye giren satırlar keyfi),
  Ctrl+K (ORDER BY'sız LIMIT 10), toplu değiştirme adayları.
- **BİLİNEN SINIR:** migration ÖNCESİ satırların seq'i heap FİZİKSEL sırasından gelir (o satırlar
  UPDATE görmüş olabilir) → eski bloklarda sıra garanti DEĞİL; yapıştırma sırası daha önce hiçbir
  yere yazılmıyordu, geri kazanılamaz. `ADD COLUMN bigserial NOT NULL` tabloyu YENİDEN YAZAR
  (volatile default) ve boot'ta auto-migrate koşar → deploy.sh 60 sn sağlık penceresi; uygulandığında
  tablo küçüktü (prod 3, dev 22 — ölçüldü), rewrite'sız reçete 0030 SQL'inin başına yazıldı.
- **Doğrulama:** typecheck 4/4 · VPS izole test DB **entegrasyon 183/183 + yarış 3/3** (5 yeni sıra
  testi) · **dev canlı E2E:** 10 anahtarlık sıralı giriş → liste `SIRALI-TEST-01..10` BİREBİR sırada ·
  prod /health 200 v1.0.0, migration tracking 32, api ERROR 0. **DERS:** "sıra" şikâyetinde tek bir
  sorguyu düzeltmek yetmez — aynı veriyi gösteren TÜM yüzeyleri (panel/mail/müşteri/mağaza) ve
  SEÇİM yolunu (atama) birlikte gözden geçir; LIMIT'li her ORDER BY'ın tie-break'i olmalı.

**DURUM RENGİ SİSTEMİ 3→5 HUE + /products 404 + TARAMA (commit 79daa30→6ffdafa, CANLI prod+dev,
migration 0032):** Kullanıcı "teslim edildi rozetlerinin özel rengi olmalı, hafif soluk renklerle,
ilgili tüm yerlerde; /products boş 404; başka eksik ne var" dedi.
- **Kök neden ÖLÇÜLDÜ:** `available/assigned/fulfilled/active/approved/sent` HEPSİ aynı emerald'dı →
  `/stock`'ta "Stokta" ile "Teslim edildi" bir bakışta ayrılmıyordu. Yeni token `--info` (mavi) +
  `--attention` (mor); açık+koyu tema + `@theme inline` **base + `-foreground` çiftleri** (base
  atlanırsa Tailwind v4 `bg-*` utility'sini HİÇ üretmez). Kontrast **hesaplandı** (oklch→sRGB→WCAG,
  %14 tint zemini üzerinde): info 5.29 / attention 5.67 (açık), 6.13 / 5.86 (koyu) — AA üstü, sRGB içi.
  **TON KURALI (badge.tsx, tek kaynak):** success=elimde sağlıklı kaynak · info=tamamlandı/müşteride ·
  warning=bekliyor (kendiliğinden ilerler) · attention=insan kararı (İncelemede/Askıda) · danger=ölü/
  engelli · neutral=kapanmış. `expired` beklenen bir sondur → alarm değil, nötr. Rozet: soluk tint +
  saç teli `ring-inset`. **Alert `info` artık GERÇEKTEN mavi** (rozetle aynı hue); sessiz gri kutu
  `muted` adını aldı — aynı adın iki farklı rengi olması tasarım sistemi hatasıydı.
- **Tutarlılık:** ad-hoc küçük harfli rozetler cümle düzenine (Aktif/Pasif/En yeni/Eşlenmemiş/Garanti
  içi/risk bandı/dağıtım durumları); `pasif` bir tabloda danger diğerinde outline'dı → nötr; katalog
  "Eşlenmemiş" warning→outline (katalogda eşlenmemiş olmak eksik DEĞİL — alarm tasarımı); /orders
  kırpma bandı info→warning (ikonu zaten uyarıydı); dağıtım `Çalışıyor` → mavi (kuyruktaki amber
  `Bekliyor`dan ayrılır).
- **/products 404:** `/products/[id]` breadcrumb'ı `/products`'a link basıyordu, `page.tsx` yoktu →
  404 + ham İngilizce "products". Ürün listesi `/stock`'ta yaşıyor; **İKİNCİ liste EKLENMEDİ** →
  **middleware'de** `/products`→`/stock` 307 + breadcrumb "Ürünler". **TUZAK (yine görüldü):** sayfa
  içi `redirect()` YETMEZ — async root layout stream'e başladığı için Next meta-refresh gövdesi
  üretir (dev'de ölçüldü: 200 + boş kabuk); kök yol için de aynı sebeple middleware kullanılıyor.
- **Taramada bulunan gerçek eksikler:** **[perf, migration 0032]** `license_items.product_id` üzerinde
  KOŞULSUZ index yoktu (mevcut ikisi de `WHERE status='available'` KISMİ index'i) → "bu ürünün TÜM
  kalemleri" tam tablo taramasıydı; yeni `(product_id, created_at, seq)` sıralamayı da karşılar
  (koddaki "product_id index'e oturur" yorumu YANLIŞTI). **[ops]** dağıtım kuyruğunda takılı `pending`:
  zombi temizliği `claimNext`'in İÇİNDE, yani runner'ın kendisi ölünce hiç çalışmıyordu → istek sonsuza
  dek pending, guard 409, **panelden bir daha dağıtım yapılamıyordu**; temizlik `request()` yoluna da
  kondu (30dk) + `/deployments`'ta 3dk sonra nedeni söyleyen uyarı bandı.
- **Doğrulama:** typecheck 4/4 + check-use-server (21/68) · admin production build · **dev'de 26 rotanın
  tamamı 200, hata sınırı 0** · tarayıcıda ÖLÇÜLDÜ: "Stokta" `oklch(0.696 0.17 162.48)` vs "Teslim
  edildi" `oklch(0.74 0.12 250)` (koyu) ve `oklch(0.48 0.13 250)` (açık) · `/products` 307→`/stock`,
  `/products/<id>` etkilenmedi · prod deploy (rollback'li) → `/health` 200 v1.0.0, migration tracking 33,
  `license_items_product_created_idx` canlı. migration 0000-0032.

**UX PARTİSİ: ADIM KİLİDİ · KATLANIR FORMLAR · ÜRÜN SEKMELERİ · TOPLU GEÇERSİZ KILMA · PARTİ DETAYI
(commit 36879e5→cc3f7d8, CANLI prod+dev, migration YOK):** Kullanıcı 5 madde bildirdi.
- **[1] Stok Girişi adım adım:** ürün seçilmeden 2. adım başlığı tıklanamaz, 3. adım `fieldset[disabled]`
  (her kontrolü NATIVE devre dışı bırakır + odak sırasından çıkarır; tek tek `disabled` dağıtmaktan
  güvenli) + "önce ürün seçin" notu. Ürün seçilince ikisi de açılır (tarayıcıda iki yönde ölçüldü).
- **[2] Oluşturma formları katlanır:** yeni `ui/collapsible-panel.tsx` — /suppliers "Yeni Tedarikçi" ve
  /admins "Yeni Admin" varsayılan KAPALI, butonla açılır; kapalıyken DOM'a hiç girmez (a11y + reset).
- **[3] Ürün detayı sekmelere ayrıldı:** 7 kart tek sayfada üst üsteydi ve iki kolonun yükseklikleri
  tutmuyordu → yeni `ui/tabs.tsx` (radix zaten bağımlılıkta) ile **Envanter / Eşlemeler / Tedarik /
  Hareketler**; iki özet şeridi yan yana. İçerikler SUNUCUDA render edilip prop olarak geçer (tablolar
  istemciye taşınmadı).
- **[4] Stok düzeltme mimarisi (asıl şikâyet):** bozuk anahtarı tek tek combobox'tan seçmek operasyonel
  olarak kullanılamazdı. Artık **envanter tablosunda çoklu seçim** (yalnız `available` satırlar) + toplu
  aksiyon çubuğu + zorunlu sebep modali; seçim ürüne göre gruplanıp grup başına istek atılır. API
  `createAdjustment` `licenseItemIds[]` (tek UPDATE; **kalem başına ayrı `stock_adjustments` satırı** —
  Karantina sebebi kalem bazında okunuyor); **"hepsi ya da hiçbiri" DEĞİL**: arada kapılan kalem atlanır
  ve `{requested, affected, skipped, qtyTotal}` ile dürüstçe raporlanır, hiçbiri işlenemezse 400. Ürün
  sayfasındaki tekil seçici KALDIRILDI (o form artık yalnız defter kaydı). Yeni `ui/checkbox.tsx`
  (native input + indeterminate; yeni radix paketi eklemeye değmedi).
- **[5] PARTİ DETAYI `/batches/[id]`:** parti listesi yalnız sayaç gösteriyordu, partinin İÇİNDEKİ
  anahtarlara bakmanın yolu yoktu. `GET /v1/admin/batches/:id` (listBatches(onlyId) yeniden kullanılır)
  + partiye kilitli envanter (`LicenseItemsTable batchId` — API/action destekliyordu, tabloya
  bağlanmamıştı), teslim edilenler ve geçersiz kılınanlar dahil; parti dilinde başlıklar; toplu işlem
  aynı tablodan. Parti etiketi listede detaya link.
- **İKİ KENDİ-REGRESYONUM — ikisi de `tsc` + `next build`'de GÖRÜNMEDİ:** (a) sunucu bileşeninden
  istemci bileşenine **lucide BİLEŞENİ** prop'u (`icon={Plus}`) → React "Functions cannot be passed
  directly to Client Components" ile ÇALIŞMA ANINDA patladı, `/suppliers` + `/admins` hata sınırına
  düştü → prop `ReactNode` (element) yapıldı. (b) `= ANY(${dizi}::uuid[])` drizzle şablonunda BOZUK SQL
  üretti (Postgres 42846) → parametreli `IN (...)`; **bu tuzak KVKK anonymize yolunda daha önce
  yaşanmıştı** (bu dosyada yazıyordu), tekrarı 5 entegrasyon testiyle kilitlendi. Ayrıca JSDoc içinde
  `app/*/page.tsx` yazmak yorumu erken kapatıp dosyayı söz dizimi hatasına düşürdü.
- **Yeni `scripts/smoke-routes.sh`:** 26 admin rotasını gezer ve YALNIZ HTTP koduna BAKMAZ — Next hata
  sınırı 200 döndüğü için gövdede `error.tsx` imzasını ("Hata kodu:" + "Tekrar dene") arar. Önceki elle
  taramam dar bir metin kalıbı kullandığı için kırık `/suppliers`'ı TEMİZ raporlamıştı.
- **Doğrulama:** typecheck 4/4 + check-use-server (21/69) · admin build · **VPS izole test DB:
  entegrasyon 188/188** · dev 26 rota + 4 detay sayfası hata sınırı 0 · **dev canlı E2E:** toplu düşme
  3 istendi → 2 etkilendi / 1 atlandı / 2 defter satırı, ikisi de Karantina'da sebebiyle; parti detayı
  15 kalem (11 stokta · 3 teslim edilmiş · 1 geçersiz) · prod deploy → `/health` 200 v1.0.0.

---

**PARTİ SAYAÇLARI + GERİ ÇEKME SONRASI TAKİP + TEK ODAK GÖSTERGESİ (commit 2952a04→a6747e6, CANLI prod+dev,
migration YOK):** Kullanıcı geri çekme onayında "Satılmış 6 birim müşterilerde — bunlar için değişim gerekir"
gördü ama 6 birim satılmamıştı (bir kısmı ELLE geçersiz kılınmıştı); ayrıca "geri çekilen anahtar gösterilmeye
devam edecek mi? manuel kontrolümden geçip değiştirebilmem gerek" diye sordu ve inputlardaki odak tasarımını
bildirdi. 4 lensli keşif + 3 lensli çekişmeli doğrulama (kendi değişikliklerimi çürüt) ile yapıldı.
- **[SAYAÇ — bildirilen hata]** `listBatches` sayacı `status <> 'available'` idi → voided/quarantined/
  replaced/revoked/expired HEPSİ "satılmış" kovasına düşüyordu. Aynı serviste `recallBatch` ÇOKTAN doğru
  yüklemi (`EXISTS aktif atama`) kullanıyordu ve kodda gerekçesi yazılıydı; iki tanım aynı ekranda
  çelişiyordu. `canBulkReplace` de bu yanlış sayaca bağlıydı → değiştirilecek hiçbir şey yokken "Toplu
  Değiştir" açılıyor, tıklanınca 0/0 dönüyordu. Artık tek `LEFT JOIN` + `count(*) FILTER` +
  `LEFT JOIN LATERAL bool_or` ile BEŞ sayaç: `totalCount` · `unsoldCount` (status='available' — recall'ın
  VOID edeceği küme, DEĞİŞMEDİ) · `customerCount` (atama active|suspended — gerçekten müşteride) ·
  `replaceableCount` (**bulkReplaceBatch aday kümesiyle BİREBİR**: aktif atama + `status<>'available'` +
  `usage_mode<>'multi'`) · `deadCount`. `onlyId` süzgeci alt sorguya da iner. **MAK NOTU:** kovalar
  TOPLANMAZ (kısmen satılmış MAK anahtarı hem stokta hem müşterilerde sayılır) → `totalCount` ayrı
  sorulur, ekranlar "toplam = stokta + müşteride + düşmüş" ARİTMETİĞİ KURMAZ. `RecallResult` jsdoc'u
  "available olmayan" diye YALAN söylüyordu (SQL hiçbir zaman öyle değildi) — kök nedenin kaynağı buydu.
- **[TAKİP — kullanıcı sorusunun cevabı]** `getDeliveries` YALNIZ `assignments.status='active'` süzer,
  parti durumuna BAKMAZ → geri çekilen partinin teslim edilmiş anahtarı müşteride **çalışmaya devam eder**.
  Doğrusu da budur (bir kısmı sağlam olabilir; otomatik iptal müşteriyi lisanssız bırakırdı — §15 "insan
  onaylar"). Yeni **"kim tutuyor" ekseni**: `GET /v1/admin/license-items?holder=customer`
  (`EXISTS assignments IN (active,suspended)`) — durum süzgecinden AYRI olmak ZORUNDA, çünkü MAK anahtarı
  kısmen satılmışken hâlâ `status='available'` görünür. Envanter satırında teslim edilmiş kalem artık
  devre dışı iki düğme yerine **"Yeni anahtarla değiştir"** gösterir (mevcut
  `POST /v1/admin/assignments/:id/replace` — iş kuralı TEKRARLANMADI); MAK ve **askıdaki** atamada düğme
  sebebiyle kapalı (API askıdakini 400'ler; askıyı operatör bilerek koymuştur). Parti detayında
  **"Müşterilerdeki lisanslar"** kartı (kilitli kapsam) — iş listesi değişim yapıldıkça kendiliğinden kısalır.
  İki tablo `batch-license-panels.tsx` istemci sarmalayıcısında paylaşılan `refreshKey` ile birlikte tazelenir.
- **[ODAK — ölçüm naif düzeltmeyi çürüttü]** `globals.css`'teki `:focus-visible { outline: 2px solid
  var(--ring) }` kuralı **@layer DIŞINDA**; Tailwind v4 TÜM utility'leri `@layer utilities`'e koyar ve CSS
  Cascade L5'te katman sırası specificity'den ÖNCE gelir → bu kural her `outline-none`'ı yener. **Tarayıcıda
  CSSOM ile ÖLÇÜLDÜ** (`.outline-none` → "utilities", global kural → katmansız). Sonuç: kenarlık + soluk hale
  + boşluk + outline = 3-4 bant üst üste. **Naif düzeltme (kuralı `@layer base`'e taşı) bir a11y REGRESYONU
  olurdu:** hesaplandı (oklch→sRGB→WCAG) `ring-ring/40` 1.85:1 · `ring-ring/60` 2.68:1 · `ring-sidebar-ring`
  2.48:1 — üçü de 3:1 eşiğinin ALTINDA; outline ise 6.54 açık / 4.18 koyu. Bu yüzden TERS yön seçildi:
  **halkalar kaldırıldı, outline TEK gösterge bırakıldı** (sidebar odak kontrastı 2.48→6.26, yani eşik-altı
  bir durum DÜZELDİ). Hata durumu artık halka değil `aria-[invalid=true]:[--ring:var(--destructive)]` ile
  outline rengini ezerek verilir. TEK istisna `ring-inset` (kırpılan konteynerler: live-feed satırları ve
  `overflow-x-auto` taşıyan TabsList — ölçüldü, orada outline üst/altta 1px kırpılıyor).
- **[ONAY MODALİ]** `confirm({details})` DİZİ geçirildiğinde React ayraçsız BİTİŞİK metin basıyordu
  ("…geri alınamaz).Satılmış 6 birim…") ve metin düğümleri `space-y-3` (`> * + *`) seçicisine girmediği için
  alttaki alanla boşluk da kalmıyordu → dizi artık madde listesi, tekil içerik sarmalayıcı kutu (iki çağıran).
- **Çekişmeli doğrulama 5 gerçek bulgu** çıkardı, hepsi deploy ÖNCESİ kapatıldı (askıda-çıkmaz-sokak ·
  MAK'ta sayaç uyumsuzluğu = bildirilen hatanın tekrarı · korele EXISTS perf → LATERAL+`coalesce(bool_or)`
  [coalesce ŞART: `NOT NULL` de NULL'dur, atamasız kalemler `dead_c`'ye girmezdi] · band↔modal sayı
  uyumsuzluğu → `customerHeld` · iki tablo bayat kalması).
- **Doğrulama:** typecheck 4/4 + check-use-server (21/70) · admin build · api birim 72/72 · **VPS izole test
  DB entegrasyon 192/192** (+4 yeni `batch-counters` testi — bu sayaçların HİÇ testi yoktu, hatanın yaşama
  sebebi tam olarak buydu) · **dev canlı E2E:** kullanıcının ekran görüntüsündeki partide eski sayaç
  "6 satılmış" derken gerçekte müşteride **3** anahtar vardı; satırdan değişim yapıldı → müşteride 3→**2**,
  düşmüş 12→**13**, taze anahtar **BAŞKA partiden** geldi (o partide stok 1→0), eski anahtar karantinada ·
  prod deploy (rollback'li) → `/health` 200 v1.0.0.
- **KENDİ HATALARIM:** dev'de yanlış aracı (`deploy.sh` — prod içindir, dev'in `dev-stack.sh`'i var)
  çalıştırıp ayrı bir compose projesi yarattım (temizlendi, **prod etkilenmedi**) · regex düzenlemesi
  `reloadAfterMutation` içindeki `reload()`'u kendisiyle değiştirip sonsuz özyineleme üretti (okuyarak
  yakalandı) · `sql` şablonu içinde backtick kullanıp template'i erken kapattım · yeni testte
  `createSite(db, crypto, opts)` imzasını yanlış çağırdım (izole DB'de 2 test düştü).

**TEDARİKÇİ DEĞİŞİM FİŞLERİ — kusurlu anahtarı bildir, süreci takip et (commit 84477ba→70022e9,
CANLI prod+dev, migration 0033):** Kullanıcı: *"karantinada geçersiz kılınan lisansları liste halinde
veriyorsun; partiden hatalı çıkanları tedarikçiye değişime gönderiyorum, gün sonunda/tarih bazlı Z
raporu alıp indirebilmeliyim; süreç kapsamlı, temiz, karışık olmadan ilerlemeli — istasyon gibi."*
3 keşif ajanı + kullanıcı kararları (fiş+kalem sonucu · karantina dönüşsün · Z raporu) ile yapıldı.
- **DOĞRULANAN BOŞLUK:** "bu kusurlu anahtarı tedarikçiye bildirdim mi?" bilgisi şemadaki 28 tablonun
  HİÇBİRİNDE yoktu (`reported`/`claim`/`rma`/`returned`/`sent` arandı). Tek bildirim yolu izi olmayan
  bir tarayıcı indirmesiydi → aynı anahtar defalarca bildirilebiliyor, tedarikçinin yanıtı kayıt
  dışı kalıyordu. Tedarikçi karnesinde de anahtar düzeyinde kusur oranı YOKTU (`recallRate` yalnız
  "kaç parti geri çekildi" der).
- **migration 0033** (additive, boş tablolar): `supplier_claims` + `supplier_claim_items`.
  `license_item_id` **PLAIN uuid, FK YOK** (`stock_adjustments` deseni: kalem silinse bile fiş izi
  kalır). Kalem alanları **SNAPSHOT** (parti/ürün/anahtar/sebep/kusur-kaynağı): aynı fiş bir ay sonra
  da BİREBİR aynı dosyayı verir. **Çift bildirimi DB'de engelleyen tek satır:** kısmi unique index
  `(license_item_id) WHERE outcome <> 'rejected'` — `rejected` bilerek dışarıda, tedarikçi reddederse
  anahtar **HAVUZA GERİ DÖNER** ve yeniden bildirilebilir (kullanıcı kararı).
- **ADAY SORGUSU YENİDEN YAZILMADI:** `listQuarantine`'e tek EXISTS + `?claimed=none|open|any`.
  İkinci bir tanım yazmak, bu projede **"satılmış 6 birim" yanılgısını üreten hatanın aynısıydı**;
  ekrandaki süzgeç yüklemi ile unique index yüklemi BİREBİR aynı tutuldu. Satıra `defectKind`
  (`customer_return|recall|damage|manual_void`) türetildi — tedarikçi raporunda gerekçe ayrımı.
- **Yeni modül `supplier-claims`** (6 uç): Z raporu önizleme · liste · detay · **fiş kes**
  (GLOBAL `pg_advisory_xact_lock` + kilit altında adayları TAZEDEN oku + snapshot + `DEG-YYYYAAGG-NN`;
  önizleme bayat olabilir) · durum geçişi (`draft→sent|canceled`, `sent→closed`; **iptal kalemleri
  SİLER** → havuza döner, çünkü satırı bırakıp durum değiştirmek "reddedildi" demek olurdu ve
  karnede sahte ret üretirdi) · kalem sonucu. `audit_action` PG enum'una **DOKUNULMADI** (mevcut
  `adjust` + `meta.op`). Fiş içeriği **kesildiği andaki yetkiyle donar**: owner-olmayan admin fiş
  keserse snapshot MASKELİ yazılır ve sonradan owner açsa da maskeli kalır (bilinçli).
- **Tedarikçi karnesine KUSUR bloğu:** `wastage()` ile AYNI zincir (`coalesce(b.supplier_id,
  po.supplier_id)`) → defect rate + bildirilmemiş kusur + açık fiş + ort. çözülme süresi
  (`sent_at→closed_at`) + yenilenen/reddedilen.
- **Admin:** `/quarantine` → **"Kusurlu Anahtarlar"** iş istasyonu, iki sekme (**Bekleyenler** ·
  **Fişler**); sekme gövdeleri SUNUCUDA render edilip prop olarak geçer (`product-tabs` deseni —
  1200 satırlık karantina tablosu yeniden YAZILMADI). Bekleyenler üstünde **tedarikçi→parti gruplu
  panel** (partinin STOK GİRİŞ tarihiyle) + tek tık "Fiş oluştur" + başlıkta **"son fiş: KOD · tarih"**
  (kullanıcının istediği "son rapor tarihi"). Fiş kesme Sheet'i (7/30/90/özel ön ayar — basıldığı ANDA
  sabit tarihe çevrilir; adaylar otomatik, tek tek çıkarma). `/quarantine/claims/[id]`: özet şerit +
  **.txt/.csv indirme** + durum düğmeleri + çoklu seçimle kalem sonucu. Rapor SNAPSHOT'tan üretilir ve
  **KİŞİSEL VERİ İÇERMEZ** (KVKK — karantina "Tedarikçi bildirimi" varyantının kuralı).
  **`ClaimStatusBadge`/`ClaimOutcomeBadge` AYRI bileşen:** fiş sözlüğü mevcut anahtarlarla çakışıyor ve
  AYNI anahtar farklı şey demek (`replaced` sipariş dilinde ölü anahtar, fişte İYİ haber; `pending`
  "Bekliyor" vs "Cevap bekleniyor") — tek haritada birleştirmek `SupplyStatusBadge`'i doğuran hatanın
  aynısı olurdu. **Yeni hue EKLENMEDİ.**
- **Yol boyunca:** bayat `QuarantineRow` tipi (11 alan eksikti; `Partial<>` yaması tip güvenliğini
  fiilen kaldırmıştı) gerçek yanıtla hizalandı · `stock_adjustments.license_item_id`'ye **index**
  (karantinanın iki sıcak sorgusu onu kullanıyordu, index YOKTU) · breadcrumb ham "claims" ·
  bayat sayaç ipucu ("değişim talep edilebilir" → "parti/tedarikçi izi var").
- **Doğrulama:** typecheck 4/4 + check-use-server (22/74) · admin build · **VPS izole test DB
  entegrasyon 200/200** (+8 yeni fiş testi, regresyon yok) · **dev canlı E2E (gerçek 15 kusurlu
  kalem):** fiş kes `DEG-20260813-01` (15 kalem) → havuz **0** → "Gönderildi" + tedarikçi referansı →
  3 kalem reddet → havuz **3** (reddedilenler geri döndü) → özet "15 kalem · 12 bekliyor · 3 red" →
  karne `defectRate 0.68 · unclaimed 3 · openClaims 1` · prod deploy (rollback'li) → `/health` 200
  v1.0.0, iki tablo da canlı. migration 0000-0033.
- **NOT (tarayıcı paneli):** Radix sekmeleri `mousedown`'da seçer; panelin programatik `.click()`'i
  sekmeyi DEĞİŞTİRMEZ. Gerçek pointer dizisi (`pointerdown`+`mousedown`+…) gönderilince çalıştı —
  panel sınırı, kod kusuru değil (kontrol denemesi yapıldı).
- **Bilinen sınır (planda AÇIK):** MAK/çok-kullanımlı kusurlu anahtar hiç karantinaya giremediği için
  fişe de giremez (`maxUses>1` dalı yalnız `use_count` düşürür — atama çekirdeği ayrı iş) · geri
  çekilen partide **satılmış** kalemler "Toplu Değiştir" koşulmadan havuza düşmez · partisiz girişte
  tedarikçi bilinmez → fiş kesilemez · tedarikçiden gelen **yeni anahtarların** fişe bağlanması kapsam
  dışı (kullanıcı "tam kapanış"ı seçmedi) · fiş panelden GÖNDERİLMEZ, dosya indirilir.

**RE-DOĞRULAMA → 16 BULGU (commit 929e313→c4f9d51, CANLI prod+dev, migration 0036, eklenti v1.0.4):**
Bir önceki denetim partisinin (1a1df51) düzeltmelerini ÇÜRÜTMEYE çalışan 5 lensli workflow (27 ajan;
revoke-ölçek · liste-limit · karantina-join+fiş-maskesi · admin-UI · WP) → **16 CONFIRMED / 6 çürütüldü**.
En ağır bulgu KENDİ düzeltmemdi — [[denetim-regresyon-dersleri]] bir kez daha doğrulandı.
- **[ORTA — KENDİ REGRESYONUM] `qty`'ye iki anlam yüklemek H1'i yeniden açtı.** Per-atama iptalinde
  satırı terminal yapmayıp `qty` düşürmüştüm. Ama `reconcileOrder`'ın iade koruması TEK yükleme
  dayanıyor (`if (line.canceled) continue`); satır terminal olmayınca mağaza re-push'u
  (`woocommerce_saved_order_items` → `resync_items` → `POST /v1/orders`) qty'yi MAĞAZA adedine geri
  yükseltiyor, partial-auto iptal edilen birime TAZE anahtar teslim ediyordu (bedava lisans + envanterden
  kalem yanması). TERS YÖN: iptal sebebi gerçek iade değil "kusurlu anahtar" ise qty düşüşü müşterinin
  ÖDEDİĞİ hakkı sessizce kısıyor ve satırı 'fulfilled' işaretliyordu ("Kalanları Ata" da doldurmaz).
  **KÖK NEDEN:** `qty` hem MAĞAZA GERÇEĞİ hem DOLDURMA HEDEFİ anlamını taşıyordu.
  **DÜZELTME (migration 0036, additive):** `order_lines.canceled_units` defteri + yeni
  `orders/fill-target.ts` (`fillTarget`/`remainingUnits`/`lineStatusFor`). `qty` mağazadan gelir ve
  DOKUNULMAZ; iptaller ayrı kolonda birikir; hedef TEK noktada `qty − canceled_units` → completeLine,
  all-or-nothing kapısı, satır durumu, "neden bekliyor" tanısı, getDeliveries ilerlemesi ve bulkStatus
  hepsi oradan okur. Mağaza adedi DÜŞERSE defter aynı miktarda azaltılır (aynı iptal iki kez sayılmaz);
  adedi ARTIP defter doluysa GÖRÜNÜR `order_edited` olayı yazılır. **DERS:** bir kolona ikinci bir
  anlam yüklemek yerine AYRI defter aç; "hedef" gibi türetilmiş bir kavramın TEK tanımı olsun.
- **[düşük]** `liveSiblings` satırın `canceled` durumuna bakmıyordu → `revokeOrderForSite` (önce tüm
  satırları cancel eder, sonra atamaları tek tek geri alır) her çağrıda "kardeş var" görüp defteri
  şişiriyor + yanıltıcı olay yazıyordu; artık zaten terminal satırda deftere dokunulmaz.
- **[ORTA/güvenlik]** `supplier_claim_items.key_snapshot` readonly-sql denylist'inde YOKTU → fiş
  maskesi AI NL→SQL yolundan TAMAMEN atlatılabiliyordu (AI varsayılan KAPALI; savunma derinliği).
  Kolon + `supplier_claim_items`/`supplier_claims` tabloları denylist'e + regresyon testi.
- **[düşük ×5 admin]** `includesTr` ASCII büyük 'I'da SESSİZ boş sonuç veriyordu (tr-TR katlamasında
  'I'→'ı'; "ai" araması "AI Operasyon"u bulamıyordu) — kusur ZATEN vardı, önceki parti onu 5 yeni yere
  yaydı → MERKEZÎ iki-geçişli katlama (~15 çağıran birden onarıldı) · parti seçicisi artık sunucu-taraflı
  `?productId=` süzgeci kullanıyor (global 500'lük pencere + istemci süzgeci geçerli partiyi "yok"
  gösterebiliyordu) · kırpma bayrağı hata/temizleme yollarında bayat kalıyordu · iptal onay modali
  artık GERÇEKLEŞEN davranışı anlatıyor (kardeş varsa "diğer N lisans geçerli kalır") · maskeli fiş
  raporu SESSİZCE indiriliyordu (tedarikçiye `••••••1234` listesi) → `masked` bayrağı + uyarı bandı.
- **[düşük]** `truncated` TAM sınırda yanlış pozitifti (tam 500 parti / 2.000 müşteride "liste eksik")
  → projenin mevcut deseni: "tavan+1 çek, JS'te kırp" · hesap tipli fiş kaleminde maske sır OLMAYAN
  alanları da siliyordu → `listQuarantine(reveal=false)` ile aynı alan-farkında davranış (payload_schema'dan
  label→secret haritası, `maskAccountFields` paylaşılır).
- **[düşük ×5 WP → v1.0.4]** Önceki partide EKLEDİĞİM "paket reddedildi" uyarısı Docker/aynı-sunucu
  kurulumunda KALICI, kapatılamaz kırmızı banda dönüşüyordu: `is_valid_package_url` hâlâ dar kuralı
  (http yalnız localhost) kullanırken 1.0.3 `is_secure_panel_url`'ü genişletmişti → iki kapı TEK tanıma
  bağlandı (`is_secure_panel_url($download)`; host eşitliği şartı AYNEN korundu + şema http/https'e
  daraltıldı) · multisite bayrak kapsamı (`*_site_transient` + `network_admin_notices`) · `substr` çok
  baytlı karakteri bölünce `esc_html` mesajı BOŞALTIYORDU → `mb_substr` + görünür kırpma · panel
  erişilemezken bayrak bayat kalıyordu → silme yerine `stale_since` damgası + yumuşak metin.
- **KENDİ HATAM (3. kez):** `sql` şablonunun İÇİNDE backtick — bu kez işçinin yorumunda; typecheck
  yakaladı (TS1005). Ayrıca ilk denetim partisinde PHP-lint HİÇ koşulmamıştı (işçinin makinesinde PHP
  yok) → bu turda VPS'te throwaway `php:8.2-cli-alpine` ile koşuldu: **12/12 temiz**.
- **Doğrulama:** typecheck 4/4 + check-use-server (22 dosya / 74 export) · admin production build ·
  VPS izole test DB **entegrasyon 210/210 + yarış 3/3** (+ yeni "re-push adedi geri yükseltse bile iptal
  edilen birim TAZE anahtarla DOLMAZ" regresyon testi — doğrulayıcı bu yolun testsiz olduğunu işaretlemişti) ·
  PHP-lint 12/12 · prod deploy (rollback'li) → `/health` **200 v1.0.0**, migration tracking **37**,
  `order_lines.canceled_units` CANLI (default 0, NOT NULL), api ERROR 0 · dev stack güncel ·
  **eklenti v1.0.4 panele yayınlandı** (HTTP 201, 102.001 bayt, HEAD ile birebir). migration 0000-0036.

**PROJE GENELİ DENETİM → 17 BULGU (commit 1a1df51, CANLI prod+dev, migration 0035):** Kullanıcı iki
somut kusur bildirdi (fiş oluşturma Sheet'i bozuk · havuzda karantina tarihi yok) ve *"projeyi baştan sona
incele, denetle — güvenlik/performans/UI-UX; ajanlarına görev dağılımı yap; kullanım rehberi ve menüdeki tüm
sayfaları test araçlarınla kontrol et"* dedi. İki kusur önce düzeltildi (f76d63f: SheetContent `overflow-y-auto`
+ gövde `p-4 pt-0` — diğer TÜM sheet'lerin deseni atlanmıştı; havuz kalem satırına "karantina: …" damgası),
sonra 5 lensli çekişmeli-doğrulamalı denetim (10 ajan, bul→çürüt) koşuldu → **17 CONFIRMED** (0 yüksek ·
2 orta · 15 düşük). 3 paralel ayrık-dosya işçi + merkezî orders/şema işi.
- **[ORTA/correctness] Tek atama iptali kardeş lisansları müşteriden GİZLİYORDU.** `revokeAssignment`
  (`markLineCanceled=true`) satırı KOŞULSUZ `canceled` yapıyordu; `getDeliveries` iptal satırını elediği için
  qty=3'lük satırda tek anahtar iptal edilince müşteri **elinde HÂLÂ 'active' 2 anahtar dururken 0 lisans**
  görüyordu (admin detayında görünüyorlar → sessiz, alarmsız tutarsızlık). Düzeltme İKİ YÖNLÜ olmak zorundaydı
  (tek yönlüsü H1 bedava-lisansı doğururdu): kardeş atama kaldıysa satır **terminal YAPILMAZ** ama `qty` geri
  alınan birim kadar **DÜŞER** (`fulfilled == qty` ⇒ partial-auto/"Kalanları Ata" taze anahtarla DOLDURMAZ);
  kardeş kalmadıysa eski davranış (`canceled=true`, qty korunur). **Kalıntı risk SESSİZ BIRAKILMADI:** mağazada
  karşılığı olmayan panel-içi iptalden sonra re-push `reconcileOrder` ile qty'yi geri yükseltip taze anahtar
  teslim edebilir → `fulfillment_events`'e açık cümleyle yazılır. +3 regresyon testi. NOT: `markLineCanceled=true`
  diğer iki çağıranı (revokeOrderForSite tam iade · releaseHeld stray temizliği) satırı ZATEN ayrıca canceled
  yapıyor → davranışları değişmedi.
- **[ORTA/ui-ux]** BEŞ arama noktası `includesTr` standardını atlıyordu (ham `toLowerCase()` → Türkçe İ/I'da
  SESSİZ boş sonuç): /notifications · /purchase-orders · /review · başarısız işler · **Ctrl+K komut paleti**
  ("inceleme" → "İnceleme Kuyruğu" bulunamıyordu).
- **[güvenlik]** Tedarikçi fişi detayı `keySnapshot`'ı rol-farkında maskelemiyordu → **owner'ın kestiği fişi
  owner-olmayan admin DÜZ METİN** görüyordu (A1/M1 kararının fişte kırılması); `@AdminRole` + `canRevealPlaintext`
  + reveal audit yalnız gerçekten düz metin dönerken. readonly-sql denylist'ine konfig GÖRÜNÜMLERİ
  (`pg_settings`/`pg_stat_activity`/`pg_config`/`pg_hba_file_rules`/`pg_file_settings` — fonksiyon karşılıkları
  zaten reddediliyordu, görünümler açıktı).
- **[perf, migration 0035 additive]** `assignment_history` tablosunda **HİÇ index yoktu** (sipariş detayı +
  değişim geçmişi + listQuarantine tam-tablo taraması) + `assignments(created_at)` indexsizdi (velocity
  raporları seq-scan) → 3 index. listQuarantine'in 4 korele alt-sorgusu → tek join (kısmi unique index
  fan-out'u engelliyor). `/batches` TÜM envanteri satır-satır tarıyordu → `picked` CTE + LIMIT 500;
  `/customers` LIMIT 2000. **İKİSİ DE `truncated` ile DÜRÜSTÇE raporlanır** (parti seçicisi dahil) — geçmişte
  sessiz LIMIT "o müşteri yok" dedirttiği için kaldırılmıştı, aynı hataya düşülmedi. detailVelocity 30g budaması.
- **[correctness]** `bulkStatus` (WP durum yoklaması) iptal satırları paydaya katıyordu → FILTER ile
  `getDeliveries`'e hizalandı (WP ilerlemesi ile My Account çelişmiyor).
- **[a11y/ui-ux]** fiş sheet'i etiketsiz alanlar (htmlFor/id/ariaLabel) · product-edit hata `role="alert"` ·
  dağıtım durumu /releases↔/deployments'ta farklı renk+harf düzenindeydi → `labels.ts` tek kaynak
  (`deployStatusMeta`; yeni hue EKLENMEDİ).
- **[wp/docs]** Güncelleyici paket-URL'ini reddedince **SESSİZCE** güncelleme sunmuyordu → görünür yönetici
  uyarısı (reddedilen host + beklenen host; güvenlik kontrolü GEVŞETİLMEDİ — `is_secure_panel_url` kesintisinin
  dersi). Eski marka kalıntıları `jl_`/`jl-` → `wpt_`/`wpt-` (API anahtarı öneki [yalnız YENİ anahtarlar; hash
  ile karşılaştırıldığı için mevcutlar etkilenmez], webhook nonce transient'i, HTML id'leri). readme.txt
  changelog'una 1.0.1/1.0.2/1.0.3 girdileri.
- **KENDİ YAKALADIĞIM İŞÇİ HATASI:** API işçisi `sql` şablonunun İÇİNDE backtick kullanıp template'i erken
  kapatmıştı (typecheck TS1005) — bu tuzak bu projede daha önce de yaşandı. Ayrıca işçi `/batches` zarfını
  `{rows,truncated}` yapmıştı; admin okuyucuları `items` bekliyor → **sessizce BOŞ liste** olurdu, zarf
  `{items,truncated}`'a çevrildi (dev'de 8 satır render ettiği ölçüldü).
- **Doğrulama:** typecheck 4/4 + check-use-server (22 dosya / 74 export) · admin production build · VPS izole
  test DB **entegrasyon 205/205 + yarış 3/3** · yerel birim **72/72** (VPS'te 2 dosya `@lisans/shared` derlenmemiş
  diye çöktü — yerel kontrol denemesi env sorunu olduğunu kanıtladı, kod regresyonu DEĞİL) · **dev: 26 rota +
  6 detay sayfası 200, hata sınırına düşen YOK** (`scripts/smoke-routes.sh` gövdede error.tsx imzası arar) ·
  prod deploy (rollback'li) → `/health` **200 v1.0.0** (db+redis), migration tracking **36**, üç yeni index
  CANLI, api ERROR 0. migration 0000-0035.

**KUSURLU STOK İŞ İSTASYONU — üç sekme, tek süzgeç, kapsayıcı terimler (commit fd9d063→44d233d,
CANLI prod+dev, migration 0034):** Kullanıcı: *"sadece anahtar değil, birden fazla ürün varyasyonu
vs olabilir, hesap vs gibi — ilerleyen süreçte daha kapsamlı terimler anlaşılabilir hale getir;
/quarantine çok karışık, dijital ürün tedarik paneline uygun kolay anlaşılır olmalı; 'Cevap
bekleniyor' yazıyor bunu da anlamadık; rehber niteliğinde açıklamalar."*
- **TERİM (sistem geneli, sunum katmanı):** panel yalnız lisans ANAHTARI satmıyor — hesap, kod/hediye
  çeki, süreli hesap ve özel ürünler de var (§2) ve aynı ekranda **karışık** durabilirler. `labels.ts`'e
  **`itemNoun` / `itemNounPlural` / `itemCount(n, kinds)`**: küme TEK tipteyse o tipin adı ("3 hesap"),
  karışıksa **ya da tek bir kalemin tipi bile bilinmiyorsa** nötr "kalem". Nötr ad hiçbir zaman yanlış
  olmaz; özel ad okunabilirliği artırır. Uygulandı: kusurlu stok · fiş · parti (geri çekme/toplu değiştirme
  onayları ve sonuç bantları) · lisans envanteri · sipariş detayı · rehber. **Menü "Kusurlu Anahtarlar" →
  "Kusurlu Stok"** (ekranın adı kalem tipini varsaymamalı).
- **"Cevap bekleniyor" belirsizliği (kullanıcı sorusu):** rozet listelerde TEK BAŞINA da görünüyor, yani
  aktörü çevresindeki başlıktan öğrenemez → **"Tedarikçi yanıtı bekleniyor"**; `rejected` → "Tedarikçi
  kabul etmedi" (destek dilindeki müşteri reddiyle karışıyordu). Ayrıca her yanıt ve fiş durumu için tek
  cümlelik **ANLAM** sözlüğü (`claimOutcomeHint`/`claimStatusHint`) + fiş detayında dört yanıtı açıklayan
  **rozet sözlüğü** (LegendList).
- **ÜÇ SEKME (asıl karışıklık):** "Bekleyenler" sekmesi **1** derken altındaki tablo **16** satır
  gösteriyordu — çünkü havuz (iş listesi) ile defter (tüm ölü kalemler) AYNI sekmedeydi ve farkın sebebi
  hiçbir yerde yazmıyordu. Artık her sekmenin TEK işi var: **Bildirilecekler** (henüz fişe girmemiş havuz;
  tedarikçi→parti, parti satırı KATLANIR ve içindeki kalemleri gösterir — ilk 50, `<details>` kapalıyken de
  DOM'a girdiği için cap ŞART) · **Değişim Fişleri** · **Tüm Kayıtlar** (değişmez defter + süzgeç + dışa
  aktarma). Sunucu süzgeci etkinken havuzun da daraldığı açıkça söylenir (sessiz eksik liste YOK).
- **TEK ARAÇ ÇUBUĞU:** iki süzgeç kartı ve **İKİ ARAMA KUTUSU** ("Sunucu süzgeci" / "Yüklenen liste içinde
  süz") vardı; operatör hangisine yazacağını bilmiyordu. Tek kutu: **yazdıkça** yüklenen listede süzer,
  **Enter** ile veritabanındaki tüm kayıtlarda arar. Katmanların teknik farkı kaybolmadı, katlanır
  **"Nasıl çalışır?"** kutusuna taşındı. Aktif sunucu süzgeçleri de kaldırılabilir rozet oldu.
- **Satır başına "Tedarikçiye bildirim" kolonu + hızlı süzgeç** (Bildirilmedi / Fişte, yanıt bekliyor /
  Tedarikçi yanıtladı) — sekme sayacı ile liste arasındaki fark artık HER SATIRDA görünür. Yüklem sunucudaki
  `claimed` süzgeciyle BİREBİR aynı (reddedilen kalem havuza döndüğü için `claimId` boş gelir → "Bildirilmedi";
  bilinçli, tek tanım). Sayaçlar da bildirim eksenine çevrildi (Kusurlu kalem · Bildirilmedi · Fişte · Yanıtladı).
- **Yeni primitifler `ui/help-note.tsx`:** `HowItWorks` (3 adımlı akış şeridi — kusur havuza düşer → fiş
  kesilir → yanıt işlenir) · `HelpNote` (katlanır ayrıntı) · `LegendList` (rozet sözlüğü). Üçü de SUNUCU
  bileşeni ve JS gerektirmez (native `<details>`) → istemci paketine yük binmez, doğrulama tarayıcısında da
  çalışır (orada CSS animasyonu/klavye olayı çalışmıyor — belgelenmiş sınır).
- **Fiş detayı:** duruma göre "sırada ne var" şeridi (taslak → indir/gönder/işaretle; gönderildi →
  bekle/işaretle/kapat), "Sonuç" → **"Tedarikçi yanıtı"**, kalem TİPİ satırda ve indirilen raporda (**"Tür"**
  kolonu — tedarikçi kalemin hesap mı anahtar mı olduğunu bilmeli), kapanmış fişte yanıtsız kalem varsa
  dürüst bilgi bandı ("Kapandı" rozeti tek başına "her şey çözüldü" gibi okunuyordu).
- **migration 0034 (additive):** `supplier_claim_items.product_kind` snapshot + mevcut satırlar için geriye
  dönük doldurma (`UPDATE … FROM products`). `listBatches`e `p.kind` eklendi (parti tek ürüne bağlı:
  `batches.product_id NOT NULL`) → parti ekranları da doğru adı yazar. **`when` tuzağı kontrol edildi:**
  üretilen damga 0033'ten büyük (1786643071095 > 1786639201572).
- **Doğrulama:** typecheck 4/4 + check-use-server (22/74) · admin production build (`/quarantine` 18.2 kB) ·
  **VPS izole test DB: entegrasyon 200/200 + yarış 3/3 + api birim 72/72** (regresyon yok) · dev canlı:
  üç sekme (1 · 2 · 16), defter kolonları ve satır rozetleri ("Bildirilmedi" / "DEG-20260813-02 + Tedarikçi
  yanıtı bekleniyor"), TEK arama kutusu + 4 facet, breadcrumb "Kusurlu Stok › Değişim Fişleri › Detay",
  0034 backfill 18/18 · prod deploy (rollback'li) → `/health` 200 v1.0.0, migration tracking 35, api ERROR 0.
  migration 0000-0034.

**CANLI AKIŞ: YENİ SİPARİŞ FARK EDİLİRLİĞİ (admin-only, migration YOK):** Kullanıcı ekran görüntüsüyle
bildirdi: *"anlık sipariş düşüyor ama yeni sipariş olup olmadığı ekranda pek ayırt edilemiyor"*. Kök neden
KODDAN ÖLÇÜLDÜ (tahmin değil): (a) yeni kayıt vurgusu **12 sn sonra siliniyordu** (`live-provider` freshTimer)
→ 15 sn başka yere bakan operatör siparişi tamamen kaçırıyor, ekranda hiçbir kalıcı iz kalmıyordu; (b) vurgunun
tamamı 2px sol şerit + soluk zemindi, "Yeni" kelimesi yalnız `sr-only` ile ekran okuyucuya gidiyordu; (c) sekme
arkadayken poll TAMAMEN duruyordu → başka sekmedeyken gelen sipariş ne sayaçta ne başlıkta görünüyordu;
(d) kart başlığındaki sayaç toplam satırdı ("kaçı yeni" yok); (e) akıştaki siparişlerin çoğu yeşil "Teslim
edildi" olduğu için işlem bekleyen (sıcak) sipariş göze batmıyordu.
- **Kalıcı `unseen` kümesi (asıl düzeltme):** sönen `fresh` (12 sn) KORUNDU ama artık yalnız GİRİŞ
  animasyonunu sürüyor; kalıcı "görülmedi" işareti ayrı bir kümede. Satıra tıklanınca (`onOpen`) ya da
  "Okundu" düğmesiyle kalkar; **her turda budanır** (pencereden düşen id sayaçta kalıp listeyle çelişmesin).
  Satırda görünür `YENİ` pill'i (dolu `primary` — durum dilinin BEŞ hue'suna yeni renk EKLENMEDİ, çünkü
  "yeni olmak" bir durum değil okunmamışlık işaretidir), kart başlığında "N yeni" + "Okundu",
  okunmuş/okunmamış **sınır çizgisi** (yalnız yeni kayıtlar listenin BAŞINDA kesintisizse çizilir — yanlış
  yerde duran sınır, hiç olmamasından yanıltıcıdır).
- **`components/live/live-alerts.tsx` (yeni, kabukta TEK mount, render'ı yok):** sekme başlığına `(N)` öneki
  (Next gezinmede `<title>`'ı kendi effect'inde ezdiği ve sıra garantili olmadığı için **MutationObserver**
  ile yeniden basılır) + yeni kayıt **toast**'ı (tek kayıt → doğrudan siparişe "Aç"; çok kayıt → TEK özet
  toast, satır başına değil → sel yok). Kabukta olduğu için /stock, /support… her ekranda çalışır.
- **Arka plan poll'u (kullanıcı kararı):** durmak yerine **15 sn → 60 sn** seyreliyor; koşullu (ETag → 304)
  olduğu için gövde taşınmaz. Görünür sekmenin ~1/4'ü yük karşılığında arkadayken de sayaç ilerler.
- **Sıcak sipariş ayrımı:** akış kartında "Tümü / İşlem bekleyen" filtre çipi (`held` + eşlemesiz +
  `pending`/`partial`) + bekleyen satırda **5 dakikayı geçen sürenin uyarı tonuna** dönmesi (teslim edilmiş
  satırda ton HİÇ değişmez — yaşlı olması normaldir).
- **Doğrulama (tarayıcıda, canlı API'ye bağlı yerel dev; canlı yanıta sentetik sipariş enjekte edilerek):**
  sekme gizliyken **87 sn'de tam 1 poll (t=60 sn)** — eskiden 0 · başlık `(1)`→`(2)`→"Okundu" sonrası temiz ·
  satır `YENİ | az önce | #9002 | … | Bekliyor` · #9001 eklendikten ~40 sn sonra HÂLÂ `YENİ` (eski davranışta
  12 sn'de silinirdi) · toast `Yeni sipariş #9002 … [Aç]` · filtre "İşlem bekleyen 2" → teslim edilmiş sipariş
  listeden düştü · 1 ayraç + 1 `animate-feed-in`. typecheck 4/4 + check-use-server temiz + admin production
  build (`/dashboard` 9.53→10.5 kB). **Ölçülen sınır:** sekme GERÇEKTEN gizliyken sonner toast'ı DOM'a
  basmıyor (zaten görünmezdi) — o senaryoyu sekme başlığı sayacı karşılar.

**ROZET DİLİ: CANLI YÜZEY + OKUNUR METİN (admin-only, migration YOK):** Kullanıcı: *"sitede kullanılan tüm
badge'lerin renkleri ve tasarımları daha iyi/canlı olmalı"* (referans: `shadcnspace.com/components/badge` +
`dashboard.shadcnspace.com`). **REFERANS ÖLÇÜLDÜ, KOPYALANMADI:** rozeti tek renkten kuruyor
(`bg-teal-500/10 text-teal-500`, `bg-red-500/10 text-red-500`; 20px, `px-2`, `gap-1`, 11-12px/500-600,
rounded-full) — metin kontrastı hesaplandı: **teal 2.21 · kırmızı 3.30**, yani WCAG AA'nın (4.5) ALTINDA.
Panelin durum dili tablolarda okunmak zorunda olduğu için canlılık **yüzeye** taşındı, okunabilirlik metinde korundu.
- **İKİ KATMANLI RENK (yeni kural):** `--<hue>` = metin/ikon (AA zorunlu → koyu kalmak durumunda, tek başına
  "canlı" olamaz) · **`--<hue>-vivid`** = yalnız `color-mix` ile seyreltilip dolgu/halka üreten canlı taban
  (asla metin değil → kontrast kısıtı yok). Rozet dolgusunun doygunluğu **1,5–2,3 kat** arttı (oklch C:
  yeşil 0.0198→0.0391 · mavi 0.0179→0.0351 · amber 0.0208→0.0383 · mor 0.0190→0.0435 · kırmızı 0.0283→0.0428).
- **sRGB DIŞI 4 RENK DÜZELTİLDİ (sessiz kusur):** eski `--success` (#006e33), `--warning` (#8f5600),
  `--destructive` (açık #c4000e / koyu) gamut DIŞINDAYDI → tarayıcı kırpıyordu, yani ekrandaki renk yazılan
  renk değildi ve hue kayıyordu. Yeni değerlerin hepsi gamut içinde (ikili arama ile hue başına max chroma
  hesaplandı: ör. L=0.50'de yeşil max C=0.133, mor max C=0.269).
- **TEK KAYNAK `--<hue>-fill` / `--<hue>-ring`:** aynı "soluk tint" dili panelde **%12/13/14/16** olmak üzere
  DÖRT ayrı oranda kopyalanmıştı (badge · stat-tile · alert · pending/import/live-feed satır zeminleri) →
  aynı ekranda iki farklı yeşil görünüyordu. Oran artık tek yerde ve temaya göre değişir (açık %18/42,
  koyu %20/45 — koyu temada aynı yüzde daha sönük okunur). Uyarı kutusu bilinçli olarak DAHA düşük oranda
  (%9-10): büyük yüzey rozetle aynı doygunlukta olursa sayfayı bastırır.
- **GEOMETRİ (referanstan):** sabit **h-5 (20px)** — eskiden `py-0.5` ile içeriğe göre 20-22px oynuyordu ve
  aynı satırdaki iki rozet farklı boyda duruyordu · `px-2` · `gap-1` · 12px/**600** (referansın semantik rozeti
  de 600; küçük punto renkli metinde kalınlık okunabilirliği kontrast kadar etkiler) · **`whitespace-nowrap`
  ŞART** (sabit yükseklikte sarma olursa metin pill'in dışına taşar). `/quarantine` süzgeç çipi de bu geometriye
  hizalandı (kendi yorumunda "badge neutral ile aynı" yazıyordu ama artık sapmıştı).
- **DOĞRULAMA (tarayıcıda, canvas ile GERÇEK piksel):** açık tema dolgu/metin/kontrast — success #d2f3e5/#04773b
  **4.77** · info #d1eafb/#0065b0 **4.84** · warning #fdedd3/#935a00 **4.92** · attention #eee0ff/#7935c6 **5.34** ·
  danger #fdd7da/#c50721 **4.64**; koyu tema **5.35–7.27**. Hepsi AA üstü. /stock'ta 6 rozetin tamamı **20px**
  (tek yükseklik), 375px mobilde taşma **0** ve yatay kayma **0**. typecheck 4/4 + check-use-server + production build.

**MÜŞTERİLER: MAĞAZA → MÜŞTERİ HİYERARŞİSİ (migration YOK):** Kullanıcı: *"customers bölümünde direkt
müşteriler çıkıyor; genel aramada yapılabilir ama onun haricinde sitelere bölünmeli, kategori gibi —
sitenin içine girip müşterileri görebilmek daha sağlıklı, karışıklık olmasın"*. Önceki turda site
süzgeci EKLENMİŞTİ ama giriş ekranı hâlâ düz müşteri listesiydi; hiyerarşi opsiyoneldi, varsayılan değildi.
- **Üç hâl, hepsi paylaşılabilir URL:** `/customers` → **mağaza kartları** (domain + tip + müşteri/sipariş
  sayacı + son sipariş) · `/customers?q=` → **sunucu-taraflı arama** (hiyerarşiyi ATLAR) · `/customers?site=`
  → o mağazanın müşterileri (mevcut davranış birebir korundu, "Siteler" kolonu gizli).
- **Arama site süzgecini bilinçli EZER:** mağaza içindeyken yapılan arama o mağazayla sınırlı kalsaydı
  operatör "aradığım müşteri yok" sanardı (bu panelde sessiz-kırpma sınıfı hatanın aynısı). Arama native
  `<form method=get>` — JS'siz çalışır, sonuç adres çubuğunda paylaşılabilir.
- **Yeni uç `GET /v1/admin/customers/site-summary`** (site başına DISTINCT e-posta + sipariş + son sipariş).
  **Rota `:email`ten ÖNCE tanımlandı** — Nest rotaları tanımlanma sırasına göre eşler; altta kalsaydı adres
  `email="site-summary"` olarak DETAY ucuna düşerdi (sessiz 404). **LEFT JOIN**: siparişi olmayan mağaza da
  listede kalır (yeni bağlanan mağaza görünmezse operatör "bağlantı kurulmadı mı?" diye arar).
- **Veri modeli DEĞİŞMEDİ:** müşteri kaydı hâlâ e-posta bazlı GLOBAL (etiket/not tek kayıt), hiyerarşi yalnız
  sunumda. Aynı e-posta iki mağazadan alışveriş yaptıysa her iki mağazada da sayılır → site sayaçlarının
  toplamı global müşteri sayısından büyük olabilir (kod yorumunda yazılı).
- **Dağıtım sapmasına dayanıklı:** `site-summary` eski API'de yoksa ekran hata kartına DÜŞMEZ — eski düz
  listeye geri döner + görünür bilgi bandı (admin ve api ayrı imajlar, biri önce dağıtılabiliyor).
- **Dev'de gerçek veriyle E2E:** mağaza kartı (1 müşteri · 7 sipariş · son sipariş 14.08) → siteye giriş
  (müşteri satırı, "Siteler" kolonu gizli) → `?q=admin` (tüm mağazalarda bulundu, "Siteler" kolonu görünür) →
  `?q=zzzyok` (boş sonuç). **Boş sonuçta tablo çizilmiyor:** ilk denemede "Sonuç yok" uyarısının altında boş
  tablo + "0 kayıt · Sayfa 1/1" duruyor ve mesajı gölgeliyordu → tek boş durum + mağaza listesine dönüş.
  typecheck 4/4 + admin production build.

**ÜRÜN KATEGORİLERİ + KART TABANLI STOK EKRANI (migration 0037+0038):** Kullanıcı: *"panel ürünleri direkt
görünüyor ya, karışıklığı gidermek için kategorizasyon yapsak? office lisansları, windows lisansları, yapay
zeka lisansları, oyun hesapları gibi ayrıştırabilsek; card tarzı UI/UX açısından daha kullanışlı; ayrıca
rehber niteliğinde daha açıklayıcı anlatımlar iyi olur — panel ürünü ekleniyor sonra sitelerdeki ürünlerle
eşleştiriliyor, bunlar kolaylaştırılmalı"*. **KULLANICI KARARI (soruldu, "anlamadım" dedi → sade dille tekrar
soruldu): AYRI "Kategoriler" ekranı** — ürün formunda serbest metin YOK, yalnız listeden seçim (ad tek kayıt,
ikiz kategori olmaz, ad değişince her yerde değişir).
- **0037 (additive):** `product_categories` (name/description/sort_order) + `products.category_id`
  **ON DELETE SET NULL** — kategori silinince ÜRÜN SİLİNMEZ, "Kategorisiz" olur (RESTRICT olsaydı operatör
  önce her ürünü elle taşımak zorunda kalırdı; ürünü silmek ise stok/sipariş taşıdığı için felaket olurdu).
  Silme yanıtı `uncategorizedProducts` döner → onay modali ve sonuç mesajı kaç ürünün etkilendiğini SÖYLER.
- **0038 — TÜRKÇE İKİZ AÇIĞI (dev'de ÖLÇÜLDÜ, kendi ilk sürümümün kusuru):** düz `lower()` unique index'i
  `"WINDOWS LİSANSLARI"`yı kabul ediyordu (201) çünkü en_US.utf8'de `lower('LİSANSLARI')`="lisanslari" ama
  `lower('lisansları')`="lisansları" — İ/I/ı/i dört varyantı farklı sayılıyor. Index artık
  `lower(translate(name,'İIı','iii'))`. Bilinçli yan etki: "Sıra"/"Sira" da çakışır (Türkçe panelde zaten
  karıştırılacak iki ad). Ş/Ğ/Ç/Ö/Ü'yü Unicode `lower()` doğru çeviriyor (ölçüldü).
- **`/stock` ÜÇ HÂLLİ** (müşteriler ekranıyla BİREBİR aynı gezinme dili — tek desen): kategori kartları ·
  `?q=` tüm ürünlerde arama (hiyerarşiyi atlar) · `?category=` kategori listesi ('none' = Kategorisiz).
  Kart: ürün sayısı + **atanabilir KAPASİTE** (Σ max_uses−use_count, satır sayısı DEĞİL — MAK'ta 1 anahtar
  500 kullanım taşır) + düşük stok rozeti. Süresi geçmiş kalem sayılmaz (assign.ts yüklemiyle aynı).
  "Son Eklenen Lisanslar" YALNIZ giriş ekranında (kategori içindeyken bağlamsız veri çelişki yaratırdı).
- **Yeni `/categories`**: ekle/yeniden adlandır/açıklama/sıra/sil + 3 adımlı rehber şerit. Menüde Envanter
  altında. Ürün formuna kategori alanı, tabloya kategori kolonu + faceti (yalnız >1 grup varsa).
- **SESSİZ VERİ KAYBI KORUMASI:** ürünün MEVCUT kategorisi seçenek listesinde yoksa (çağıran listeyi
  geçirmemişse) tarayıcı ilk seçeneği ("Kategorisiz") seçer ve "Kaydet" ürünü sessizce kategorisinden
  çıkarırdı → form mevcut kategoriyi her hâlükârda seçenek olarak basar.
- **BUILD TUZAĞI (yaşandı):** `UNCATEGORIZED` sabiti 'server-only' `queries.ts` içindeydi ve istemci
  bileşenleri onu ÇALIŞMA ZAMANI değeri olarak import ediyordu → `next build` "server-only in a Client
  Component" ile kırıldı (typecheck yakalamaz). Ortak sabit/tip `lib/categories.ts`'e taşındı.
- **Doğrulama (dev, gerçek veri):** migration boot'ta uygulandı · kartlar "Windows lisansları 1 ürün/0 stok"
  + "Kategorisiz 1 ürün/2 stok" (gerçek stokla birebir) · kategoriye giriş listesi · geçersiz kategori id
  **404** (FK 500 değil) · Türkçe ikiz **409**, farklı ad **201** · silme → `uncategorizedProducts:1` ve ürün
  Kategorisiz kovaya döndü. typecheck 4/4 + check-use-server 23/77 + admin production build.

**KATEGORİ EKRANI SADELEŞTİRME + DAR EKRAN TABLOLARI (commit 12b334f→f411d2f, dev'de canlı):** Kullanıcı
ikinci tur geri bildirim: *"daha sade minimal olmalı, yükseklik olarak çok yer kaplıyor; stoğu fazla olan
kategorileri en başta göstermelisin; çok kategori olursa tasarımsal çözüm ne; küçük/dar ekranlarda son eklenen
lisanslar sıkışıyor, yana kaydırma sorunu var, tablolar çok yüksek duruyor"*. Hepsi ÖLÇÜLEREK yapıldı.
- **Rehber şerit `compact`:** tek satır adım başlıkları (`1 Panel ürünü › 2 Stok girişi › 3 Mağaza eşlemesi`)
  + native `<details>` altında cümleler. **110px → 34px** (ölçüldü), öğrenilebilirlik kaybolmadı.
- **Kategori sırası:** Kategorisiz her zaman SONDA → sabitlenmişler (`sort_order>0`) → **atanabilir stok
  çoktan aza** → ad. "Sıra" alanı "**Sabitleme sırası**" oldu (0 = otomatik) — aksi halde bu alan stok
  sıralamasını sessizce ezerdi ve 0'ın ne demek olduğunu kimse bilemezdi.
- **Kart tek satıra indi** (110px → **60px**): açıklama `title` ipucuna taşındı. **Çok kategori çözümü:**
  8'i geçince Türkçe-duyarlı (`includesTr`) süzme kutusu + ızgara 2xl'de 4 kolon; sayfalama YOK (operatör
  adı biliyor, tıklayarak aramaz).
- **İKİ POSTGRES HATASI (dev'de 500, ölçülerek bulundu):** (1) `0A000` — bir UNION'ın DOĞRUDAN ORDER BY'ı
  yalnız çıktı kolon ADI kabul eder, `(id IS NULL)` gibi ifade "Only result column names can be used" verir →
  iki dal `cards` CTE'sine alındı; (2) `42601` — CTE zincirinde eksik virgül. Ayrıca `sql` şablonu içindeki
  YORUMDA backtick kullanmak şablonu erken kapattı (**bu projede 4. kez**) → o blokta ters tırnak yasak notu düşüldü.
- **DAR EKRAN — kolon gizlemek YETMEDİ (375px ölçümü):** kalan 4 kolonun min-content genişliği **856px**, kap
  **291px** → tablo hâlâ **565px** yana kayıyordu (tek parça monospace anahtar + ürün adı/SKU + iki metin
  düğmesi). 5 kolonlu tablo 291px'e SIĞMAZ → **md altında satır KARTA dönüşür** (hücre bileşenleri aynen
  yeniden kullanılır, ikinci doğruluk kaynağı yok); md üstünde tablo aynen. Sonuç: yatay kayma **0**, taşan
  öğe **0**. Süzgeçler mobilde 2 kolonlu ızgara (4 satır ~200px → ~100px). `PageHeader` eylem alanı artık
  sarıyor (üç düğmeli başlıkta blok 388px'e çıkıp viewport'tan taşıyordu: düğme sağ kenarı 404 > 375).
- **SAYFA BOYU ÜÇ YERDE TANIMLIYDI** (bileşen · sunucu action · API servisi): kutuda "10 kayıt" seçiliyken
  tablo **25 satır** gösteriyordu — action listede olmayan değeri ilk seçeneğe düşürüyordu (kullanıcıya yalan
  söyleyen kontrol). Admin tarafı `lib/license-page-sizes` TEK kaynağından okur; geçersiz değerde 25'e düşer
  (liste başına 10 eklenince "pageSize'sız" tüm çağrılar sessizce 10 satıra düşerdi). API listesi de 10 aldı.
- **Ölçülen sonuç:** /stock masaüstü sayfa yüksekliği **3165px → 1672px**; mobilde yatay kaydırma **565px → 0**.
- **KENDİ HATAM:** `sed` ile eklemeye çalıştığım import dosyadaki gerçek biçime uymadığı için hiç eklenmedi ve
  **typecheck'i kırık commit'i push ettim** (d23983c) → bir sonraki commit'te düzeltildi. Ders: push'tan önce
  typecheck ÇIKTISINI oku, "Tasks: N successful" satırını gördüğünü varsayma.

**LİSANS GÖRÜNÜRLÜĞÜ + KAPSAMLI ARAMA (commit c884ba9→c5d4383, dev'de canlı):** Kullanıcı: *"küçük ekranlarda
hâlâ sorun var, lisans tamamen görünmüyor son haneleri; arama kısmını da iyileştir, lisansı tam haliyle de
arayabilelim gibi düşün, daha kapsamlı"*.
- **Kırpma kaldırıldı:** anahtar `truncate` ile tek satıra sıkışıp sonu "…" oluyordu ve kaybolan kısım tam da
  kalemi AYIRT EDEN son hanelerdi. **Ama `break-all` tek başına DAHA KÖTÜ oldu** (ölçüldü): tabloda bir
  hücrenin min-content'ini tek karaktere indirdiği için kolon 1440px'te bile 140px'e eziliyor ve anahtar
  5 satıra sarıyordu. ÇÖZÜM İKİ YOLLU: **tabloda (lg+) tek satır** + kolon tabanı `min-w-[19rem]`;
  **kartta (lg altı) sarma**. İkisinde de hiçbir hane kaybolmuyor (`kirpik:false` ölçüldü).
- **Arama artık üç eksende:** (1) **TAM anahtar** — `payload_hash` eşitliği (şifreli payload'da LIKE
  yapılamaz, hash anahtarlıdır → DB'yi ele geçiren bu aramayı yapamaz); (2) mevcut **son 5 hane**
  (`payload_suffix_hash`); (3) YENİ **ürün adı + SKU** (operatör "bu üründen kaç kalem var" diye arıyordu,
  liste boş dönüyordu). **Biçim toleransı:** ham / boşlukları sadeleşmiş / boşluksuz ve her birinin BÜYÜK
  harflisi denenir (≤6 hash) → kopyala-yapıştır farkı "sonuç yok" demez. `page_slice` VE `count` sorgusuna
  `products` LEFT JOIN eklendi (süzgeç fragmanı ikisinde birebir aynı olmalı, yoksa toplam ile liste ayrışır).
  İpucu metni gerçeğe hizalandı ("yalnız son 5 hane" artık yanlış bilgiydi).
- **DAR EKRAN — kart eşiği md→lg:** 900px'te sayfa kaymıyordu ama TABLO kendi kabında **568px** kayıyordu.
  Kartlar artık `lg` altında; tabloda Teslimat `xl`, Kapasite/Parti/Eklenme `2xl`; ürün kolonu dar bantta
  `max-w-36`; **tablodaki aksiyon etiketleri gizli** (ikon + aria-label; kartta etiketler DURUYOR — orada yer
  var); teslimat hücresinde mağaza alan adı kırpılır (min-content'i tek uzun token belirliyordu); Eklenme
  yalnız tarih (saat `title`'da).
- **Ölçülen sonuç:** 375px kart görünümü — yatay kayma **0**, anahtar tam, düğme etiketleri görünür ·
  900px kart — **0** · 1100px tablo (4 kolon) — **0** · 1600px tam tablo (9 kolon) — 1332px içerik / 1222px kap,
  **110px** iç kaydırma kaldı (başlangıç 216px). Bu bant bilinçli kabul: dokuz kolonluk operasyon tablosu
  1222px'e sığmaz, proje kuralı gereği geniş tablo KENDİ kabında kayar; asıl şikâyet (dar ekran + kırpma) kapandı.

**SEKİZ ÖNERİ MADDESİ B1–B8 (commit 10c44fd→ed92a9e, CANLI prod+dev, migration 0040):** Kullanıcı bir
önceki turda sunduğum öneri listesinin **tamamının** testleriyle birlikte uygulanmasını istedi. Altı
paralel işçi (ayrık dosya kümeleri) + merkezî tümleştirme. **Şema değişiklikleri BİLEREK tek elde
toplandı** — üç madde şema istiyordu ve üç işçi eşzamanlı migration üretse drizzle `_journal.json`
dosyasında çakışırdı. **migration 0040** (additive + `IF NOT EXISTS`; `when` sırası ve drift kontrol
edildi → `db:generate` "No schema changes").
- **[B3] `/audit` denetim izi ekranı:** `audit_log` doluydu (her reveal/revoke/import/login bir satır)
  ama onu LİSTELEYEN hiçbir uç yoktu → "bu anahtarı kim gösterdi", "bu siparişi kim iptal etti"
  soruları ancak veritabanına ELLE bağlanarak yanıtlanıyordu. Salt-okunur (yazma ucu bilerek YOK —
  denetim izinin değeri değiştirilemez olmasından gelir), aktör/hedef/eylem/tarih/trace süzgeçleri,
  `meta` redaksiyon kalkanı (bugün no-op: 30 yazar tarandı, sır girmiyor — GELECEK için), toplam
  `LIMIT CAP+1` ile SINIRLI sayılır ve aşımda `totalCapped` ile DÜRÜSTÇE söylenir (süzgeçsiz
  `count(*)` her açılışta tam tablo taraması olurdu). Üç bileşik indeks — ikinci kolon **DESC**
  (yön ayna değildir, 0031 dersi). Görüntüleme audit'e YAZILMAZ (kendini besleyen döngü olurdu).
- **[B4/B5] İki yeni rapor.** `/reports/sla`: "anında" ↔ "bekledi" ayrımı uydurma bir eşik DEĞİL
  **yapısaldır** — `createOrder` siparişi ve atamalarını tek transaction'da yazar, iki tablonun
  `created_at` varsayılanı da `now()` (tx başlangıcı) → anında teslimde fark **tam 0**, `autoComplete`
  ayrı tx olduğu için hep sıfırdan büyük. `avg` yanında **p50/p95** (birkaç uzun bekleme ortalamada
  kaybolur); held/iptal/bonus/**değişimle verilen taze anahtar** hariç ve kaç tanesinin elendiği
  yanıtta yazılı; tamamlanmamış siparişler `stillOpen` ile ayrı (kohort dürüstlüğü).
  `/reports/reorder`: hız + o ürünün tedarikçisinin GERÇEKLEŞEN tedarik süresi (yüklem
  `SuppliersService.scorecard` ile BİREBİR aynı); süre bilinmiyorsa **öneri ÜRETİLMEZ** (varsayılan
  uydurulmaz), yalnız tükenme tahmini; MAK'ta birim-adet çevrimi açık (karıştırılsa 500 kat hata).
- **[B8] TOTP iki faktörlü giriş:** RFC 6238 + RFC 4648 elle yazıldı — **sıfır yeni bağımlılık** (QR
  kütüphanesi de eklenmedi: yeni tedarik-zinciri yüzeyi + sunucuda üretilen QR'ın log/proxy'ye düşme
  riski; her authenticator "anahtarı elle gir"i destekler). Sır AES-256-GCM envelope + AAD
  `admin_user:<id>`; tekrar-oynatma defteri Redis `SET NX` (**fail-CLOSED** — bu bir kimlik doğrulama
  adımı, hız sınırı gibi fail-open olamaz); lockout parola denemeleriyle **AYNI kovada** (ayrı kova,
  parolayı bilene 6 hane için TAZE bütçe vermek olurdu); oturum çerezi YALNIZ ikinci adımdan sonra —
  arada 5 dk'lık, imza anahtarı SESSION_SECRET'ten AYRI TÜRETİLMİŞ (`totp-pending-v1`) ve `typ` alanlı
  beklet-token'ı var, yani bir beklet-token'ı ASLA geçerli oturum olarak doğrulanamaz. `totp_enabled`
  kullanıcı ilk kodu doğrulayana kadar false (yanlış kurulumda hesap kendini kilitlemez); owner
  sıfırlaması `token_version` +1. **Yedek kod ÜRETİLMEDİ** (ayrı hash'li kasa + indirme UX'i gerekir —
  kapsam dışı, raporlandı). `/admins/security` **owner kapısı YOK** ve sol menüde AYRI öğe: `/admins`
  owner-only olduğu için oradan link vermek 2FA'yı tek kişilik bırakırdı.
- **[B7] Panelden yedek + geri-yükleme tatbikatı:** dağıtımla AYNI kuyruk (tek-aktif-iş garantisi
  ikisini birden kapsar) ama **ayrı runner + `claimNext(targets)` filtresi** — filtresiz iki cron
  runner birbirinin işini claim eder ve claim geri alınamadığı için iş KAYBOLURDU (`targets` alanı
  opsiyonel, eski runner sürümü kırılmaz). `/deployments`'ta yaş / boyut / **dış kopya** durumu +
  bayatlık bantları; özet ayrı tablo değil `deployments` satırlarından türetilir. Panel konteynerine
  Docker soketi VERİLMEZ (istek/çalıştırma ayrımı korundu). Offsite yalnız KANCA (`BACKUP_OFFSITE_CMD`,
  tek argüman, `eval` yok) — uydurma sağlayıcı entegrasyonu yok.
- **[B1/B6] Kayıtlı görünümler + envanter dışa aktarma:** görünümler URL query'sini saklıyor, bu yüzden
  `DataTable`'a opt-in **`syncUrl`** eklendi (arama/facet/sıralama `tq`/`tf.<kolon>`/`tsort` ile adrese
  yazılır; sayfanın KENDİ parametreleri korunur; facet listesinde olmayan `tf.*` filtre ENJEKTE EDEMEZ).
  `/orders`'ta menü zaten bağlıydı ama süzgeçler istemci state'inde durduğu için **BOŞ görünüm
  kaydediyordu**. URL yazımı `window.history.replaceState` ile: `router.replace` her tuş vuruşunda
  sunucu bileşenini yeniden çalıştırırdı, `useSearchParams` ise her çağıran sayfaya Suspense sınırı
  dayatırdı. Geri yükleme **tam gezinme** (yumuşak gezinme aynı rotada tabloyu yeniden KURMAZ →
  "geri yükledim sanıp yüklememek"). Dışa aktarma AYRI sunucu ucu (istemci sayfa döngüsü 50 ayrı reveal
  audit'i üretir + sayfalar arası mükerrer/atlanmış satır doğururdu), düz metin **yalnız owner** + TEK
  reveal audit; owner-olmayan maskeli dosya alır ve reveal GERÇEKLEŞMEDİĞİ için audit de YAZILMAZ
  (canlıda doğrulandı: `masked:true` + `••••••83GT`).
- **[B2] Mağaza sessizlik alarmı** (`sites.last_seen_at`): damga HmacGuard'da **imza doğrulandıktan
  SONRA** yazılır — doğrulanmamış istek canlılık üretebilseydi ölü bir mağaza "canlı" gösterilip alarm
  susturulabilirdi ve sinyalin saldırganca kapatılabilir olması hiç sinyal olmamasından BETERDİR.
  60 sn throttle hem uygulamada (bayat `req.site` ile ön eleme) hem SQL'de (asıl güvence).
- **ENTEGRASYON PAKETİNİN YAKALADIĞI 2 SORUN (typecheck + build TEMİZ geçiyordu):** (1) **`/audit`
  tarih süzgeci HER ZAMAN 500 veriyordu** — ham `sql` fragmanına `Date` NESNESİ konmuştu; postgres.js
  bind'de `ERR_INVALID_ARG_TYPE` atıyor (drizzle'ın kolon-farkında yolu Date kabul eder, ham fragman
  ETMEZ). Projenin mevcut deseni uygulandı: ISO dize + açık `::timestamptz`. (2) TOTP testleri kurulum
  onayı ile girişte AYNI 30 sn'lik adımı kullanıyordu; defter bu ikisi arasında ORTAK (RFC 6238 §5.2,
  **kasıtlı**) → "geçerli kod reddedildi" gibi görünen 3 başarısızlık. Ürün doğruydu, test kırılgandı;
  yardımcı önceki adımı tüketiyor + davranış `(d2)` ile AÇIKÇA kilitlendi.
- **Yol boyunca:** güvenlik olayı etiketleri tek kaynağa (`labels.ts`) toplandı ve ekrana özel yerel
  sözlük kaldırıldı (aynı ekranda iki sözlük bu projede çelişen etiket üretmişti) · breadcrumb
  `sla`/`reorder`/`costs` (`costs` uzun süredir ham İngilizceydi) · `security` anahtarı breadcrumb
  sözlüğüne EKLENMEDİ (NAV spread'inin üstüne yazıp `/security` ekranının etiketini değiştirirdi) ·
  `smoke-routes.sh`'a 5 yeni rota · rehbere `/audit`, `/reports/sla`, `/reports/reorder`,
  `/admins/security` ve yedekleme bölümleri; "kayıtlı görünüm yalnız Siparişler'de" iddiası ve
  "filtreler adres çubuğuna yansır" vaadi artık GERÇEĞE uyuyor.
- **Doğrulama:** typecheck 4/4 (src+test) · check-use-server 25 dosya/86 export · api birim **124/124** ·
  admin birim **131/131** (+10 URL durumu testi; **test dosyası `lib/` altına konmalı** — `include`
  dışında kalan dosya `passWithNoTests` yüzünden SIFIR test koşar ve yeşil görünür) · build 3/3 ·
  VPS izole test DB **entegrasyon 333/333 + yarış 3/3** · dev: 0040 uygulandı (tracking 41), **30 rota
  200, hata sınırına düşen YOK**, canlı uç doğrulaması (audit tarih süzgeci 200 / geçersiz action 400,
  SLA 7 ölçüm p50 38,9 sn p95 62,9 sn, reorder gerçek ürün 6 gün kaldı, export owner-admin farkı,
  yedek özeti dürüst "hiç yedek yok") · prod `deploy.sh api admin` (rollback'li) → `/v1/health`
  **200 v1.1.0**, migration tracking **41**, `audit_log` 4 indeks canlı, api **0 ERROR**.
- **OPERATÖRÜN YAPMASI GEREKENLER (kod değil, ops):** yedek runner'ının cron satırları + **offsite
  kancası** (`BACKUP_OFFSITE_CMD` — kurulmazsa yedek yalnız bu sunucuda kalır) + `BACKUP_KEEP_LAST`
  disk planı; hepsi `docs/RUNBOOK-DR.md` §4.3-4.4'te. MASTER_KEY yedeğin İÇİNDE DEĞİL — ayrı kasada
  çevrimdışı iki kopya.

**PROJE GENELİ 6-LENSLİ DENETİM → 40 BULGU (commit 6fb406d→dfc85fc, CANLI prod+dev, migration 0041):**
Kullanıcı "projeyi baştan sona adım adım kontrol et, güvenliği/kullanımı etkileyen sorunları bul ve
düzelt — işçilerinle" dedi. Altı lens (auth/2FA · veri ifşası/RBAC · sipariş invaryantları · rapor/DB ·
arayüz · ops/betik/WP) çekişmeli-doğrulamalı ajanlarla tarandı (her bulgu ÇÜRÜTME denemesinden geçti),
sonra beş paralel işçi + merkezî tümleştirme.
- **[CANLI ÖLÇÜM — statik analiz göremezdi] Dört süpürme işi prod'da İKİ KEZ koşuyordu.** Redis'te
  `expiry`/`low-stock`/`reconcile`/`daily-digest` (+`security`) kuyruklarının İKİŞER aktif zamanlayıcısı
  vardı: biri kararlı kimlikli yenisi, diğeri eski `queue.add(..., {repeat})` çağrısından kalan HASH
  anahtarlı yetim. **Redis dağıtımlar arasında kalıcı** olduğu için kod düzeltildiğinde eski kayıtlar
  SİLİNMEMİŞTİ — CLAUDE.md'deki "yetim çift-zamanlama yok" güvencesi yalnız İLERİDEKİ değişiklikler için
  doğruydu. **Kanıt (prod verisi):** `notifications`'ta `digest_alert` günde tam **2** satır, damgalar
  `08:00:00.121` ve `08:00:00.132` → iki zamanlayıcı aynı dakikada ateşliyor; Telegram açık olsaydı
  operatör her sabah aynı kritik alarmı iki kez alırdı. Düzeltme `queue/sole-scheduler.upsertSoleJobScheduler`:
  upsert'ten sonra beklenen kimlik DIŞINDAKİ zamanlayıcıları siler (boot'ta koşar → kendi kendini onarır;
  ileride bir schedulerId yeniden adlandırılsa eskisi de temizlenir). Dağıtımda **5 yetimin silindiği
  loglandı**, ZSET'ler tek zamanlayıcıya indi. +3 entegrasyon testi (gerçek Redis).
- **[CANLI ÖLÇÜM] `ADMIN_TOKEN` her admin isteğinde DÜZ METİN loglanıyordu** — prod API logunda son 1
  saatte **30 satır**. pino-http `req`i o isteğin HER log satırına bağlar ve redact listesinde
  `x-admin-token` YOKTU. Bu token `AdminGuard`ın tek kapısı ve `x-admin-role` gönderilmediğinde
  `OwnerGuard` da geçirdiği için **log okuma yetkisi TAM panel kontrolüne yükseliyordu**. İki lens
  bağımsız buldu. NOT: `x-admin-actor` bilerek maskelenmedi (operatör kimliği olay müdahalesinde gerekli,
  zaten `audit_log`'da; müşteri PII'si değil). **OPS: token ROTASYONU gerekir — log geçmişinde duruyor.**
- **ÇEKİRDEK PARA YOLU (H1 ailesi, 5. tur):** `syncRefunds` `canceled_units` defterini uzlaştırmıyordu
  (`reconcileOrder` uzlaştırıyor) → aynı iptal İKİ KEZ sayılıyor, hedef `fulfilled`in ALTINA düşüyor ve
  **değişim yolu KALICI kilitleniyordu** (`completeLine` remainingUnits=0 → 409 "stok yok", stok VARKEN);
  müşteriye "2/1" ilerlemesi. · Admin manuel iptali MAK kapasitesini havuza geri veriyordu (controller
  `returnMultiCapacity` varsayılanını `true` bırakmıştı; aktivasyon sağlayıcı tarafında HARCANMIŞ →
  sessiz aşırı-satış) — iade yolları `false` geçerken panelden iptal `true` geçiyordu. · `rejectHeld`
  kaçak atamaları ham `UPDATE assignments` ile kapatıyordu: `license_items` durumu/`use_count`/
  `fulfilled_qty` güncellenmiyor + yalnız `active` süzülüyordu → tek-kullanımlık kalem KALICI `assigned`
  limbosunda (sessiz stok kaybı) ve reconcile KALICI kritik alarm üretiyordu. · Satır durumu üç yerde ham
  `qty` ile hesaplanıyordu → satır kalıcı `partial`. · Geri çekilen partideki MAK anahtarı kapasite
  iadesiyle havuza dönebiliyordu (recall yalnız `available` kalemleri void'liyordu). · Toplu geçersiz
  kılma canlı atamalı kalemi void'liyordu (tekil yol 409 verirken).
- **RAPOR/DB:** "kaç birim eksik" yükleminin İKİ tanımı vardı (`qty−fulfilled_qty` vs kanonik
  `qty−canceled_units`) → stok girişi onay modali ("N bekleyen birimi teslim eder"), bekleyen kuyruğu ve
  "neden bekliyor" tanısı YANLIŞ sayı gösteriyordu → `fillTargetSql`/`remainingUnitsSql` tek kaynağı. ·
  `deliveredCogs` yalnız `active` sayarken aynı ekrandaki satış hızı `active+suspended+expired` sayıyordu
  → **`STANDING_STATUSES` `assignment/assign.ts`e taşındı** (`notExpiredCond` ile aynı gerekçe), reconcile'ın
  yerel kopyası da oradan okuyor. · `reorder` satışsız-ürün sayacı `FILTER` İÇİNDEKİ `NOT EXISTS` yüzünden
  ürün başına SubPlan koşuyordu (sublink pullup yalnız qual konumunda çalışır) → tek geçiş. ·
  `/purchase-orders` SINIRSIZ + indekssiz sıralamaydı (tablo HER stok girişinde büyüyor) → tavan+`truncated`
  + **migration 0041** `purchase_orders_created_idx (created_at DESC, id DESC)`.
- **GÜVENLİK/GİZLİLİK:** owner-olmayan admin **2FA'yı HİÇ açamıyordu** — `apiPost/apiSend` aktörü
  çağırandan bekliyordu, TOTP aksiyonları geçmiyordu → API `'panel:admin'` fallback'i → `assertSelfOrOwner`
  403; ekran açılıyor, düğme çalışmıyordu. Düzeltme TEK NOKTADA (aktör verilmezse OTURUMDAN alınır, `apiGet`
  ile simetrik) → aynı sınıf unutma bir daha doğmaz + tüm yazma yollarında denetim izi gerçek admine bağlanır.
  · Kendi 2FA'sını kapatmada parola+kod artık ROLDEN BAĞIMSIZ (panel formu ikisini de ZORUNLU topluyordu ama
  API owner için yok sayıyordu → arayüzün verdiği güvence gerçekte yoktu). · `/totp/disable` hız sınırsızdı
  (her deneme bir scrypt, aynı event loop teslimatı servis ediyor). · `rotate-secret` `OwnerGuard` taşımıyordu
  (uç yeni `apiKey`+`hmacSecret`i ÇAĞIRANA döndürür → o kimlikle site-facing reveal imzalanabilir). ·
  `totp_secret_enc` readonly-sql sır listesindeki TEK eksikti. · Tedarikçi fişinde düz metin DÖNMEDEN
  `reveal` audit'i yazılıyordu (owner-olmayan kesti ⇒ snapshot zaten maskeli). · **KVKK:** anonimleştirme
  `saved_views.query` kasasını atlıyordu ve **`URLSearchParams` `@`→`%40` kodladığı için mevcut e-posta
  deseni kaçırıyordu** → ayrı kodlanmış-varyant deseni. · Sentry `beforeSend` (DSN varsayılan boş).
- **OPS:** yedek yolu HİÇBİR alarm kanalına bağlı değildi (cron kurulmamışsa/token bozuksa aylarca sessiz;
  tek işaret operatörün açmayabileceği bir sayfadaki bant) → `BackupAlarmService` (`backup_stale` critical /
  `drill_stale` warning, dedupe'lu) + runner claim'de HTTP hatası "iş yok"tan ayrıldı. · 30dk zombi eşiği
  RTO≤2sa hedefiyle çelişiyordu: uzun TATBİKAT 30dk sonra "failed" sayılıp tek-aktif kilidini açıyor, deploy
  tatbikat sürerken koşuyordu (docker build/up ⟷ pg_restore) → hedefe-göre eşik + `finish` CAS. · Rotasyon
  BAŞARISIZ yedekten sonra da doğrulanmış dump siliyordu. · `SITE_SILENCE_HOURS` compose'tan geçmiyordu
  (`.env`'e yazmak SESSİZCE etkisiz — bu projede yaşanan hatanın tekrarı). · `SecurityProcessor` tek alarmsız
  sweep'ti. · CI'a `bash -n` eklendi ve **ilk koşuda `wp-dev.sh`'ta dengesiz tırnak buldu → `pnpm wp:dev`
  FİİLEN ÇALIŞMIYORDU.** · WP `run_diagnostics` klon guard'sızdı ("HMAC geçerli 🟢" derken push/revoke klon
  guard'ıyla kapalı → yanlış teşhis). · `.dockerignore` `backups/` içermiyordu (14 dump her build'de daemon'a).
- **ARAYÜZ:** kayıtlı görünüm tablo içi süzgeçleri SESSİZCE kaybediyordu — uyarı yalnız adres TAMAMEN boşken
  çıkıyordu, asıl tehlike "adres dolu ama eksik"ti → `/stock`+`/customers` `syncUrl`, `/quarantine/records`+
  `/mappings` görünür uyarı (oralarda süzgeç bilinçli olarak tablonun DIŞINDA). · Rehberde İKİ YANLIŞ VAAT:
  "gecelik yedek otomatiktir" (gerçekte ELLE kurulan cron; panelin kendi metniyle çelişiyordu) ve "filtreler
  adres çubuğuna yansır" (5 ekranın 4'ünde yansımıyordu — bu iddiayı bir önceki turda BEN genişletmiştim). ·
  2FA kurtarma yolu native doğrulamayla KİLİTLİYDİ (`formNoValidate` yok). · `/admins/security` breadcrumb'ı
  `/security` ile ÇAKIŞIYORDU → TAM YOL sözlüğü (segment sözlüğüne `security` eklemek `/security`yi bozardı,
  ölçüldü) + ara kırıntı link DEĞİL (owner-olmayan "Yetkiniz yok" çıkmazına gidiyordu). · Boş tabloda
  "kayıt yok" ile "süzgeçle eşleşen yok" ayrıldı — **bu riski benim `syncUrl` değişikliğim doğurdu**
  (süzgeçli adres artık paylaşılabildiği için sayfaya süzgeç AÇIKKEN girilebiliyor).
- **Doğrulama:** typecheck 4/4 (src+test) · check-use-server 25/86 · api birim 124/124 · admin birim 135/135 ·
  admin build ✓ · `bash -n` 9/9 · PHP-lint 13/13 · VPS izole test DB **entegrasyon 357/357** (333 → +24,
  10 yeni dosya) **+ yarış 3/3** · dev: temiz boot (**`security.module` glue'su olmasa API HİÇ AÇILMAZDI** —
  `tsc`/`build` çalışma-anı DI hatasını yakalamaz), 30 rota 200, yedek alarmı gerçekten üretti · **tarayıcıda
  ölçüldü:** `?site=` korunurken tablo araması `tq=`ye yazıldı ve süzgeçli adres geri yüklendi · prod
  `deploy.sh` (rollback'li) → `/health` **200 v1.1.0**, migration tracking **42**, 5 yetim silindi (loglandı),
  api **0 ERROR**.
- **OPERATÖRE KALAN (kod değil):** **ADMIN_TOKEN rotasyonu** (log geçmişinde düz metin duruyor) ·
  prod SMTP hâlâ `mailpit` (mailler gerçek müşteriye ULAŞMIYOR — panel bunu kritik alarmla söylüyor) ·
  yedek cron'u + **offsite kancası** (`BACKUP_OFFSITE_CMD`) kurulmalı; artık kurulmazsa panel `backup_stale`
  alarmı üretiyor.

**PANEL + EKLENTİ TAM DENETİMİ + GERÇEK MAĞAZA SENARYOSU (commit 4b05be1→8173186, migration 0042,
eklenti v1.0.6, dev'de CANLI + doğrulandı; PROD DAĞITIMI BEKLİYOR — `main`'e push izin katmanınca
engellendi, kullanıcı onayı gerekiyor):** Kullanıcı "hem panel hem eklenti tarafını incele, eksikleri
tamamla, stabil/güvenli/performanslı yap, performans+güvenlik testlerini de yap, WordPress ve panel
için birden fazla ürün varyasyonu ekleyip MAK/normal key/Office 365 hesap teslimatını satışa hazırmış
gibi baştan sona test et" dedi. 5 denetim ajanı (WP eklentisi · güvenlik-2026 · performans · ürün-tipi
doğruluğu · test-kapsamı) + 6 düzeltme işçisi + gerçek WooCommerce E2E.
- **[YÜKSEK — YÜK TESTİNDE ORTAYA ÇIKTI, kod okunarak GÖRÜLEMEZDİ] Bağlantı havuzu kilitlenmesi.**
  `createOrder` transaction'ı İÇİNDEN `products.resolveMapping`/`getById` KÖK havuzu (`this.db`)
  kullanıyordu. postgres.js'te `transaction()` bir bağlantıyı rezerve eder; kök havuzdan sorgu
  İKİNCİ bir bağlantı ister. Havuz `max:10` → 10 eşzamanlı sipariş 10 bağlantının hepsini tutar,
  her biri 11.'yi bekler, hiçbiri serbest kalmaz → **KALICI KİLİTLENME**; bağlantılar "idle in
  transaction" kalır ve ancak `idle_in_transaction_session_timeout` (60sn) hepsini öldürünce çözülür.
  O pencerede `/v1/health` bile `db:false` → **sipariş trafiği TÜM paneli deviriyor**. **ÖLÇÜM:**
  k6 100 VU → **0 tamamlanan iterasyon**, PG logunda 60sn'de bir havuzun tamamı `FATAL`. **DÜZELTME
  SONRASI aynı test: 7.171 istek / 354 istek-sn / 0 hata / 14.334 check geçti / 50 stoktan tam 50
  sipariş (çifte satış 0) / idle-in-transaction ölümü 0.** Executor artık tx'ten geçirilir
  (`getById`/`resolveMapping`/`resolveLineScale`/`sites.getById`+`rekey`). **DERS
  [[denetim-regresyon-dersleri]]:** transaction gövdesinden servis çağırırken o servisin İÇERİDE
  hangi bağlantıyı kullandığını doğrula; `this.db` re-entry havuz boyutu kadar eşzamanlılıkta kilitler.
  Tarama betiği: transaction gövdelerinde `this.db` + `await this.<servis>.<metot>()` araması.
- **[YÜKSEK] connect-code yetki yükselmesi:** uç `OwnerGuard` taşımıyordu; `rotate-secret` ile AYNI
  gücü veriyor (`sites.rekey` → creds guard'sız public `/v1/connect/claim`ten teslim edilir) →
  owner-olmayan admin herhangi bir sitenin api_key+hmac_secret'ını alıp site-facing `reveal`
  imzalayabiliyordu (A1/A3 "düz metin yalnız owner" kararı TAMAMEN atlanıyordu). API guard +
  Next action `isOwner()` + sayfa kapısı.
- **[YÜKSEK] `parseAccountPayload` fallback'i `secret:false`** işaretliyordu → `maskAccountFields`
  değere hiç dokunmuyor. `kind: key → account` çevrilen üründe o ürünün TÜM anahtarları owner-olmayan
  admine / WP meta box'a / Ctrl+K aramasına **düz metin** çıkıyordu. Fallback artık `secret:true`
  (fail-safe yön). İkinci katman: canlı kalem varken `kind` değişimi 409.
- **[YÜKSEK] `payloadSchema` canlı stokla serbestçe değişiyordu** → (a) alan yeniden adlandırma
  200 kalemde kullanıcı adını HER YÜZEYDEN siliyor (ciphertext duruyor, sinyal yok), (b) `secret`
  bayrağını düşürmek geriye dönük parola ifşası + tedarikçi fişine KALICI donma, (c) şemaya alan
  eklemek kanonik JSON'un alan kümesini değiştirip `payload_hash`i saptırıyor → **dedupe kaçıyor,
  aynı hesap iki müşteriye satılıyor**. Kapasite guard'ının birebir deseniyle 409.
- **[YÜKSEK] Maskeli değer yazımı:** owner-olmayan admin envanterde hesap kaydını düzenlerse form
  maskeli gelir; tek alanı düzeltip kaydedince `••••••` GERÇEK parola olarak şifrelenir (satılmamış
  lisans sessizce imha, geri dönüş yok). Otoriter kapı sunucuda: `looksMasked()` → 400.
- **[PERF] MAK atama birim başına ayrı UPDATE'ti** (`for i<units`) → qty=200 = 200 ardışık
  round-trip, hepsi tek tx'te kilitler tutulurken. `consumeMultiUseCapacity` artık
  `LEAST(want, max_uses-use_count)` ile ANAHTAR başına toplu alır (`taken` CTE'de, GÜNCELLEMEDEN
  ÖNCEKİ satırdan — RETURNING'de NEW döner, oraya yazmak yanlış olurdu). **ÖLÇÜM: süre artık adetle
  ölçeklenmiyor** (50 adet 30ms, 200 adet 34ms; öncesi 200 adet 127ms).
- **migration 0042 (7 indeks + 2 düşürme):** `license_items_alloc_idx` (atama sorgusunun TAM
  karşılığı — `created_at`/`seq` indekste olmadığı için aday satır başına heap erişimi yapılıyordu;
  `expires_at IS NULL` çoğunlukta olduğundan presorted prefix tek dev gruba düşüp LIMIT devreye
  girmeden TÜM available satırlar sıralanıyordu — 0030'da `seq` tie-break eklenmiş, indeksi
  eklenmemişti) · `orders_open_status_idx` (**orders.status üzerinde HİÇ indeks yoktu** → /pending
  ana ekranı) · `license_items_dead_at_idx` (karantina `coalesce()` İFADE sıralaması) ·
  `order_lines_pending_fifo_idx` · `replacement_requests_order_idx` + `_email_lower_idx` ·
  `mappings_product_idx` (ikisi de indekssiz FK). Düşürülen: `license_items_fefo_idx`,
  `order_lines_pending_product_idx` (yenilerinin ÖN EKİ + kısmi koşulu birebir aynı).
- **[WP v1.0.6 — E2E'de ÖLÇÜLDÜ]** Çok ürünlü siparişte müşteri sayfası DÜZ LİSTE basıyordu: ürün
  adı yok, MAK anahtarının kaç aktivasyon taşıdığı hiçbir yerde yazmıyor (9 aktivasyon alan müşteri
  2 çıplak anahtar görüyor). **Aynı siparişin MAİLİ bunu DOĞRU yapıyordu** (ürün adı + "(3 adet)")
  → üç yüzeyden biri geride kalmıştı. Sayfa + `.txt` artık `remoteLineId` ile gruplu (ürün adı
  WooCommerce'in KENDİ kaleminden, panele sorulmadan) + `units>1` etiketi. · Hesap alanları
  çözülemezse teslim edilmiş sipariş KALICI "Teslimat hazırlanıyor" diyordu (ilerleme çubuğu
  "3/3" derken) → düz değere düşer. · Retry SONSUZDU (sabit 300sn, 401'de bile) → §4'teki
  1dk/5dk/30dk + 3 deneme; 401/403'te HİÇ retry (yapılandırma hatası) + tek kalıcı not.
- **[Diğer düzeltmeler]** mail `canceled` filtresi (okuma yolu yazma yolundan iyi korunuyordu) +
  `valid_until` değişkeni · `siteReveal` süre filtresi (docstring simetriyi vaat ediyordu, kod
  yapmıyordu) · `expiredHidden` bayrağı sweep koşunca KAYBOLUYORDU (`status IN ('active','expired')`) ·
  hesap payload'ı `maskSecret`'e verilince parolanın KUYRUĞU sızıyordu → account'ta `payload:null` ·
  `withinWarranty` lisansın kendi süresini saymıyordu (süresi dolmuş `keep` lisans "garanti içi"
  görünüp BEDAVA yenileniyordu, 12 ay tekrarlanabilir) · stok import `.trim()` (kalem düzenleme
  trimliyordu, import ETMİYORDU → sondaki boşluk `payload_hash`i saptırıp mükerrer denetimini
  kaçırıyor, aynı anahtar İKİNCİ kez stoğa girebiliyordu — dev'de kanıtlandı: düzeltmeden sonra
  `duplicates:1`) · webhook worker `concurrency:5` · envanter `count(*) OVER ()` tavanlandı ·
  retention +3 tablo · şablon test maili hız sınırı · dağıtım claim/finish OwnerGuard · login/logout
  `Origin` yoksa RED (+`Sec-Fetch-Site` yedeği) · Dockerfile `|| pnpm install` yedeği KALDIRILDI
  (lockfile sabitlemesini sessizce iptal ediyordu) · prod imajı budandı (**626→145 paket**,
  `src`/`test` çıktı) · scrypt N=2^14→2^17 (format parametre taşır, ESKİ hash'ler doğrulanmaya
  devam eder, girişte sessiz rehash) · `brace-expansion`/`js-yaml` override (`pnpm audit --prod` temiz).
- **KENDİ REGRESYONUM (dev'de yakalandı):** budanmış imaj `pino-pretty`yi (devDependency) kaybetti;
  kod yalnız `NODE_ENV`'e bakıyordu → prod imajı NODE_ENV≠production ile koşturulan DEV stack'inde
  API **BOOT ETMEDİ**. `require.resolve` ile çalışma-anı denetimi + JSON'a düşüş (bir log
  biçimlendiricisinin yokluğu servisi düşürmemeli). **DERS:** imajdan bağımlılık budarken o
  bağımlılığı KOŞULLU kullanan kodun koşulunu da gözden geçir; dev stack'i prod imajını farklı
  NODE_ENV ile koşturabilir.
- **KENDİ HATAM (5. kez):** `sql` şablonunun İÇİNDEKİ yorumda backtick — üstelik "backtick kullanma"
  diye yazdığım uyarı cümlesinde de tekrarladım (typecheck iki kez yakaladı).
- **E2E (gerçek WooCommerce, dev):** panelde 3 ürün (tek-kullanım key · MAK max_uses=5 · Office 365
  hesap payloadSchema username/password[secret]/recovery + validity 365g) + WC'de **varyasyonlu ürün**
  (Retail/MAK varyasyonları) + basit hesap ürünü; katalog senkronu → varyasyon-özel eşleme →
  **karışık sipariş** (Retail×2 + MAK×3 + hesap×1) → 205ms'de fulfilled; MAK tek atama `units=3`,
  hesap `valid_until` +365g. **Kısmi iade** (1 MAK birimi) → satır qty 3→2, atama units 3→2,
  `use_count` 3'te KALDI (§2 doğru). **Kısmi teslimat** (9 MAK + 5 hesap, stok 7+2) → iki anahtara
  bölünmüş 7 birim + 2 hesap, "9/14 teslim edildi". **Otomatik tamamlama** (stok girişi → hesap
  satırı tamamlandı). **Sorun Bildir → destek kuyruğu** (talep açıldı; stok tükendiği için approve
  409 "stok yok" — DOĞRU davranış). Müşteri sayfası + mail + meta box + panel detayı karşılaştırıldı.
- **Doğrulama:** typecheck 4/4 + check-use-server 25/86 · shared 35/35 · api birim 142/142 ·
  admin birim 135/135 · admin production build · **VPS izole test DB: entegrasyon 383/383 (69 dosya,
  +26 yeni) + yarış 3/3** · PHP-lint 12/12 · dev stack yeniden derlendi, `/v1/health` 200 v1.1.0,
  0042'nin 7 indeksi canlı + 2 gereksiz indeks düşmüş, api+admin **healthy**, boot hatası 0.
- **KALAN (bilinçli, raporlandı):** maliyet raporunda zaman penceresi yok (uç sözleşmesi değişir) ·
  MAK kusurlu anahtar için panelde çalışan değişim yolu yok (üç yol da 400 verir, gerekçesi kodda
  yazılı; "elle işleyin" talimatının panelde karşılığı yok) · `depleted` kovası hiçbir stok ekranında
  görünmüyor (multi+validity_days "kiralık slot" ürününde sermaye görünmez oluyor) · hesap ürününde
  "parola değişti" için doğru araç yok (değişim BAŞKA hesap verir, eskisi müşterinin elinde çalışmaya
  devam eder) · `payload_suffix_hash` hesap ürününde kanonik JSON'un son 5 hanesi → tam-anahtar/son-hane
  araması account'ta HER ZAMAN boş döner.

**KALAN EKSİKLERİN KAPATILMASI (commit 578f003, CANLI prod+dev, migration 0043, eklenti v1.0.7):**
Kullanıcı "geri kalan tüm eksikleri tamamla, güncellemeleri yayınla" dedi → önceki denetimde
"bilinçli bırakıldı / raporlandı" diye ertelenen maddelerin TAMAMI kapatıldı. 3 paralel işçi
(tükenmiş-stok görünürlüğü / MAK çıkmaz sokağı+units / maliyet penceresi) + merkezî çekirdek iş.
- **[YENİ UÇ] Teslim edilmiş HESABIN kimlik bilgileri yerinde güncellenebiliyor** — `POST
  /v1/admin/license-items/:id/rotate-credentials` (**owner-only**). Boşluk gerçekti: sağlayıcı
  parolayı döndürdüğünde `updateLicenseItemPayload` teslim edilmişi (HAKLI olarak) 409'lar,
  "Değiştir" ise BAŞKA bir hesap verir → eski hesap müşterinin elinde ÇALIŞMAYA DEVAM eder
  (bilgileri zaten kopyalamıştır) ve müşterinin o hesapta biriktirdiği veri KAYBOLUR. Yani
  anahtar ürününde doğru olan çözüm hesap ürününde YANLIŞ. Yeni akış AYNI kalem + AYNI atama +
  yeni bilgiler: `kind='account'` şartı, CANLI atama şartı (teslim edilmemişte normal yol),
  sebep zorunlu, `looksMasked()` kapısı, dedupe korunur, hesapta `payload_suffix_hash=NULL`,
  `fulfillment_events` + audit. Bildirim KARARI operatörde (§15): yanıt `orderIds` döner, UI
  "teslimat mailini yeniden gönderin" der — servis mail GÖNDERMEZ. 5 entegrasyon testi.
- **[MAK çıkmaz sokağı]** Üç değişim yolu da MAK'ı reddediyor ve **RED DOĞRU** (geri alınan
  kapasite AYNI paylaşımlı anahtara döner → yeni atama yine o kusurlu anahtarı seçer). Kusur
  reddin kendisi değil, operatöre yapabileceğinin SÖYLENMEMESİYDİ: sipariş detayı + destek
  ekranı düğmeyi GATE'SİZ sunuyor, tıklayınca 400 veriyordu (envanter tablosu doğru gate'liyordu
  → proje kuralı "tıklanıp hata veren düğme hiç sunulmayandan kötüdür" kendi kodunda ihlal
  ediliyordu). İki ekran da sebebiyle kapalı + gerçek reçete; `replacements.list` yanıtına
  `usageMode` eklendi (destek ekranı bunu okur). "İptal" onayındaki yanıltıcı *"kusurlu key"*
  örneği KALDIRILDI — o uç iade semantiğinde koşar, müşterinin hakkı YANAR. `MULTI_REPLACE_BLOCKED`
  tek kaynak `lib/labels`'e taşındı. **TUZAK (yine görüldü):** `export { X } from '…'` adı YEREL
  olarak BAĞLAMAZ → `import` + ayrı `export` gerekti (typecheck yakaladı).
- **[Tükenmiş kapasite görünmezdi]** `depleted` kalemler hiçbir stok ekranında listelenemiyordu:
  ürün detayında kova YOK, envanter facet'inde seçenek YOK, `detailStock().expired` alanı ÖLÜ
  (hiçbir kod yolu `license_items.status='expired'` yazmaz — süre bitişi `assignments.status`'ü
  değiştirir) → ekran DAİMA "Süresi geçmiş: 0" gösteriyordu. Üçü de düzeltildi; ölü alan
  envanterin `?status=expired` süzgeciyle BİREBİR aynı yükleme bağlandı (şeritteki sayıya bakan
  operatör aynı adı taşıyan süzgeci açınca AYNI listeyi görsün). MAK'ta kovaların TOPLANAMAYACAĞI
  ekranda + kodda not edildi.
- **[Maliyet raporu]** penceresiz tam tablo taramasıydı → `?from&to`, varsayılan **son 12 ay**,
  uygulanan dönem ekranda YAZILI (sessiz kırpma yok, tek tıkla "tüm zamanlar"). Varsayılanı "tüm
  zamanlar" bırakmak bulguyu KAPATMAZDI (menüden açan operatör yine sınırsız tarama tetiklerdi).
  Stok değerlemesi bilerek pencerelenmedi: dönem AKIŞI değil ANLIK pozisyon — daraltmak "stok
  değerimiz düştü" yalanı üretirdi. **migration 0043:** `assignments_delivered_at_idx` (kısmi —
  `delivered_at` indekssizdi, SLA servisi tam bu yüzden `created_at` kullanıyor) ·
  `purchase_orders_spent_at_idx` (**İFADE** indeksi: harcama TESLİMDE gerçekleşir →
  `coalesce(received_at, created_at)`; mevcut `_created_idx` bunu karşılamaz) ·
  `stock_adjustments_created_idx` (kısmi; yüklem servisle BİREBİR — ayrışırsa planlayıcı kısmi
  indeksi kullanamaz). Yeni birim testi (`costs.window.test.ts`) ÜRETİLEN SQL'i denetliyor
  (bind'ler ISO dize mi, `::timestamptz` cast'i var mı) ve **gerçek bir hatayı yakaladı**
  (bozuk tarihin "sınırsız"a düşmesi).
- **[Hesap araması YALAN SÖYLÜYORDU]** `payload_suffix_hash` hesap ürününde KANONİK JSON'un
  kuyruğunu hash'liyordu (`ne"}` gibi) → operatörün aradığı parola/kullanıcı-adı sonu ASLA
  eşleşmiyor; üstelik kuyruğun 2 karakteri (`"}`) SABİT olduğu için etkin entropi 5→3 düşüyordu.
  Hesapta artık YAZILMIYOR (NULL) + arama ipucu gerçeği söylüyor.
- **[WP v1.0.7]** Sipariş ekranı özeti MAK'ta KALEM sayıyordu → 3 aktivasyonluk tek anahtar
  **"1 lisans"** görünüyor, operatör eksik teslimat sanıp bedava **"+1 Bonus"** verebiliyordu.
  Artık `2 lisans (toplam 5 kullanım hakkı)`; `useCount/maxUses` çipi **"Anahtar geneli"** diye
  etiketlendi (o sayaç anahtarın TÜM siparişlerdeki toplamı, bu siparişin değil) + siparişe düşen
  birim ayrıca gösteriliyor.
- **[OPS — SESSİZ ARIZA, kendi runbook'umuz kırıyordu]** `scripts/backup-runner.sh` git'te
  **100644 (çalıştırılabilir DEĞİL)** idi ve `docs/RUNBOOK-DR.md` onu DOĞRUDAN crontab'a koymayı
  söylüyor → operatör runbook'u HARFİYEN uygulasa bile cron "Permission denied" ile sessizce hiç
  koşmayacaktı; üstelik bu arızayı raporlayacak olan da o runner'ın kendisiydi. Exec bit
  düzeltildi (`smoke-routes.sh` ile birlikte; `scripts/` altında 100644 kalan tek dosya artık
  `node` ile çağrılan `check-use-server.js`). VPS'te dakikalık + gecelik + aylık-tatbikat
  cron'ları kuruldu; ilk yedek alındı (1,1 MB dump) ve panelde `success` göründüğü doğrulandı.
  **Dış kopya (offsite) kancası HÂLÂ KURULMADI** — hedef/kimlik operatöre ait.
- **Doğrulama:** typecheck 4/4 (src+test) · check-use-server 25/87 · shared 35/35 · api birim
  **148/148** · admin birim **135/135** · build 3/3 · VPS izole test DB **entegrasyon 394/394**
  (383 → +11) **+ yarış 3/3** · PHP-lint 12/12 · dev: 0043'ün 3 indeksi canlı, `smoke-routes.sh`
  **30 rota 200 (hata sınırına düşen yok)**, boot hatası 0 · **dev canlı E2E:** rotasyon 201 →
  aynı kalem/aynı atama, yeni parola müşterinin `deliveries` yanıtında GÖRÜNÜYOR; maskeli değer
  **400** ile reddedildi · prod deploy (rollback'li) → `/v1/health` **200 v1.1.0**, 0043 canlı,
  api hata logu yalnız bilinen mail-relay alarmı · **eklenti v1.0.7 yayınlandı** (HTTP 201).
- **NOT (dağıtım sırası):** eklenti yayını ilk denemede **401** verdi — API o anda deploy sonrası
  yeniden başlıyordu (Caddy logunda `connection refused` izi var). Token doğruydu; birkaç saniye
  sonra tekrar denendi ve 201 döndü. Dağıtım hemen ardından `publish-plugin.sh` koşulacaksa
  sağlığın oturmasını bekle.
- **KALAN (yapısal kapsam-DIŞI, kodlanabilir eksik YOK):** fiyat senkronu / kâr-marj (satış fiyatı
  panelde YOK — §2/§6/§10) · marketplace dış-API adaptörü · Faz-3 WP migrasyonu · abonelik/EFT/3DS.
  **Operatöre kalan (kod değil):** ADMIN_TOKEN rotasyonu (log geçmişinde düz metin) · prod SMTP
  hâlâ `mailpit` (mailler gerçek müşteriye ULAŞMIYOR; panel bunu her boot'ta kritik alarmla söyler) ·
  yedeğin **offsite kancası** (`BACKUP_OFFSITE_CMD`).

**KURULUM/ETKİNLEŞTİRME REHBERLERİ + TESLİMAT ARAYÜZÜ (commit 3a88390→226aed0, CANLI prod+dev,
migration 0045, eklenti v1.1.0 yayınlandı):** Kullanıcı "sipariş verildiğinde WP tarafında kurulum/
etkinleştirme rehberi de gösterilmeli (Office 365 / Office 2021-2019 / Windows 10-11), daha güzel bir
teslimat UI/UX gerek, mail olarak da gideceği için karakter sınırını ona göre ayarla, panelden ürüne
göre ayarlanabilsin" dedi ve gerçek bir Office 365 talimat metni verdi.
- **Veri modeli:** `product_guides` + `products.guide_id` (**0045**, `ON DELETE SET NULL`). Metin ürüne
  GÖMÜLMEDİ — aynı anlatı onlarca SKU'da ortaktır; gömülü olsaydı bir adım değişince onlarca ürünü elle
  güncellemek gerekirdi (biri unutulunca müşteriye YANLIŞ talimat gider). Başlık unique index'i
  **Türkçe-duyarlı** (`translate(title,'İIı','iii')` — `product_categories`'te ölçülmüş gerekçenin aynısı;
  ürün formunda seçim yalnız başlıkla yapıldığı için iki özdeş başlık seçilemez hâle getirir).
- **ÜÇ YÜZEY, TEK RENDER** (`packages/shared/domain/guide.ts`): mağaza sayfası (HTML) · teslimat maili
  (düz metin) · müşterinin indirdiği `.txt`. Eklenti PHP'de İKİNCİ AYRIŞTIRICI TAŞIMAZ (iki uygulama er
  geç ayrışır — bu projede tekrarlayan hata sınıfı); paneldeki HTML'i `wp_kses` allow-list'iyle yalnız
  SÜZER (savunma derinliği). Biçimleme markdown'ın küçük+güvenli alt kümesi: ham girdi önce KAÇIRILIR,
  sonra yalnız tanınan kalıplar (`1.` adım · `-` madde · `##` başlık · `**kalın**` · `https://` bağlantı)
  etikete çevrilir → rehber metni müşteri tarayıcısında script çalıştıramaz (owner-olmayan admin de
  yazabilir, §8 → "içeriği biz yazıyoruz" varsayımı geçersiz).
- **KARAKTER SINIRI 4.000 — e-posta istemcisinden GERİYE hesaplandı** (kullanıcı "net bilgilerle gel"
  dedi): Gmail 102 KB'ı aşan maili KIRPAR ve kırpılan yer genelde SONDUR = rehberin yeri. Türkçe metinde
  4.000 karakter ≈ en kötü 7 KB · şablon+anahtar listesi 2-6 KB · quoted-printable ×1,3 → 3 rehberli
  siparişte ~30 KB (eşiğin çok altında). Maile en fazla **3 rehber**, toplam **12.000 karakter**; sınıra
  takılan SESSİZCE düşürülmez (müşteriye "kalanları sipariş sayfanızda" denir). Sınırın SEBEBİ panelde yazılı.
- **`{{guides}}` + SESSİZ KAYIP KORUMASI:** şablonda token varsa blok oraya, YOKSA mailin SONUNA eklenir
  (`withGuides`). Yalnız token'a güvenilseydi mevcut (token'sız) şablonlarla çalışan operatör rehberin
  gittiğini SANIR, müşteri hiç görmezdi, hata da çıkmazdı. **Kontrol denemesiyle doğrulandı** (fix geri
  alınınca test KIRMIZI).
- **RENDER SIRASINDA BULUNAN KUSUR:** adımlar arasına boş satır koymak (çok doğal yazım) her adımı ayrı
  `<ol>` yapıyor ve HTML numarayı 1'den YENİDEN başlatıyordu → müşteri "1. 1. 1." görürdü, üstelik aynı
  metnin DÜZ METİN sürümü doğru numaraları gösteriyordu (iki yüzey sessizce ayrışıyordu). `start`
  özniteliğiyle yazılan numara korunur; kses listesi `ol` için `start`'a izin VERMELİ (vermezse öznitelik
  sessizce silinir ve kusur geri gelir) — ikisi birlikte düzeltildi + regresyon testi.
- **Panel `/guides`:** başlık + metin, **canlı önizleme** (mağaza ↔ e-posta sekmeli, müşterinin göreceği
  HTML'in TA KENDİSİ — aynı paylaşılan fonksiyon), karakter sayacı, biçimleme yardımı, **hazır taslaklar**
  (Office 365 / Office 2021-2019 / Windows 10-11 / genel hesap). **Hiçbir ürüne bağlı olmayan rehber
  müşteriye ASLA ulaşmaz** → "Ürüne bağlı değil" uyarısı. Ürün formunda rehber alanı (serbest metin YOK,
  listeden seçim; mevcut seçim listede yoksa seçenek olarak basılır — yoksa kaydetmek ürünü sessizce
  rehbersiz bırakırdı, kategori alanındaki aynı koruma). Menü: Envanter altında, ikon `/guide` (Kullanım
  Rehberi) ile ÇAKIŞMASIN diye bilerek farklı. `/guide` rehber sayfasına yeni bölüm.
- **Mağaza teslimat görünümü KART yapısına geçti (eklenti 1.1.0):** ürün başına kart (başlıkta lisans
  adedi), anahtarlar SARMALI kod bloğunda (uzun anahtarın son haneleri artık kırpılmıyor), rehber o
  kartın içinde katlanır bölüm (tek ürünlü siparişte açık). Renkler **tema-nötr yarı saydam katman** —
  eski sabit `#f6f7f7` zemin koyu temalarda metni yutuyordu.
- **Yol boyunca kapatılan sapma:** şablon editörü "desteklenen değişkenler" listesinin KENDİ kopyasını
  tutuyordu ve ayrışmıştı — API `valid_until` besliyor, editörde o alan YOKTU → `{{valid_until}}` yazan
  operatör YANLIŞ "desteklenmiyor" uyarısı alıyor, panelin sunucu-taraflı önizlemesi ise onu geçerli
  sayıyordu (aynı ekranda iki cevap). Liste `@lisans/shared`'a taşındı.
- **YAYIN SONRASI DÜZELTMELER (kendi kodumun denetimi):** **[PERF]** rehber gövdesi atama satırlarının
  LEFT JOIN'indeydi → SATIR BAŞINA tekrarlanıyordu (50 anahtarlı siparişte 4.000 karakterlik metin 50 kez
  ≈200 KB) ve bu uç yalnız sayfa render'ında değil mağazanın CANLI YOKLAMASINDA da (8-60 sn) çağrılıyor →
  aynı `Promise.all` içinde BAĞIMSIZ `selectDistinct`'e taşındı (ek round-trip YOK; `selectDistinct` sıra
  garanti etmediği için başlığa göre sıralanır). **[TEST]** rehber yolu tamamen testsizdi → 5 davranış
  kilitlendi; **kontrol denemesi** ile iptal-satır filtresi kaldırılınca tam o testin kırmızıya düştüğü
  görüldü. **[UX]** ipucu "Sağda görünür" diyordu ama önizleme dar ekranda ALTTA; sınır gerekçesi de
  sayacın altında ikinci paragraf kalıyordu (`Field` yardımı çocuklardan SONRA basar) → ipucuna taşındı.
- **Doğrulama:** typecheck 4/4 · üç kapı temiz (use-server 26/90 · nest-wiring 42/69 · env 44) · birim
  **57+135+152** · build 3/3 · şema sapması yok (0045 damgası 0044'ten BÜYÜK — `when` tuzağı kontrol
  edildi) · VPS izole test DB **entegrasyon 401/401 + yarış 3/3** · PHP-lint **13/13** + eklenti davranış
  testleri **108/108** · `pnpm audit --prod` temiz · **31 rota 200** (hata sınırına düşen yok) ·
  **tarayıcıda ölçüldü:** kullanıcının verdiği gerçek Office 365 metni açık+koyu temada doğru render,
  numaralandırma 1→2→3, 360px kapta yatay kayma **0** / taşan öğe **0** / kırpılan anahtar **0**;
  panelde canlı önizleme + e-posta sekmesi çalışıyor · **dev GERÇEK E2E:** 3 ürünlü sipariş #67 →
  mağaza sayfasında üç kart, her birinde kendi rehberi, `<ol start="2">` numaralandırma; teslimat maili
  iki rehberi TEKİLLEŞTİRİLMİŞ taşıyor (Windows rehberi iki üründe ama bir kez) · prod `/v1/health` 200
  **v1.1.0**, migration tracking 46, api **0 ERROR** · **eklenti v1.1.0 yayınlandı** (201, 115.794 bayt;
  public update ucu https ile 1.1.0 servis ediyor, zip 200 → müşteri siteleri güncelleyebilir).

**DIŞ KOPYA (OFFSITE) ALARMI — kendi alarm tasarımımızdaki boşluk (commit 226aed0, CANLI, migration YOK):**
Yedek TAZELİĞİ ve TATBİKAT için alarm vardı, **dış kopya için YOKTU** → yedekler düzenli alınır, tatbikat
geçer, iki alarm da susar; ama her dump YALNIZ yedeklemenin sebebi olan makinede durur. Sunucu
kaybedilirse veri de MASTER_KEY de gider ve "yedeğimiz var" sanısı gerçek kurtarma imkânı OLMADAN sürer.
Durum `/deployments` ekranında rozetti — **rozet yalnız BAKANA yarar**. CANLI ÖLÇÜM: prod'da
`BACKUP_OFFSITE_CMD` tanımsız. İki durum AYRI şiddet: `skipped` (kanca yok) → **warning** + 7 gün dedupe
(sürekli durum, alarm yorgunluğu yaratmamalı); `failed` (kanca kurulu ama çalışmıyor) → **critical** +
24 saat dedupe, çünkü operatör dış kopyanın ALINDIĞINI sanıyor ve yanlış güven hiç güvenmemekten
tehlikelidir. Yalnız BAŞARILI son yedeğe bakılır (yedek zaten alınamıyorsa asıl sorun `backupStale`;
aynı arıza iki başlıkla bildirilmez). Yeni tip `labels.ts`'e eklendi (eklenmeseydi ham `backup_offsite`
görünürdü — geçen turda düzeltilen kusurun aynısı). 3 şıklı entegrasyon testi + **kontrol denemesi**
(kırmızı doğrulandı) + **canlıda tetiklenip düştüğü görüldü** (`created:1`).

**ADIM ADIM İNCELEME: HAVUZ KİLİTLENMESİ + SESSİZ ÖLEN İŞ + ÜÇ OTOMATİK KAPI (migration YOK, PROD'A
GİTMEDİ — kullanıcı onayı bekliyor):** Kullanıcı "projeyi genel olarak adım adım incele eksiklerini
gider" dedi. Önce doğrulama temeli ÖLÇÜLDÜ: typecheck 4/4 · birim **148+135+35** · `pnpm audit --prod`
temiz · migration `_journal` sıra ihlali YOK (0044'ün damgası artık gerçek saatin GERİSİNDE → uydurma
gelecek-damga tuzağı kendiliğinden kapandı) · rota↔menü↔rehber kapsamı tam · etiket sözlükleri API'nin
ürettiği değer kümesinin TAMAMINI karşılıyor · 8 süpürmenin hepsi `upsertSoleJobScheduler` kullanıyor.
Bulunan gerçek kusurlar:
- **[ORTA] Fiş kesme ağır yükte TÜM paneli kilitleyebilirdi.** `supplier-claims.create` transaction'ının
  İÇİNDEN `listQuarantine` KÖK havuzu kullanıyordu. Koddaki gerekçe ("advisory-lock bağlantı açlığını da
  sınırlar — aynı anda en fazla bir fiş kesme") **YANLIŞTI**: kilit kaç transaction'ın kilidi GEÇTİĞİNİ
  sınırlar, kaçının BAĞLANTI TUTTUĞUNU değil. Kilidi bekleyen N istek havuzu (max 10) doldurursa kazanan
  İKİNCİ bağlantıyı alamaz → 60 sn `idle_in_transaction` timeout'una kadar `/v1/health` dahil her şey
  bağlantısız (createOrder'da k6 ile ÖLÇÜLEN sınıfın aynısı). `QuarantineQuery.exec` eklendi, fiş kesme
  `tx` geçiyor. İKİ İNCELİK: (a) görüntüleme-audit'inin best-effort YUTMASI yalnız kök havuzda geçerli —
  tx içinde patlayan ifade tüm tx'i abort eder (25P02), yutmak yalnız GİZLER → tx yolunda hata propage
  edilir; (b) üç id-toplama sorgusu tx'te SIRALI koşar (kod tabanında transaction gövdesinde `Promise.all`
  kullanan BAŞKA örnek yok — doğrulayamadığım desene sıcak yol bağlanmadı).
- **[ORTA] Arka plan stok tamamlama işi SESSİZCE ölüyordu.** `AutocompleteProcessor`'da
  `@OnWorkerEvent('failed')` YOKTU ve hem işleyici hem kuyruk dosyası "kalıcı başarısızlıklar /ops
  dead-letter'da görünür" DİYORDU — YANLIŞ: `/ops` yalnız `outbox_events`+`email_log` okur, BullMQ
  başarısız işlerine HİÇ bakmaz. Stok GİRİLMİŞ olmasına rağmen CAP'in (200) ötesindeki bekleyen siparişler
  teslim edilmez, müşteri lisansını almaz, alarm çıkmazdı. SweepAlarm eklendi (YALNIZ son denemede —
  ara denemede alarm, sonradan başarılı olan geçici DB hatalarını kritik bildirime çevirirdi) + iki yanlış
  yorum düzeltildi + `StockModule → NotificationsModule` glue'su (bu glue olmadan **API HİÇ BOOT ETMEZDİ**).
- **[DÜŞÜK] Tie-break eksikleri.** En önemlisi `resolveMapping`: `mappings_site_remote_uniq` NULL varyasyonu
  AYRI saydığı için varyasyonsuz MÜKERRER eşleme mümkündür ve eşit `created_at`'te hangi ÜRÜNÜN teslim
  edileceği keyfiydi; `/mappings`'in bu seçimi taklit eden sorgusu da AYNI sıraya hizalandı (ayrışırsa panel
  teslimatta seçilecekten BAŞKA eşleme gösterir). + global arama · destek kuyruğu (200) · eşlemesiz ürün
  listesi (500; çok kalemli siparişte `last_seen` eşitliği OLAĞAN) · katalog listesi (5000).
- **ÜÇ SESSİZ-ARIZA SINIFI ARTIK OTOMATİK KAPIDA** (`pnpm typecheck` + CI; üçü de fix geri alınarak
  KIRMIZI olduğu DOĞRULANDI): `scripts/check-nest-wiring.js` (eksik DI glue → API boot etmez; `tsc`
  yakalamaz — bu sınıf 2 kez yaşandı) · `scripts/check-env-passthrough.js` (kodun okuduğu env compose'da
  geçmeli + `.env.example`de belgeli olmalı; 2 kez yaşandı) · `smoke-routes.sh` rota kapsamı artık `app/`
  ağacıyla OTOMATİK karşılaştırılıyor (elle not YETMEDİ: categories/sites-new/templates-new üç ayrı turda
  unutulmuştu). **DERS (yeni):** DI denetimi ÖNCE `Reflect.getMetadata('design:paramtypes')` ile birim
  testi olarak yazıldı ve **hiçbir şeyi denetlemiyordu** — esbuild/vitest `emitDecoratorMetadata` ÜRETMEZ,
  metadata boş döner, döngü hiç çalışmaz, test yeşil kalır. Kontrol denemesi (glue'yu kaldır → KIRMIZI mı?)
  bunu yakaladı → TypeScript AST'ye taşındı. Aynı ders `check-env-passthrough`ta tekrarlandı: ilk sürüm 44
  değişkenin 18'ini görüyordu ve GÖRMEDİKLERİ tam da geçmişte unutulanlardı (`RETENTION_*`,
  `HMAC_IP_FAIL_LIMIT`, `SMTP_*` — bunlar `ConfigService.get()`/`this.days()` ile okunuyor). **Az denetleyen
  denetleyici, denetleyici yokluğundan BETERDİR** (yanlış güven verir).
- Kendi hatam: `sql` şablonu İÇİNDE ters tırnak (projede **7. kez**; tsc TS1005 ile yakaladı).
  Doğrulama: typecheck 4/4 + 3 kapı temiz · birim 148+135+35 · build 3/3. **Entegrasyon/yarış paketi
  KOŞULMADI** (bu makinede docker/PG yok) → VPS izole test DB'sinde koşulmalı; fiş kesme yolu için
  entegrasyon testi EKLENMEDİ (koşulamayacağım bir test yazıp "geçiyor" dememek için).

**DENETİM: ZAMAN ÇİZELGESİ SIRASI + GÖRÜNMEYEN ETİKETLER (commit 5e593f6, CANLI prod+dev, migration 0044):**
Kullanıcı "güncel hâli adım adım inceleyip eksikleri tespit et; güvenlik/performans/kullanım/bug'ları
eksiksiz düzelt" dedi. **Önce doğrulama temeli ÖLÇÜLDÜ** (neyin gerçekten bozuk olduğunu bilmeden aramamak
için): typecheck 4/4 · birim 148+135+35 · **entegrasyon 394/394 + yarış 3/3** · şema sapması yok ·
`pnpm audit --prod` temiz · WP php-lint 13/13 + 108 davranış doğrulaması · 34 rota 200 · prod /health 200
v1.1.0 · eklenti sürüm invaryantı (kod 1.0.7 = yayınlanan 1.0.7). Çekirdek para yolu (atama/iade/değişim/
kota), 14 owner-only ucun RBAC kapsamı, düz-metin maskeleme, advisory-lock ad alanları, retention kapsamı,
admin↔API rota kablolaması ve `audit_action`/güvenlik-olayı sözlükleri denetlendi ve **TEMİZ ÇIKTI**.
- **[ORTA] Sipariş zaman çizelgesi yanlış sırada gösterebiliyordu.** Bir siparişin olayları TEK
  transaction'da yazılır (`createOrder`: order_received → fulfilled/pending_stock) ve `now()` transaction
  BAŞINI döndürdüğü için damgalar BİREBİR aynıdır → yalnız `created_at` ile sıralandığında olaylar keyfi
  sırada dönüyor, **"Geri alındı" satırı "Sipariş tamamlandı"nın ÜSTÜNE çıkabiliyor** ve sıra her
  yenilemede değişebiliyordu (denetim izi niteliğindeki ekranda nedensel sırayı yanlış anlatır).
  **ÖLÇÜLDÜ** (tahmin değil): dev verisinde aynı damgayı paylaşan **7.200 olay grubu** —
  `fulfilled + line_completed + revoked` üçlüleri dahil. **migration 0044** `fulfillment_events.seq`
  (bigserial; `license_items.seq`/0030 deseni + AYNI rewrite uyarısı — uygulanırken prod 5, dev 14.418
  satırdı, ÖLÇÜLDÜ) + sıralama `created_at, seq`. Tek okuyucu `detail()` (grep'lendi). Tablo yalnız
  INSERT alır (UPDATE eden kod yolu YOK — tarandı) → geçmiş satırlarda seq pratikte ekleme sırasıdır.
  **Yeni index EKLENMEDİ:** mevcut `(order_id, created_at)` sorguyu daraltıyor, sipariş başına olay az.
- **[ORTA] Kritik mail alarmı operatöre HAM KOD olarak görünüyordu.** `mail_config` bildirimi (üretimde
  mail hedefi mailpit/localhost → teslimat mailleri gerçek müşteriye ULAŞMIYOR; `MailConfigGuardService`,
  `critical`) `NOTIFICATION_TYPE` sözlüğünde YOKTU ve alarm prod'da **CANLI**: ölçüldüğünde **26 kayıt**,
  en yenisi aynı gün. Aynı sınıftan ikinci boşluk: yeni `account_credentials_rotated` olayı da `EVENT_TYPE`
  sözlüğüne eklenmemişti (sözlüğün "API'nin ürettiği tam küme 13 değerdir" notu o uç EKLENMEDEN ÖNCE
  yazılmıştı). **DERS:** yeni bir olay/bildirim TİPİ üreten kod eklerken sunum sözlüğünü de güncelle;
  sözlüklerdeki "denetlendi" notu bir TARİHE aittir, sonraki uçları kapsamaz — API'nin ürettiği değer
  kümesini grep'le yeniden çıkar.
- **[DÜŞÜK]** Ürün detayı stok hareketleri listesi kararsızdı: toplu "geçersiz kıl/hasarlı" KALEM BAŞINA
  satır yazar ve hepsi tek transaction'a düşer → aynı damga; tie-break olmadığı için `LIMIT 50` penceresine
  hangi satırların gireceği keyfiydi (`created_at DESC, id DESC` — `/audit`'in mevcut deseni).
- **[DÜŞÜK]** `smoke-routes.sh` **`sites/new`** (site bağlama sihirbazı) ve **`templates/new`** sayfalarını
  hiç taramıyordu — ikisi de sunucu action'ı olan, `next build` temiz geçerken çalışma anında kırılabilen
  sayfalar (betiğin tüm değeri kapsamında; `categories` bir kez zaten unutulmuştu). Kapsamı elle doğrulama
  komutu da betiğe yazıldı. `/` (middleware yönlendirmesi) + `login` bilinçli dışarıda.
- **KENDİ TESTİMİ ÇÜRÜTTÜM (yeni ders, [[denetim-regresyon-dersleri]] #11):** yazdığım regresyon testi
  fix GERİ ALINDIĞINDA DA geçiyordu — tie-break olmadan da Postgres küçük tabloda satırları fiziksel
  (= ekleme) sırasında döndürür, yani test hiçbir şeyi korumuyordu. Ayırt edici kurulum: **`seq`'i fiziksel
  sıranın TERSİNE açıkça yaz** → iki sıra ayrışır, yalnız ORDER BY'ı gerçekten `seq` içeren sorgu doğru
  cevabı verir. **Kural:** sıra/limit/tie-break düzeltmesinde testi yazdıktan sonra fix'i geçici geri al ve
  KIRMIZI olduğunu GÖR. (Bu turda da `sql` şablonu İÇİNDE backtick tuzağına düştüm — projede 6. kez.)
- **ÇÜRÜTÜLEN (kontrol edildi, kusur DEĞİL):** `readonly-sql`'deki `ANY(${userOids}::oid[])` — orada
  `this.sql` **postgres.js** istemcisidir ve JS dizisini doğru bind eder (bozuk olan yalnız **drizzle**
  `sql` şablonundaki hâlidir; ikisini karıştırma).
- **DÜZELTİLMEYEN (bilinçli, raporlandı):** dev-only bağımlılık açıkları (vitest 2.1.9 kritik advisory +
  vite/esbuild) — prod ağacı temiz, prod imajı budanmış; düzeltmesi vitest 2→3 MAJOR yükseltmesi ve 395
  entegrasyon testini riske atar, denetim içinde kullanıcı kararı olmadan yapılmaz. Ayrıca **bir kerelik
  flake**: bir koşuda `dynamic-quota-hold` + `replace-assignment` düştü; tek tek ve sonraki **3 tam koşuda**
  geçtiler, değişikliklerden kaynaklanmıyor, sebebi KANITLANAMADI (uydurulmadı) — izlenmeli.
- **Doğrulama (fix sonrası):** typecheck 4/4 + check-use-server 25/87 · birim 148+135+35 · admin production
  build · VPS izole test DB **entegrasyon 395/395 + yarış 3/3** · şema sapması yok (`db:generate` "No schema
  changes") · 36 rota duman testi temiz · `bash -n` 9/9 · prod `deploy.sh api admin` (rollback'li, sağlık
  kapısı geçti) → `/v1/health` **200 v1.1.0**, migration tracking **44→45**, `seq` bigint NOT NULL + mevcut
  satırlar dolu, api **0 ERROR**, yeni etiketler admin imajında doğrulandı; dev yığını da güncellendi
  (detached HEAD → `main`). **Denetim çalışma alanı (`/opt/lisans-audit`, 938 MB) temizlendi.**
- **OPERATÖRE KALAN (kod değil — ikisi de CANLI doğrulandı):** prod `SMTP_HOST` **TANIMSIZ** → mailler
  mailpit'e gidiyor, gerçek müşteriye ULAŞMIYOR (`mail_config` alarmının sebebi; artık okunur etiketle
  görünüyor) · `BACKUP_OFFSITE_CMD` **TANIMSIZ** → yedekler alınıyor (cron kurulu: dakikalık runner +
  03:15 gecelik + aylık tatbikat; son dump 1,1 MB) ama **yalnız o sunucuda** · ADMIN_TOKEN rotasyonu.

**PROJE GENELİ 6-LENSLİ DENETİM → CI'IN 19 GÜNDÜR ÖLÜ OLDUĞU BULUNDU (migration YOK, eklenti v1.1.1):**
Kullanıcı "projeyi tekrar tekrar güncel olarak baştan sona agentların ve işçilerin ile beraber incele, tüm
eksikleri/sorunları/bugları fixle, performans ve güvenlik problemlerini gider" dedi. Önce **doğrulama temeli
ÖLÇÜLDÜ** (neyin gerçekten bozuk olduğunu bilmeden aramamak için): typecheck 4/4 · üç kapı temiz · birim
57+152+135 · build 3/3 · `pnpm audit --prod` temiz · migration `when` sırası 46 girdi/0 ihlal · şema sapması
yok · betik exec bitleri · eklenti sürüm invaryantı · duman testi rota kapsamı tam. Hepsi temizdi → aranan
şey "zaten bozuk olan" değil **henüz görünmeyendi**. Altı bağımsız lens (en yeni kod/rehberler · güvenlik+RBAC ·
performans+DB · çekirdek para yolu · ops/kuyruk/env/betikler · admin UI + WP) paralel tarandı, her bulgu
raporlanmadan önce çürütme denemesinden geçti; ardından 5 ayrık-dosya işçi + merkezî çekirdek iş.

- **[EN AĞIR] `.github/workflows/ci.yml` GEÇERLİ YAML DEĞİLDİ.** Adım adı `- name: 'use server' export
  denetimi` biçimindeydi; YAML'de tek tırnakla BAŞLAYAN bir skalerden sonra düz metin gelemez →
  `bad indentation of a mapping entry (38:28)`. GitHub Actions böyle bir dosyayı REDDEDER, yani **iş akışının
  tamamı hiç koşmuyordu**: use-server, Nest DI, env passthrough, typecheck, birim testleri, WP php-lint,
  migration drift, `bash -n`. Kırılma **2026-07-28 / `ee59e14`** commit'inde girmiş — tam da "sessiz kırılmayı
  önleyecek" kapıyı CI'a ekleyen commit'te; **19 gün** sürdü. `js-yaml` ile ölçülerek kanıtlandı (HEAD
  ayrıştırılamadı, düzeltilmiş kopya ayrıştırıldı). Yeni kapı **`scripts/check-workflows.js`** (YAML
  geçerliliği + `on:`/`jobs:` + adımsız iş + boş `run:` + kapsam denetimi) **YEREL `pnpm typecheck`
  zincirinde** — dosya ayrıştırılamıyorsa o dosyadaki hiçbir adım koşamaz, yani kapı kendini denetleyemez;
  CI'daki kopyası ikincil güvencedir. Kontrol denemesi: hatalı satır geri konunca kapı KIRMIZI.
  `js-yaml` kök devDependency olarak eklendi (pnpm override zaten 4.3.1'e sabitliyordu).
- **[YÜKSEK] Kurulum rehberi panelden ETKİNLEŞTİRİLEMİYORDU.** Form `<select name="guideId">` basıyor,
  `buildProductBody` onu FormData'dan HİÇ okumuyordu (iki satır yukarıda `categoryId` okunuyor). Operatör
  rehberi seçer → yeşil sonuç → `products.guide_id` NULL kalır → rehber müşteri sayfasında, mailde ve
  `.txt`'de HİÇ görünmez (sessiz: hata yok, form kaydettikten sonra seçimi doğru gösterir). Özelliğin dev
  doğrulaması bağı doğrudan API'den kurduğu için kaçmıştı. **KÖK SEBEP TEST EDİLEBİLİRLİK:** fonksiyon
  `'use server'` dosyasındaydı, oradan yardımcı export etmek yasak → testi OLAMIYORDU. `apps/admin/lib/
  product-form-body.ts`'e taşındı; `PRODUCT_FORM_FIELDS` kapsam testi ("formdaki HER alan gövdeye ulaşır")
  dahil 12 test. Kontrol denemesi: düzeltme geri alınınca 5 test KIRMIZI.
- **[YÜKSEK/güvenlik] `POST /v1/admin/sites` owner kapısı YOKTU** (Next'te de `isOwner()` yoktu) — uç taze
  `apiKey`+`hmacSecret` döndürür; owner-olmayan admin kendine site açıp katalogdan bir ürüne eşleme kurup
  sipariş oluşturarak `GET /orders/:id/deliveries` ile gerçek lisansı DÜZ METİN okuyabiliyordu (A1/A3
  kararını tamamen atlar, `reveal` audit'i de yazılmaz). Kardeş uçların ikisi (`rotate-secret`/`connect-code`)
  tam bu gerekçeyle owner-only idi. `OwnerGuard` eklendi + hiçbir sayfada render EDİLMEYEN
  `create-site-form.tsx` ve `createSiteAction` KALDIRILDI (form ölüydü ama aksiyon aynı `'use server'`
  modülünden export edildiği için hâlâ çağrılabilir bir uçtu). `GET /v1/admin/users` de owner kapısına
  alındı; pino redact listesine `password`/`fields`/`value` eklendi.
- **[ORTA/§2 ihlali — sessiz aşırı-satış] `revokeExcess` MAK kapasitesini havuza GERİ VERİYORDU**,
  `syncRefunds` vermiyordu — aynı fiziksel olay, zıt semantik; üstelik İKİ entegrasyon testi bu çelişkiyi
  ayrı ayrı kilitliyordu. Mağaza re-push'u NET adet (brüt − iade) taşır → bir WooCommerce iadesi `/refund`
  yerine bu yoldan uzlaşabilir (`/refund` işi kalıcı başarısızsa ya da admin aynı istekte kalem düzenlediyse)
  → HARCANMIŞ aktivasyonlar havuza dönüp BAŞKA müşteriye satılabiliyordu. Teslimattan sonra adet düşüşü MAK
  için iadeyle fiziksel olarak AYNIDIR ve hangi yoldan geldiği ayırt edilemez → §2'nin ihtiyatlı kuralı iki
  yolda da uygulanıyor; `revoke-excess-partial` testinin beklentisi 3→5 düzeltildi. **Geri alınacak atamanın
  seçimi deterministik yapıldı:** önce `suspended` (zaten devre dışı → müşterinin kullandığı canlı anahtarı
  öldürme), sonra en yeni, sonra `id` — tek transaction'da yazılan atamaların `created_at` damgaları BİREBİR
  aynıdır, tie-break şarttı.
- **[perf] Atama motorunda birim başına ayrı INSERT** (tek-kullanımlıkta `allocate()` kalem başına bir tahsis
  döndürür → qty=500 = 500 seri round-trip; hepsi tx içinde, satır kilitleri tutulurken, havuzun bir
  bağlantısı rezerveyken, kota açık sitede advisory-lock altında) → TEK çok-satırlı INSERT; eşleme SIRAYA
  değil `licenseItemId`'ye dayanır (RETURNING'in giriş sırasını koruduğu yazılı garanti DEĞİL) + eksik satırda
  AÇIK hata (sessiz `undefined` assignmentId yanıta sızmasın). Aynı sınıf `releaseAllocations`'ta ve tam da
  STOK YETMEDİĞİNDE (all-or-nothing geri alımı) tetikleniyordu → tek `UPDATE … FROM (VALUES …)`; aynı kalem
  iki kez geçerse ÖNCE toplanır (bir satır yalnız BİR KEZ güncellenir, toplamadan yazmak sessizce eksik geri
  verirdi). **Düşük-stok süpürmesi kısmi indeksi kullanamıyordu** (süzgeç JOIN yerine agregat FILTER'ında —
  kardeş `dashboard.lowStockCount` bunu gerekçesiyle ÇOKTAN çözmüştü, ALARM ÜRETEN yol geride kalmıştı;
  `license_items` retention kapsamında olmadığı için büyük kurulumda `statement_timeout`'a takılıp düşük-stok
  alarmını HİÇ üretmeyebilirdi). Tedarikçi fişi detayı tek fiş için bile tüm `supplier_claim_items`'ı
  agregeliyordu (gruplu alt sorguya yüklem itilemez) → LATERAL. Ürün detayı parti/PO listeleri LIMIT'sizdi
  (bu iki tablo stok girişi başına birer satır alır) → tavan 200 + GÖRÜNÜR kırpma uyarısı. Ürün kaydetmenin
  sıcak yolundaki rehber varlık denetimi tüm rehber gövdelerini çekiyordu → `exists()`.
- **[ORTA/gözlem] Teslimat maili arızasının ALARMI YOKTU:** günlük kritik alarm yalnız `outbox_events`'e
  bakıyordu, `email_log`'a bakmıyordu. SMTP kimliği/kotası bozulunca siparişler teslim edilmeye devam eder,
  panel "fulfilled" der, geri-kanal webhook başarılı olur, mailler sessizce ölür ve sabah digest'i "Sorunlu
  webhook: 0" derdi → `failedEmails` metriği (yüklem `ops.service` ile BİREBİR aynı) + alarmda AYRI satır +
  `/ai` panelinde kart. **Dış kopya alarmında şiddet yükselmesi kendi dedupe'una takılıyordu**
  (`skipped`/warning ile `failed`/critical AYNI tipi paylaşıyordu → operatörün "dış kopya alınıyor" sandığı
  EN TEHLİKELİ durum, daha zararsızı tarafından 24 saate kadar bastırılıyordu) → tipler ayrıldı + `labels.ts`.
- **[kapılar] `check-env-passthrough`** `getOrThrow(` ve sabit-ara-değişken biçimlerini GÖRMÜYORDU; kör
  noktasındakiler `MAIL_FROM`/`SMTP_PORT`/`REDIS_URL`/`ADMIN_TOKEN`/`AUTOCOMPLETE_INLINE_CAP` idi ve zod
  bunlara VARSAYILAN verdiği için compose'dan düşseler CI yeşil kalıp `.env` sessizce yok sayılırdı
  (kapsam 44→**49**). **`check-nest-wiring`** `@InjectQueue`'yu hiç denetlemiyordu — kayıtsız kuyruk API'yi
  HİÇ boot ettirmez, yani kapının var oluş sebebi olan sınıf kör noktasındaydı (+13 kuyruk bağımlılığı).
  **`deploy-runner.sh`** claim hatasında tek satır log basmadan çıkıyordu (ADMIN_TOKEN rotasyonundan sonra
  panelden basılan dağıtım isteği hiç claim edilmez, teşhis izi kalmazdı); **`backup-runner.sh`** aynı
  ALT-KABUK tuzağını taşıyordu (`claim="$(api …)"` komut ikamesi alt kabukta koşar → `API_HTTP` ana kabuğa
  DÖNMEZ, teşhis satırı her zaman bayat `0` basar, 401 ile ağ hatası ayırt edilemez). **Exec-bit kapısı
  yoktu** (`bash -n` 100644 bir dosyada da GEÇER; runbook'lar betikleri doğrudan crontab'a koyuyor ve bu bir
  kez yaşanmıştı). Dördü de KONTROL DENEMESİYLE kırmızı görülerek doğrulandı.
- **[UI] Owner-only aksiyonlar gate'siz sunuluyordu** (secret yenile · site askıya al · bağlan kodu üret ·
  KVKK anonimleştir): operatör "GERİ ALINAMAZ" kırmızı onayını geçtikten SONRA "yetkiniz yok" alıyordu →
  karar SUNUCUDA (`isOwner()`), istemciye serileştirilebilir boolean olarak geçiyor (fonksiyon prop'u YOK).
  Şablon tablosu kod tabanındaki SON `includesString` kalıntısıydı ("TESLİMATI" araması "Lisans Teslimatı"nı
  bulmuyordu — Türkçe İ). Ctrl+K paleti `unmapped` durumunu ham İngilizce basıyordu (aynı sipariş `/orders`
  listesinde "Eşlenmemiş" diyordu). Ölü `revealAction` kaldırıldı — çağrılırsa hiç yaşanmamış bir "lisans
  görüntülendi" olayını denetim izine yazıyordu. 9 rotaya eksik `loading.tsx`/`error.tsx` eklendi;
  `/guide`'daki iki yanlış vaat düzeltildi.
- **[WP v1.1.1] Katalog kırpma birimi uyuşmazlığı** — eklenti kod NOKTASI, panel UTF-16 kod BİRİMİ sayıyordu
  → emoji/astral karakter taşıyan TEK bir ürün adı `products` dizisinin TAMAMINI 400'letiyor, snapshot hiç
  yazılmıyor, operatör `/mappings`'te boş katalog görüyor, tek iz mağazadaki `error_log` oluyordu (sessiz).
  Panel artık REDDETMİYOR, KIRPIYOR (`remoteName` ile aynı desen); eklenti de aynı birimde ölçüyor.
  + eşleme kutusundaki bozuk hata mesajı · çok baytlı kırpmanın mesajı BOŞALTMASI · ölü ikinci `mask()` ·
  bonus önekinin iki yerde ayrı ayrıştırılması (panelin `originRemoteLineId`/`isBonus` alanları YETKİLİ).
- **KENDİ TESTİMİ ÇÜRÜTTÜM (yeni ders):** işçinin yazdığı dış-kopya dedupe testi ilk koşumda düştü. Sebep
  ÜRÜN DEĞİL DÜZENEKTİ: `notifications` stub'ı yalnız diziye push ediyordu, `alert()` dedupe'u ise GERÇEK
  DB'ye sorar → tabloya satır hiç girmediği için "aynı tipin KENDİ dedupe'u korunuyor" iddiası bu düzenekte
  SAĞLANAMAZDI. Stub artık satırı tabloya da yazıyor. **Kural: dedupe/idempotency sınayan bir test, ürünün
  YAZMA yolunu da taklit etmelidir; yoksa test, ürünün yapmadığı bir şeyi ölçer.**
- **Doğrulama:** typecheck 4/4 (src+test) · **dört kapı** temiz (use-server 26/88 · nest-wiring 42 modül/69
  sınıf **+13 kuyruk** · env 49 · **workflows 2/4/46**) · birim **shared 57 + api 152 + admin 147** (+12 yeni)
  · build 3/3 · `pnpm audit --prod` temiz · şema sapması yok, migration EKLENMEDİ (0000-0045 sabit) ·
  PHP-lint **13/13** + eklenti davranış testleri **108/108** (VPS throwaway `php:8.2-cli-alpine`) ·
  `bash -n` temiz · **VPS izole test DB: entegrasyon 402/402 + yarış 3/3** (çifte satış 0 — toplu INSERT ve
  küme-tabanlı geri alma değişikliklerinden SONRA).

**DAĞITIM SONRASI 2. TUR: KENDİ DÜZELTMELERİMİ ÇÜRÜTME + KALAN ALANLAR (migration YOK):**
Kullanıcı "dağıttıktan sonra tekrar testlere başla, eksikleri/bugları kontrol et ve fixle, sırayla adım adım"
dedi. Üç adım: (1) dağıtım sonrası canlı duman testi + asıl düzeltmenin GERÇEK panel akışında doğrulanması,
(2) kendi değişikliklerimi ÇÜRÜTMEYE çalışan iki ajan, (3) 1. turda derin taranmayan altı alan.

- **ADIM 1 — canlı kanıt.** Dev panelde 37 rota temiz. Rehber kusuru GERÇEK FORMDAN doğrulandı: TEST-KEY
  ürününe panelden rehber atandı → DB'de yazıldı; "Rehber gönderme"ye çekildi → gerçekten kalktı; diğer
  ürünler etkilenmedi (düzeltme öncesi ilk adım sessizce hiçbir şey yapmıyordu). Yeni yetki kapıları canlı
  denendi: owner-olmayan `POST /admin/sites` **403**, owner **201**; `GET /admin/users` aynı.
- **ADIM 2 — ÇÜRÜTME (çekirdek invaryantlar kırılamadı, üç dayanıklılık bulgusu):**
  **[YENİ ARIZA MODU — kendi açtığım]** toplu INSERT'e geçiş eskiden var OLMAYAN bir tavan getirdi:
  PostgreSQL Bind parametre sayısını int16'da taşır (65535), satır başına 7 kolonla **~9.362 tahsisten
  sonra `MAX_PARAMETERS_EXCEEDED`** → TÜM sipariş 500 ile geri alınır (eski döngüde böyle bir sınır yoktu).
  Bu kod tabanı aynı tuzağı katalog senkronunda ZATEN 500'lük dilimlerle çözüyordu. Chunk'landı; iki
  çağırandaki kopya tek `orders/assignment-insert.ts`'e toplandı. `releaseAllocations` (2 param/satır →
  ~32.767) da chunk'landı. **[ÖLÜ GUARD]** yazdığım "atama kaydı okunamadı" throw'u belgelediği arızayı
  (dizide mükerrer kalem) YAKALAMIYORDU — Map araması başarılı olur, id sessizce kaybolurdu; guard gerçek
  invaryanta bağlandı (*her tahsis için bir kayıt okundu mu*). **[TEST BOŞLUĞU]** `releaseAllocations`'ın
  MAK yolu HİÇ koşmuyordu: `makScenario` politika parametresini kabul ediyor ama dört çağrısı da varsayılan
  `partial-auto` veriyordu → `GREATEST(0, use_count − units)` aritmetiği, `assigned_at` korunumu ve iki
  anahtar için toplu geri verim test edilmemişti; ayrıca tüm MAK testlerinde birimler EŞİT olduğu için bir
  eşleşme hatası görünmezdi. İki test eklendi (a4 all-or-nothing MAK, a5 eşitsiz dağılım).
- **ADIM 2 — KAPILARIN KÖR NOKTALARI:** **kendi yeni kapım eksikti** — "geçerli YAML" ≠ "Actions'ın kabul
  ettiği workflow": `runs-on`'suz iş, `run:`/`uses:` taşımayan adım, **YAML anchor** (js-yaml çözer, Actions
  REDDEDER — bu yazım projede `docker-compose.yml`'de kullanılıyor) ve yalnız `workflow_dispatch` ile
  tetiklenme eklendi (ikisi kontrol denemesiyle KIRMIZI). **`check-nest-wiring` `controllers:` dizisini HİÇ
  taramıyordu** — controller bağımlılığı da API'yi boot ettirmez, yani kapının var olma sebebi kör
  noktasındaydı; kapsam **69 → 130** (kontrol denemesi isabetli mesajla yakaladı). `check-env-passthrough`
  şablon-dizesi ve destructuring biçimlerini artık UYARIYOR (eskiden sessizce atlıyordu) — ve yeni env
  eklerken kapı işini yaptı, `RETENTION_CLAIM_KEY_MASK_DAYS` compose'a girmeden beni durdurdu.
- **ADIM 2 — kendi katalog düzeltmemin açtığı yol:** `.slice(0, N)` kesim noktası bir surrogate ÇİFTİNİN
  ortasına denk gelirse yalnız-surrogate bırakıyor, Node onu U+FFFD'ye çeviriyor ve ad DB'ye `…�` olarak
  SESSİZCE bozuk yazılıyordu (dev'de gerçek istekle ölçüldü: 520 birimlik ad kabul edildi ama son karakter
  bozuldu). Paylaşılan `truncateUtf16Safe` (shared/domain/text.ts) yazıldı, katalog + sipariş `remoteName`
  ikisi de ona bağlandı; testin İÇİNDE kontrol denemesi var (eski `slice` çıktısının bozuk olduğu aynı
  testte kanıtlanıyor).
- **ADIM 3 — kalan alanlar (1 orta + 6 düşük):** **[ORTA] DR alarmı YALAN söylüyordu** — `backupSummary`
  `backup` ve `backup-drill` satırlarını ORTAK `limit(30)` penceresinde okuyordu; gecelik yedek + aylık
  tatbikat kurulumunda ~29 günden eski tatbikat pencereden düşüyor, panel/alarm "HİÇ başarılı tatbikat
  kaydı yok" diyordu (eşik 35 gün). Hedef başına AYRI pencere. **Destek yazışması en YENİ mesajları
  sessizce düşürüyordu** (`ASC ... LIMIT 500`) — bir destek ekranında en kritik satır sonuncusudur; sıra
  ters çevrilip kırpma `truncated` ile ekrana çıkarıldı. **İki "satış" tanımı ayrışmıştı** (`/reports`
  iptal satırı sayıyor, `/reports/reorder` saymıyordu → aynı ürün için çelişen tükenme tahmini; süresi
  dolmuş atama tam iadeden sonra hayatta kaldığı için senaryo gerçek). **Tedarikçi fişindeki DÜZ METİN
  anahtar** hiç budanmıyordu (şifreli `payload_enc` ile asimetrik, yedeklerde de birikiyordu) → kapanmış
  fişlerde 1 yıl sonra maskelenir, satır ve fiş izi KORUNUR (`RETENTION_CLAIM_KEY_MASK_DAYS`). **AI hız
  sınırı** IP başınaydı ama panel çağrıları Next üzerinden proxy'lendiği için TEK GLOBAL kovaya çöküyordu
  (bir operatör hepsini kilitliyordu); günlük özet ucunda HİÇ sınır yoktu (her yenileme ücretli çağrı) →
  üç uç tek kaynağa (`ai-rate-key.ts`) bağlandı. **ParseUUIDPipe** eksikleri (bozuk id → 500 yerine 400).
  **`readonly-sql` metin kapısı** `SELECT DISTINCT ON (id) *` biçimini kaçırıyordu (sömürülebilir değildi —
  dönen kolon süzgeci yakalıyordu — ama katmanlardan biri eksikti).
- **KENDİ HATAM (bu projede 8. kez):** `sql` şablonunun İÇİNDE ters tırnak kullandım; üstelik hemen
  yanındaki `reorder.service.ts` yorumu tam bunu uyarıyor. typecheck yakaladı, uyarı o bloğa da yazıldı.
- **Doğrulama (2. tur):** typecheck 4/4 + **dört kapı** (use-server 26/88 · nest-wiring 42 modül/**130** sınıf +13 kuyruk · env **50** · workflows 2/4/46) · birim **shared 64 + api 152 + admin 147** · build 3/3 · **VPS izole test DB: entegrasyon 405/405 + yarış 3/3** · PHP-lint 13/13 + eklenti davranış 108/108 · dev 37 rota 200. **Migration YOK** (0000-0045 sabit).

**3. TUR: HENÜZ DERİN DENETLENMEMİŞ DÖRT ALAN (migration YOK, eklenti v1.1.2):** Kullanıcı "kalan
eksikleri tespit edip agentlarını/işçilerini çalıştırıp kontrol et, sorunları düzelt" dedi. Bu oturumda
yüzeysel geçilmiş dört alan tarandı: **kripto+HMAC kimlik yolu · stok girişi+tedarik zinciri · şema/veri
modeli bütünlüğü · WP sipariş senkronu+iade uzlaştırması**. Her bulgu çürütme denemesinden geçti.

- **[ORTA/güvenlik] AAD AD ALANI ÇAKIŞMASI → PUBLIC uç çözme oracle'ına dönüyordu.**
  `site_secret:<siteId>` AAD'si ÜÇ kolonda paylaşılıyordu (`sites.hmac_secret_enc` +
  `site_connect_tokens.api_key_enc/hmac_secret_enc`). AAD kayıt-id'sini bağlıyor ama KOLONU/TABLOYU
  bağlamıyordu. Sonuç: DB'ye YAZMA erişimi olan ama MASTER_KEY'i OLMAYAN biri, sitenin şifreli
  secret'ını kendi eklediği bir connect-token satırına kopyalayıp kimliksiz `POST /v1/connect/claim`
  ile paneli o blob'u çözüp **DÜZ METİN döndürmeye** ikna edebiliyordu → sonrasında site-facing her ucu
  (reveal dahil) imzalayabilirdi. Kodun kendi güvencesi ("ciphertext satır-taşıma imkânsız") bu sınıfı
  kapsamıyordu. Yeni `connectTokenAad(tokenId)`; token id uygulamada üretilir; eski satırlar için tek
  seferlik geri düşüş (kod ömrü 15 dk). **Taşımanın ÇÖZÜLEMEDİĞİ birim testiyle kilitlendi** (iki yön).
  + hiç claim edilmemiş kodlar retention penceresi boyunca O AN GEÇERLİ creds'i şifreli tutuyordu →
  yeni kod üretilirken TÜM eski satırların blob'ları NULL'lanır. + auth-fail mesajları (`Geçersiz API
  anahtarı` ↔ `Geçersiz imza`) secret bilinmeden api_key'in KAYITLI + sitenin AKTİF + rotasyon
  grace'inin AÇIK olduğunu tek istekte doğruluyordu (sızmış anahtar listesini eleme oracle'ı) → tek
  mesaj, ayrım `logger.debug`'da.
- **[YÜKSEK] Stok girişi ~5.957 satırda opak 500.** Sistemin EN BÜYÜK toplu INSERT'i chunk'sızdı;
  satır başına 11 bind parametresi × int16 sınırı (65534). DTO ise 10.000 satıra İZİN VERİYOR ve gövde
  sınırına sığıyor. En kötüsü: onay modalini besleyen KURU ÇALIŞTIRMA ayrı (satır başına 1 parametreli)
  yol kullandığı için TEMİZ geçip "8.000 kayıt girilecek" diyor, gerçek gönderim
  `MAX_PARAMETERS_EXCEEDED` ile düşüyordu (veri güvenli — tam rollback — ama giriş HİÇ yapılamıyor ve
  sebebi panelden anlaşılmıyor). Aynı tuzak kod tabanında ÜÇ yerde çoktan çözülmüştü, en büyüğü
  atlanmıştı. Kardeşi: geri çekmede zayi kaydı yazımı (6 param/satır → >10.922 kalemde parti `recalled`
  bile olamıyordu). İkisi de chunk'landı.
- **[ORTA] Parti sayacı ile geri çekmenin VOID ETTİĞİ küme ayrışmıştı** ("satılmış 6 birim" hatasının
  aynı sınıfı): sayaç `status='available'`, eylem `status IN ('available','depleted')`. Kapasitesi
  tamamen satılmış (depleted) MAK anahtarları taşıyan partide ekran "Stokta 0" derken onay modali
  "0 anahtar geçersiz kılınacak" diyor, geri çekme o anahtarları void edip Kusurlu Stok havuzuna
  düşürüyordu — operatör GERİ ALINAMAZ kararını yanlış sayıyla veriyordu. Sayaç eylemle hizalandı.
- **[ORTA/§2 — WP] Sipariş KALEMİNİN SİLİNMESİ panele hiç ulaşmıyordu.** `collect_lines` yalnız HÂLÂ
  VAR OLAN kalemleri üretir, `reconcileOrder` da yalnız GELEN satırlar üzerinde dönüyordu → silinen
  satır `fulfilled`, atamaları `active` kalıyor; müşteri artık satın almadığı lisansları kullanmaya
  devam ediyor, stok kalıcı tüketilmiş sayılıyordu. Aynı işlemin KISMİ hâli (adet 3→1) ZATEN doğruydu
  (`revokeExcess`) — eksik olan 3→0 dalıydı. Çözüm **opt-in `fullSync` bayrağı**: bayrak YOKSA eski
  (güvenli) davranış aynen sürer, çünkü "gelmeyen satır = silinmiş" varsayımı KISMİ bir push'ta
  müşterinin canlı anahtarlarını topluca yakardı; yalnız eklentinin `resync_items` yolu true gönderir.
  Semantik İADE'dir (satır terminal, MAK kapasitesi havuza DÖNMEZ) + görünür `order_edited` olayı.
  İki yönlü regresyon testi (bayraksız push satıra DOKUNMAZ / bayraklı push geri alır).
- **[ORTA — WP] Tükenmiş retry zincirinden sonra aynı işin TÜM başarısızlıkları KALICI SESSİZ.**
  `_wpteslimat_fail_<op>` yalnız 2xx ile temizleniyordu → haftalar sonra yapılan İKİNCİ bir kısmi iade
  panele iletilemezse not YAZILMIYOR, zincir PLANLANMIYOR; müşterinin iade ettiği anahtarlar canlı
  kalıyor ve tek iz 30 günde budanan kuyruk logu oluyordu. Artık YENİ bir iş tetiklendiğinde sayaç +
  kalıcı hata izi sıfırlanır (yeni iş = yeni ticari gerçek = kendi zinciri ve kendi notu). + tüm
  kalemleri silinen siparişte sessiz `return` yerine görünür sipariş notu.
- **[DÜŞÜK ×6]** `correct`/`recall` + `licenseItemIds` kombinasyonu ilk id hariç hepsini SESSİZCE
  yutup `requested:0` diyordu → 400 ile reddedilir · `recall`/`bulk-replace` uçlarında `ParseUUIDPipe`
  (bozuk id 500 yerine 400) · stok girişi `payload` üst sınırsızdı (kardeş yazma yolu 4.000 uyguluyordu)
  · `resolveBundleQty` tie-break'i eksikti (kardeş üç sorguda vardı; mükerrer NULL-varyasyon eşlemesinde
  teslimatla iade FARKLI satırı seçebilirdi) · `hostMatchesSite` şema/port denetlemiyordu (raporlandı).
- **ŞEMA DENETİMİ — büyük ölçüde TEMİZ** (bu alan hiç denetlenmemişti): migration `when` sırası
  MONOTON, 31 tablonun tamamı ve ~62 indeks migration'larda mevcut, 0045 snapshot güncel, TÜM zaman
  kolonları `timestamptz`, dokuz kısmi indeksin yüklemi sorgularla BİREBİR, CASCADE zincirleri bugün
  ulaşılamaz (üretimde sipariş/site silme yolu YOK). Kalanlar bilgi düzeyinde: sıfır CHECK constraint
  (invaryantlar yalnız uygulamada), `orders.updated_at` ana durum yazarlarınca güncellenmiyor,
  `license_items.batch_id` FK'siz ve gerekçesiz, birkaç ölü enum değeri.
- **TEST HARNESS GÖZLEMİ (yeni):** entegrasyon paketi AYNI veritabanında TEKRAR TEKRAR koşmaya karşı
  idempotent DEĞİL — üst üste koşumlarda hata sayısı 1→3→8'e çıktı, dosya tek başına 9/9 geçti, TAZE
  DB'de tamamı 406/406 geçti. Yani "koşumlar arası taze DB" bir gereklilik; aksi halde biriken veri
  kod regresyonu gibi görünür. (Bu tur bunu ölçerek ayırt etti, tahminle geçiştirmedi.)
- **KENDİ HATALARIM:** (1) `sql` şablonunun İÇİNDE ters tırnak — bu projede **9. kez**; typecheck
  yakaladı, uyarı o bloğa da yazıldı. (2) Yazdığım `fullSync` testi YANLIŞ bir modeli kodluyordu
  (`qty − canceled_units = 0` bekliyordu); gerçekte `canceled_units` yalnız satırda CANLI KARDEŞ atama
  kaldığında artar, son atama geri alındığında satır `canceled` bayrağıyla terminal olur (mevcut iade
  yollarının deseni). Test gerçeğe uyduruldu — ürün doğruydu.
- **Doğrulama:** typecheck 4/4 + dört kapı (use-server 26/88 · nest-wiring 42/130+13 · env 50 ·
  workflows 2/4/46) · birim **shared 64 + api 153 + admin 147** · build 3/3 · **TAZE VPS izole test DB:
  entegrasyon 406/406 + yarış 3/3** · PHP-lint 13/13 + eklenti davranış 108/108. Migration EKLENMEDİ.

**KARARLILIK TURU → 4-LENSLİ DENETİM + 4 İŞÇİ (commit f3c73a2, CANLI prod+dev, migration YOK):**
Kullanıcı "tüm eksikleri sorunları gider stabil hale getir projeyi" dedi. Önce doğrulama temeli
ÖLÇÜLDÜ (typecheck 4/4, dört kapı, birim 64+153+147, `pnpm audit --prod` temiz, prod `/health` 200,
37 rota temiz) — hepsi temiz çıktı, yani aranan şey "zaten bozuk olan" değil **degrade koşulda ortaya
çıkan** kusurlardı. Dört bağımsız lens (havuz/sızıntı · test idempotanlığı · çökme/hata sınırları ·
eşzamanlılık/kilit sırası; her bulgu ÇÜRÜTME denemesinden geçti) + 4 ayrık-dosya işçi + çekirdek para
yolu (admin-orders/stock) bende. **ORTAK PAYDA: sistem bir şeyin çalıştığını söylüyor, çalışmıyor.**

- **[YÜKSEK] Havuz kilitlenmesi — bu sınıfın 3. TEKRARI.** `createOrder` tx'i içinden
  `loadOrderResult` KÖK havuzu kullanıyordu. postgres.js'te `transaction()` bir bağlantı REZERVE
  eder; gövdeden `this.db` ile sorgu atmak İKİNCİ bağlantı ister → havuz (max:10) dolunca dairesel
  bekleme, `/v1/health` dahil TÜM API cevapsız (k6 ile İKİ kez ÖLÇÜLDÜ: createOrder ve
  supplier-claims). **Advisory-lock bunu ENGELLEMEZ** — kilit kaç tx'in kilidi GEÇTİĞİNİ sınırlar,
  kaçının BAĞLANTI TUTTUĞUNU değil. En çarpıcısı: aynı dosyanın diğer ikiz yolu (`:652`) bu çağrıyı
  *"(tx dışı)"* diye işaretleyip bilinçle dışarıda yapıyor; sonradan eklenen F2 dalı kuralı ihlal
  etmiş. → `exec` parametresi + `tx` geçişi. **YENİ KAPI `scripts/check-tx-pool.js`** (TS AST;
  `pnpm typecheck` + CI): tx gövdesinde `this.db` (A) ve **"executor sunan metodu tx'siz çağırma"**
  (B) desenlerini yakalar; gerekçeli `// tx-pool-ok:` kaçış kapağı var. **DERS:** kapının İLK sürümü
  kontrol denemesinde hatayı YAKALAMADI — yalnız metot GÖVDESİNİ tarıyordu, oysa düzeltilmiş metotta
  `this.db` artık yalnız `exec = this.db` VARSAYILAN PARAMETRESİNDE duruyor. Kural genişletildi
  ("executor sunan metot" = tx'ten çağrılırken tx geçilmeli), kırmızı olduğu GÖRÜLDÜKTEN sonra bağlandı.
- **[YÜKSEK] Geri çekilmiş partiye satılabilir anahtar eklenebiliyordu.** `resolveBatchForImport`
  parti satırını KİLİTSİZ okuyor ve koddaki yorum *"aynı tx'te olmak TOCTOU'yu ücretsiz kapatır"*
  diyordu — **YANLIŞ**: READ COMMITTED'da kilitsiz SELECT araya giren `recallBatch`i engellemez
  (o `FOR UPDATE` alır, beklemez, süpürmesini import'un commit EDİLMEMİŞ satırlarını göremeden
  bitirir) → import commit edince geri çekilmiş partinin altında TAZE `available` anahtarlar kalır ve
  süpürme bir daha koşmaz (§2). → `.for('share', { of: batches })` (`of` ZORUNLU: `purchaseOrders`
  LEFT JOIN'in nullable tarafı, Postgres oraya satır kilidi uygulatmaz).
- **[YÜKSEK] Stok girişi sırasında ürün sözleşmesi değişirse MAK kapasitesi SESSİZCE yok oluyordu.**
  `values` dizisi tx'ten ÖNCE, kilitsiz okunan ürüne bağlı dört karar taşıyor (`maxUses`, `kind`,
  `payloadSchema`, anahtar biçimi). `products.update` ürünü `FOR UPDATE` kilitliyor ama import
  ürünü HİÇ kilitlemiyordu → update, `license_items` sayımını 0 görüp (import henüz YAZMADI)
  "canlı kalem yok" guard'ından geçip `multi→single` yapabiliyor; import `max_uses=500` ile yazıyor;
  `allocate()` tek-kullanım dalına girip anahtarın TAMAMINI `assigned` yapıyor → anahtar başına
  **499 aktivasyon** hiçbir hata üretmeden kayboluyordu. Aynı pencere `kind`/`payloadSchema`
  üzerinden `payload_hash`i saptırıp **dedupe'u da kaçırıyordu** (aynı hesap iki müşteriye).
  → tx içinde `FOR SHARE` ile yeniden doğrulama + 409 ("ürün değişti, tekrarlayın").
- **[ORTA] Askıdaki atama "yalnız aktif değiştirilebilir" guard'ını atlıyordu:**
  `replaceAssignmentLocked` atamayı kilitsiz okuyor, `revokeAssignment` ise yalnız `revoked`'da
  `already` dönüyordu → eşzamanlı "Askıya al" sonrası operatörün BİLEREK askıya aldığı lisans taze
  anahtarla değiştiriliyor ve stoktan anahtar yanıyordu → `.for('update', { of: assignments })`
  (kardeş `replacements.approveTx` bunu ZATEN kilitli yapıyordu — parite).
- **[ORTA] `rejectHeld` ABBA deadlock:** kilit sırası sözleşmenin TERSİYDİ (`orders`→`order_lines`→
  `assignments`; sözleşme advisory→assignments→order_lines→orders) ve `revokeAssignment` advisory
  ALMADIĞI için iki yol serileşmiyordu → 40P01/opak 500. Atama kilitleri `order_lines`'a
  DOKUNULMADAN ÖNCE alınıyor; `orders FOR UPDATE` KALDIRILDI (advisory zaten serileştirir + READ
  COMMITTED'da kilit sonrası SELECT taze anlık görüntü kullanır → CAS korunur). Bu, `revokeOrderForSite`'ta
  daha önce uygulanan çözümün aynısı; burası atlanmıştı.
- **[ORTA] `deploy.sh` admin sağlık probu HİÇBİR bileşeni render etmiyordu.** Varsayılan kök `/`,
  middleware render'DAN ÖNCE 307 veriyor, curl `-L` taşımıyor ve [200,500) kabul ediyordu → prob 307
  alıp "sağlıklı" diyordu. **Panel tamamen kırık dağıtılsa bile dağıtım BAŞARILI sayılıyor ve otomatik
  rollback HİÇ tetiklenmiyordu** (bu turdaki her şeyin üretimde sessizce geçmesinin sebebi buydu).
  Prob `/pending`'e alındı, `-L` eklendi, gövdede `error.tsx` imzası aranıyor (`smoke-routes.sh`
  deseni) + başarısızlık SEBEBİ rollback mesajına basılıyor. **Sahada ilk koşuşunda geçti.**
- **[ORTA] Redis boot'ta erişilemezse API HİÇ ayağa kalkmıyordu** (`upsertJobScheduler` try/catch
  DIŞINDA; 8 servis `onModuleInit`'te çağırıyor, o da `app.listen()` içinde → port hiç açılmaz,
  `/health` bile yok). Runtime bilinçli olarak Redis'siz çalışacak şekilde tasarlanmıştı (nonce
  fail-closed-fast, rate-limit fail-open, health `degraded`) — **boot bu tasarımla çelişiyordu** ve
  Redis restart'ına denk gelen bir dağıtım İYİ bir sürümü rollback ettirirdi. → boot devam eder,
  hata loglanır; upsert başarısızsa yetim temizliği KOŞMAZ (yoksa meşru zamanlayıcıyı silerdi).
- **[ORTA] Süreç kancaları + Redis gözlem boşluğu:** `unhandledRejection`/`uncaughtException` kancası
  YOKTU; `@nestjs/bullmq` `@OnWorkerEvent` handler'ını `.catch()` sarmadan bağlıyor → `SweepAlarmService.report`
  dışında bir şey `await` eden İLK handler API konteynerini düşürürdü (bugün latent, belgelenmemiş,
  tek noktaya bağlı invaryant). Ayrıca ioredis `silentEmit` ve BullMQ `emit` override'ı hataları HAM
  `console.error`'a yazıyordu → pino JSON'una girmiyor, Sentry görmüyor, hiçbir log sorgusuyla
  eşleşmiyordu (Redis kimlik/TLS arızası pratikte GÖRÜNMEZ). Kancalar + `.on('error')` eklendi.
  **`main.ts:29` yorumu YANLIŞ bilgi veriyordu** — ÖLÇÜLDÜ: `requestTimeout` "isteğin İSTEMCİDEN
  alınması" süresidir, handler süresini SINIRLAMAZ (`requestTimeout:1000` + 3 sn handler → `200, 3027 ms`);
  gerçek tavanlar Redis `commandTimeout` / PG `statement_timeout`+`lock_timeout`. Yorum gerçeğe uyduruldu.
- **[ORTA] `findForAuth`'ta korumasız `decrypt`** → MASTER_KEY sapmış bir kurulumda mağazanın HER
  isteği (sipariş push, katalog senkronu, iade, My Account) 401 yerine **500**; eklenti 401'i
  "yapılandırma hatası" sayıp durur, 500'ü geçici sanıp saatlerce yeniden dener. → `null` + `logger.error`
  (desen kod tabanında ZATEN vardı: search/stock/totp; auth yolu atlanmıştı).
- **[ORTA] Admin→API 254 çağrının HİÇBİRİNDE zaman aşımı yoktu** (undici varsayılanı **300 sn**):
  API "kapalı" değil "asılı" ise her sekme dakikalarca boş bekler ve `/deployments`'ı açıp müdahale
  etmek de aynı katmandan geçtiği için MÜMKÜN OLMAZ. Ters kanıt aynı repodaydı: `lib/auth.ts:132`
  gerekçesini yazarak 1,5 sn kullanıyor. → `fetchWithTimeout` (okuma 8 sn / yazma 20 sn) → `ApiError(504)`.
- **[YAPISAL] `PgExceptionFilter`** — opak 500'ler anlamlı 4xx: `23505→409` · `23503→404/409` (metin
  `still referenced` ise 409 — aynı SQLSTATE'in iki dalı zıt HTTP karşılığı taşır) · `22003/22001→400`
  · `22P02→400` · `57014→503+Retry-After` · `40P01/40001→409`. **`SentryExceptionFilter`'dan KALITIM**
  (Nest birden çok global filtreyi kayıt sırasının TERSİNDEN dener → iki catch-all'da filtre sessizce
  hiç koşmayabilirdi). **En sinsi kapanan açık: `validityDays` üst sınırsızdı** → `5e8` int4'e sığıp
  KAYIT BAŞARILI oluyor, sonra o ürüne gelen **HER** sipariş `RangeError: Invalid time value` ile 500
  veriyordu — arıza yapılandırmadan GÜNLER SONRA, mağazanın sipariş push'unda patlıyordu. Sayısal
  alanlara gerekçeli üst sınırlar (validity/warranty 3650g, maxUses 100k, eşik/kota/qty 1M), SKU
  çakışması 409, PO/şablon FK→404, 8 uçta `ParseUUIDPipe`, `purchaseOrders.update()` tx+`FOR UPDATE`.
- **[TEST] Entegrasyon paketi AYNI DB'de tekrar koşamıyordu** (ÖLÇÜLDÜ: 1→3→8 hata; dosya tek başına
  9/9; TAZE DB'de temiz) → biriken veri KOD REGRESYONU gibi görünüyor ve her gelecekteki doğrulamayı
  zehirliyordu. Kök nedenler yapısaldı: `cleanupByTag` FK'siz tabloları (`audit_log`, `security_events`)
  hiç düşürmüyor, `email_log.order_id` ON DELETE SET NULL olduğu için satır KALIYOR (CASCADE
  yanılsaması), etiketsiz sabit payload'lar GLOBAL unique `payload_hash`e çarpıp `onConflictDoNothing`
  ile SESSİZCE atlanıyor. **Temizlik kapsamını genişletmek REDDEDİLDİ** — bu oyun DÖRT kez oynandı
  (site_product_mappings → batches/purchase_orders/suppliers → product_guides → supplier_claims) ve
  her seferinde BİR SONRAKİ tablo unutuldu. Yerine koşu BAŞINDA (sonunda DEĞİL — çöken koşunun kanıtı
  incelenebilsin) `globalSetup` ile `information_schema`'dan türetilen TAM sıfırlama + **üretim
  verisini koruyan emniyet kilidi** (test kalıbına uymayan DB adında fail-closed; `lisanspanel` ve
  `lisansdev` REDDEDİLİR). **KANIT: aynı DB'de ÜÇ ARDIŞIK koşu 410/410.**
- **[SESSİZ YUTMA ×12]** para yolu + denetim izi: iade sırasında kaçak atama geri alınamazsa
  (müşteride CANLI lisans kalır, panel "Geri alındı" der, reconcile bunu bu biçimde yakalamaz) →
  log + sipariş zaman çizelgesine görünür uyarı · reveal audit yazılamazsa düz metin GÖSTERİLİP ize
  geçmediği loglanır ("reveal audit'e düşer" değişmez kuralı) · bonus teslimat maili kuyruğa girmezse
  müşteri lisansı HİÇ ALMAZ (panel "eklendi" der) · `supply-ops` altyapı arızasını "stok yok"
  saymaz (ayrı `failed` sayacı + admin bandında destructive ton + "stokla ilgili değil" metni) ·
  kota/hold güvenlik olayları · `email_log` `queued`da kalması (retry'da idempotency kapısı açılmaz →
  müşteriye LİSANS TAŞIYAN ikinci mail) · AAD legacy geri düşüşü · arama kripto hatası.
- **[TIE-BREAK]** aynı tx'te yazılan satırların `created_at` damgaları BİREBİR eşit (`now()` = tx başı)
  → LIMIT'li her `ORDER BY`a benzersiz son anahtar: **teslimat FIFO penceresi (EN CİDDİSİ — hangi
  satırın teslim edileceği keyfiydi)**, pending-lines (tanı ile çöz FARKLI alt küme işleyebiliyordu),
  soyağacı, revoke sebebi, arama, `email_log`, `/ops` dead-letter, katalog. Yön AYNA DEĞİLDİR.
- **[SAKLAMA] `plugin_releases` sınırsız büyüyordu** (saklama kapsamı DIŞINDAYDI): 18 yayının zip
  gövdesi **1947 kB**, gecelik yedek dosyası **1,1 MB** → yedeğin NEREDEYSE TAMAMI tarihî paketler
  (dış kopya hâlâ kurulu değilken, DR hedefi RPO≤5dk/RTO≤2sa). Son N sürümün gövdesi saklanır,
  eskiler ARŞİVLENİR — **satır SİLİNMEZ** (sürüm geçmişi panelde görünür kalır, kullanıcının açıkça
  istediği özellik) ve **en yüksek SEMVER her hâlükârda korunur** (müşteri siteleri tam o paketi
  indirir; sırasız yayında tarih tek başına yanıltır). Arşivlenmiş sürüm indirmede **410** (404
  "bu yayın hiç olmadı" dedirtiyordu). `RETENTION_PLUGIN_RELEASE_KEEP` varsayılan 20 = bugün NO-OP.
- **[KENDİ REGRESYONUM]** saklama özet satırının ÜÇ adımında `${...}` interpolasyonları kaybolmuştu
  (`dec4c91` — fiş-anahtarı adımını eklerken): süpürmenin operatöre görünen TEK satırı `security= sil,
  email= maske/ sil` basıyordu. Kod tabanındaki tek örneğiydi. Düzeltildi + **raporun HER sayısının
  satırda geçtiğini** doğrulayan test (log metnini ezberlemez → yeni adım eklenip özete yazılmazsa da yakalar).
- **Doğrulama:** typecheck 4/4 + **BEŞ** kapı (use-server 26/88 · nest-wiring 42/130+13 · env **51** ·
  workflows 2/4/47 · **tx-pool 36 tx gövdesi**) · birim shared 64 + api **165** + admin **150** ·
  build 3/3 · **VPS taze test DB: entegrasyon 410/410 × ÜÇ ARDIŞIK KOŞU (aynı DB) + yarış 3/3** ·
  PHP-lint 13/13 · prod `deploy.sh` YENİ probla geçti → `/v1/health` 200 v1.1.0, admin `/pending` 200
  (hata sınırına düşmüyor), api 0 ERROR · dev 37 rota 200 · **canlı 4xx doğrulaması:** mükerrer SKU
  409, `validityDays=5e8` 400, bozuk uuid 400 (üçü de eskiden 500).
- **BİLİNÇLİ YAPILMAYAN (raporlandı):** MASTER_KEY test koşularında sabitlenmedi (sabitlemek etiketsiz
  sabit payload kullanan iki test dosyasındaki latent `payload_hash` çakışmasını CANLANDIRIR — önce o
  payload'lara etiket eklenmeli) · `sequence.sequencer` sabitlenmedi (dosya sırası bugün dosya
  BOYUTUNA bağlı ve her düzenlemede sessizce değişiyor) · global + LIMIT'li okuma yapan testlerde
  `truncated` assert'i eklenmedi.
- **OPERATÖRE KALAN (kod değil, DEĞİŞMEDİ):** prod `SMTP_HOST` TANIMSIZ → mailler mailpit'e gidiyor,
  gerçek müşteriye ULAŞMIYOR (panel her boot'ta kritik alarm veriyor) · `BACKUP_OFFSITE_CMD`
  TANIMSIZ → yedekler yalnız o sunucuda (alarm üretiliyor) · ADMIN_TOKEN rotasyonu (log geçmişinde
  düz metin duruyor).

**KALAN EKSİKLER TURU → AAD ORACLE'I (KENDİ EKSİK DÜZELTMEM) + KAPALI DESTEK DÖNGÜSÜ + ~40 METİN↔KOD
SAPMASI (commit 50b0f96, CANLI prod+dev, eklenti v1.1.3, migration YOK):** Kullanıcı "kalan eksikler
neler, onları da tespit edip düzeltir misin" dedi. 5 lens (belge↔gerçek uyumu · müşteri deneyimi ·
docstring iddiaları · admin metinleri · ölü-uç/kapalı-döngü taraması) + 5 ayrık-dosya işçi.

- **[YÜKSEK/güvenlik] AAD ad-alanı oracle'ı HÂLÂ AÇIKTI — 3. turdaki KENDİ düzeltmem eksikti.**
  `connectTokenAad(tokenId)` eklenmişti ama `onboarding.claim`'de **KOŞULSUZ** legacy geri düşüş
  bırakılmıştı: yeni AAD patlayınca `catch` `siteSecretAad(siteId)`'yi deniyordu. Saldırı zinciri
  kodda TAM karşılanıyordu — `site_connect_tokens.site_id` düz uuid (FK YOK) → DB'ye YAZMA erişimi
  olan biri `sites.hmac_secret_enc` blob'unu kendi eklediği token satırına KOPYALAR, `expires_at`i
  kendi yazar, kimlik istemeyen `POST /v1/connect/claim`i çağırır; yeni AAD tutmaz → catch → eski AAD
  **blob'un GERÇEKTEN şifrelendiği AAD'dir** → çözülür → sitenin DÜZ METİN `hmac_secret`'i yanıtta
  döner. Sonrasında düz metin lisans döndüren `GET /orders/:id/deliveries` dahil her site-facing uç
  imzalanabilir — **MASTER_KEY hiç ele geçirilmeden**. `crypto.service.ts` docstring'im "sınıf
  kapanır" diyordu; kapanmamıştı. "Kodların ömrü 15 dk, dal kısa sürede ölür" gerekçem de yalnız
  MEŞRU satırlar için geçerliydi — saldırgan `expires_at`i kendi yazdığı için dal ASLA ölmüyordu.
  Geri düşüş KALDIRILDI (token-AAD'ye geçiş saatler önce dağıtıldı + meşru kod ömrü 15 dk ⇒ geriye
  dönük etki YOK); o dal artık 400 + `logger.error` ile GÖRÜNÜR bir saldırı sinyali.
  **DERS ([[denetim-regresyon-dersleri]] #17'nin ikizi):** "eski davranışa geri düşüş" bir güvenlik
  düzeltmesinin İÇİNDE bırakılırsa düzeltme YAPILMAMIŞ sayılır — geri düşüşü ya kaldır ya da
  saldırganın KONTROL EDEMEYECEĞİ bir koşula (dağıtım damgası) bağla. Ve kendi düzeltmenin
  docstring'ine "kapandı" yazmadan önce saldırı zincirini kod üzerinde SON HÂLİYLE yeniden yürü.
- **[YÜKSEK/müşteri] Destek yazışması TAMAMEN KAPALI DÖNGÜYDÜ.** API'de iki yönlü yazışma kuruluydu
  (`GET/POST /v1/replacements/:id/messages` — site-scoped, iç notlar süzülü, hız sınırlı) ama eklenti
  bu uçları **HİÇ** çağırmıyor, `create()` yanıtındaki `{id}`'yi de okumuyordu. Sonuç: operatör "Ek
  bilgi iste" diyor, müşteriye soru maili gidiyor, müşterinin **cevap verecek hiçbir yolu yok**; tek
  çıkış yeni talep açmak → 24s/5 bütçesini yer, eski talep sonsuza dek `info_requested` kalır ve
  `unansweredByAdmin` hiçbir zaman `true` olamaz. Eklentiye talep referansı (`_wpteslimat_replacement_ids`
  sipariş meta) + yazışma bloğu + cevap formu eklendi. **GÜVENLİK (işçinin kendi yakaladığı):** panel
  uçları SİTE bazında yetkilendiriyor, MÜŞTERİ bazında DEĞİL → müşteri ayrımı eklentide kuruldu
  (`owns_request()`; yabancı id 403 ve panele HİÇ gitmez). Doğru katman: API mağazaya güvenir,
  müşteri ayrımı mağazanın sorumluluğudur. **SİSTEMATİK TARANDI:** 14 site-facing uçtan yalnız
  `messages` kapalı döngüydü (yararlı negatif sonuç — sorun sınırlandı).
- **[YÜKSEK/operatör] Sandbox metni YALAN söylüyordu.** "Sandbox açıkken siparişler gerçek teslimat
  üretmez" — oysa `sandbox` `apps/api/src` içinde YALNIZ mail yolunda okunuyor (`orders/` dizininde
  SIFIR eşleşme): gerçek stok tüketilir, gerçek lisans atanır, müşteri çözülmüş anahtarı görür;
  yalnız mail operatöre döner. Canlı bir mağazayı "test moduna" alıp deneme siparişi geçen operatör
  envanteri yakardı. Aynı formun 15 satır altında DOĞRUSU yazılıydı (aynı ekranda iki çelişen metin —
  bu projede tekrarlayan sınıf; doğru olanı kopyalamak yeterliydi).
- **[ORTA] Aynı ürün için iki ekran FARKLI tükenme tahmini veriyordu:** `products.detailVelocity`
  elle yazılmış statü listesi kullanıyor ve `ol.canceled` filtresi TAŞIMIYORDU (`reports.velocity` +
  `reorder.salesCte` taşıyordu) → iade yollarının aday kümesi `('active','suspended')` olduğu için
  tam iadeden SONRA hayatta kalan `expired` atama ürün detayında satış sayılıyordu. `STANDING_STATUSES`
  + `canceled=false` ile hizalandı ("aynı kavramın iki yüklemi" sınıfı).
- **[~40 METİN↔KOD SAPMASI]** şablon önceliği TERS yazılıydı (gerçek: ürün+site > ürün > site > genel;
  site'ye özel şablon yazan operatör sessizce eziliyordu) · `bundleQty` açıklaması stok yakacak
  biçimde yanlıştı (adetle ÇARPILIYOR) · `/audit` "yönetici girişleri" filtresi hiç yazılmayan bir
  enum değerine bağlıydı (daima boş; girişler `security_events`'te) · "gönderen e-posta" alanı ÖLÜ
  (`from` her zaman `MAIL_FROM`) · ön sipariş "yayın tarihinde teslim edilir" ama o tarihte hiçbir
  süpürme tetiklenmiyor · `/releases` sürüm kapısı YOKTU (düşük sürüm 201, "siteler güncelleyebilir"
  der, hiçbir site ASLA almaz — sitelere sunulan max semver) + "En yeni" rozeti `created_at`'ten ·
  `/deployments` "30 dk sonra otomatik kapanır" derken temizlik yalnız `request()` içinde ve banner
  çıkınca formlar kapalı (kilit kendi kendine AÇILAMAZ) · rehberde "denetim kaydı silinmez"
  (auto-reveal 90g budanıyor) ve "her görüntüleme audit'e düşer" (yalnız owner düz metin) · Ctrl+K
  sessizce ≥3 RAKAM istiyor · hesap ürününde anahtar araması çalışmaz · sert kotanın ödenmiş siparişi
  429 ile REDDETTİĞİ hiçbir kullanıcı metninde yoktu · `GELISTIRME.md` taze klonda çalışmıyordu
  (portları açan `docker-compose.override.yml` `.gitignore`'da, örneği YOKTU, `3005` hiçbir compose'da
  geçmiyordu) → **`docker-compose.override.yml.example`** + `wp-dev.sh` artık `exit 1` ·
  `RUNBOOK-RELEASE`'te elle rollback komutu geri almayı İPTAL ediyordu · `RUNBOOK-DR`'de iki
  dış-kopya alarmı eksikti.
- **[KOD]** `allocatableCountForLine` ön-sipariş kapısını (`stockless && release_at > now()`)
  saymıyordu → değişimde SONSUZ "tekrar deneyin" döngüsü (SQL NULL tuzağı: `NOT (a AND b)` yazılamaz,
  üç dallı OR gerekti) · admin kimlik uzunluğu OLUŞTURMA yolunda sınırsızdı (200+ karakterli e-postayla
  açılan hesap KALICI giriş yapamaz; seed yolu controller Zod'unu hiç geçmiyor) · `ACCOUNT_FAIL_KEY`
  inline kopyaları · `notExpiredCond` elle kopyası · geri çekme sonuç bandı askıdakileri saymıyordu
  (yeşil "başarılı" derken iş listesi doluydu) · "hiç bağlanmadı" rozeti `last_seen_at`'e bakmıyordu ·
  `revoke_failed` + `notice_failed` sözlükte yoktu (operatör çıplak snake_case görüyordu — ilki
  sistemin EN ALARM VERİCİ olayı: "müşteride canlı lisans kalmış olabilir").
- **[BAĞIMLILIK] Dev açıkları kapandı:** vitest 2→3 + `vite`/`esbuild` override → `pnpm audit`
  **TÜM AĞAÇ** için temiz (6 açık). Daha önce "vitest 2→3 MAJOR, 400+ testi riske atar" diye
  ertelenmişti; paket `globalSetup` sayesinde aynı DB'de tekrar tekrar koşabildiği için risk artık
  ÖLÇÜLEBİLİYORDU → yükseltildi ve entegrasyon 410/410 + yarış 3/3 ile doğrulandı.
- **[TEST]** sabit payload'lar etiketlendi (MASTER_KEY sabitlenirse `payload_hash` çakışır ve
  `onConflictDoNothing` SESSİZCE atlar) + `importKeys`'e "sessiz atlama yasağı" kontrolü + dosya
  sırası **ALFABETİK** sabitlendi (`sequence.sequencer`). Eskiden sıra dosya BOYUTUNA bağlıydı → bir
  satır eklemek koşum sırasını sessizce değiştiriyordu; **koşarak DOĞRULANDI** (`account-…`,
  `admin-revoke-…`, `admin-totp`, `admin-users.auth`, `anonymize`, `audit-list`).
- **[OPS — kod değil, CANLI YAPILDI] `ADMIN_TOKEN` rotasyonu.** Tüm tüketiciler tek `.env`'den okuyor
  (compose → api+admin; runner betikleri grep'liyor) → tek satır + yeniden başlatma. Değer hiçbir yere
  YAZDIRILMADAN döndürüldü. Doğrulandı: yeni token 200, **eski token 401**, `/health` 200, admin
  render ediyor, deploy+backup runner'ları 201 almaya devam ediyor (75 sn ölçüm: yeni 401 YOK —
  log'daki 401'ler geçmişten kalma). `.env` yedeği (tüm prod sırlarının kopyası) silindi.
- **Doğrulama:** typecheck 4/4 + **5 kapı** · birim shared 64 + api 174 + admin 154 · build 3/3 ·
  **VPS taze test DB: entegrasyon 410/410 + yarış 3/3** · PHP-lint 13/13 · `pnpm audit` temiz ·
  prod `/v1/health` 200 v1.1.0 + admin `/pending` 200 + api 0 ERROR · dev güncel · **eklenti v1.1.3
  yayınlandı** (201, 130.557 bayt; public `plugin/info` 1.1.3, `download/1.1.3` 200, boyut birebir).
- **BİLİNÇLİ YAPILMAYAN (raporlandı):** `.env.bak.1785665590` (benim değil, ~2 hafta önce) tüm prod
  sırlarının fazladan kopyası — canlı `.env` ile AYNI MASTER_KEY/SESSION_SECRET/DB parolası taşıyor
  (yani kurtarma artefaktı DEĞİL), izinleri 0600 ve `.dockerignore` kapsamında → SİLİNMEDİ (kullanıcının
  dosyası, düşük risk). · `apps/audit/constants.ts`'te `login` enum değeri bilerek bırakıldı (sunucu
  doğrulaması enum'un tamamını kabul etmeli), yalnız açılır listeden elendi.
- **OPERATÖRE KALAN (kod değil, DEĞİŞMEDİ):** prod `SMTP_HOST` TANIMSIZ → teslimat mailleri gerçek
  müşteriye ULAŞMIYOR (panel her boot'ta kritik alarm) · `BACKUP_OFFSITE_CMD` TANIMSIZ → yedekler
  yalnız o sunucuda. (ADMIN_TOKEN rotasyonu bu turda YAPILDI, listeden düştü.)

**MAK SAYILARI KENDİNİ ANLATIYOR + İADE SONRASI BAYAT PANEL-DURUMU (commit e649b9c→ab56a71, CANLI
prod+dev, eklenti v1.1.7, migration YOK):** Kullanıcı ekran görüntüsüyle: *"bu siparişte 5 etkinleştirme ·
anahtar geneli 5/5 — daha açıklayıcı olmalı; başka yerde de yeterince belirtilmiyorsa onları da düzelt"*.
- **Sayılar doğruydu, ANLATIM eksikti.** Okuyan kişi iki şeyi kendi bilmek zorundaydı: aynı MAK anahtarının
  BAŞKA siparişlerde de kullanıldığı ve o anahtarda satılabilir hak kalıp kalmadığı. Satır artık
  **"Bu siparişe N etkinleştirme"** + **"Anahtarın toplamı: X/Y · N hak kaldı"** (tükenmişse "tükendi");
  lisans listesinin başında, YALNIZ MAK satırında, tek seferlik düz Türkçe açıklama.
- **Aynı belirsizliğin diğer yerleri (kullanıcının isteği):** ürün özeti `MAK×5` → **`MAK (varsayılan 5
  kullanım)`** — kapasite artık anahtar başına verilebildiği için o sayı bağlayıcı tavan DEĞİL varsayılandır
  (dev'de aynı üründe 5, 3 ve 1001 kapasiteli anahtarlar bir arada ölçüldü; `×5` "her anahtar 5 taşır" diye
  okunuyordu) · ürün listesi STOK kolonu MAK satırında **"hak" birimi** (aynı kolon tek kullanımlıkta ANAHTAR,
  MAK'ta KULLANIM HAKKI sayıyor; çıplak `1002` "1002 anahtar" diye okunuyordu — ipucu metni görünmez, yetmez) ·
  kategori kartı "N stok" ipucu · mağaza sipariş ekranı (eklenti v1.1.7) panelle BİREBİR aynı dile hizalandı.
- **[Testin bulduğu kusur, eklenti v1.1.6]** Tam iadeden sonra mağaza SİPARİŞ LİSTESİNDEKİ panel-durum kolonu/
  filtresi BAYAT kalıyordu (panel `revoked`, liste "Teslim edildi"). Aynı kavramın iki meta anahtarı var ve
  `_wpteslimat_panel_status`'ı yalnız geri-kanal webhook'u yazıyordu; panel iade için webhook ÜRETMEZ. Ortak
  `set_panel_status()` push/uzlaştırma/iade yollarının üçüne bağlandı. **Önce/sonra aynı ortamda kanıtlandı**
  (#76 bayat `fulfilled`, #77 `revoked`).
- **Doğrulama:** typecheck 4/4 + 5 kapı · admin birim 159 · admin production build · dev **36 rota 200** ·
  gerçek MAK siparişinde ve ürün listesinde tarayıcı çıktısıyla ölçüldü · prod deploy → `/health` 200 v1.1.0,
  admin `/pending` 200, 0 hata · eklenti v1.1.7 yayınlandı. API mantığı bu turda DEĞİŞMEDİ (son entegrasyon
  koşusu 428/428 geçerli).
- **DERS:** bir sayıyı ekrana koyarken "KİMİN sayısı, hangi BİRİMDE" sorusu metinde yanıtlanmalı; aynı kolon
  iki farklı şeyi sayıyorsa birim yazılmalı. Görünmez `title` ipucu tek başına yeterli DEĞİLDİR.

**MAK KAPASİTESİ ANAHTAR BAŞINA + DEV SIFIRLAMA + TÜM SİPARİŞ TÜRLERİNİN E2E TESTİ (commit
58ac630→e649b9c, CANLI prod+dev, eklenti v1.1.6, migration YOK):** Kullanıcı: *"MAK lisans anahtarı
stoğu eklerken kapasiteyi ayarlayamıyorum; ürün düzenle kısmından değil de ANAHTARA GÖRE
ekleyebilmek daha doğru olur"* + *"dağıtmadan önce tüm siparişleri WordPress ve panel tarafında
temizle, sonra dağıt ve tüm sipariş türlerini admin@dev.local üzerinden test et"*.
- **KÖK BULGU: şema ZATEN satır bazındaydı** (`license_items.max_uses`); import onu ürün ayarından
  KOPYALIYORDU. Yani kısıt ekrandaydı, veritabanında değil. Sonuç: 50'lik lot gelince operatörün
  iki seçeneği vardı — ürünü geçici değiştirmek (ve o sırada giren her şeyin kapasitesini bozmak)
  ya da yanlış kapasiteyle girmek; ikincisi **SESSİZ AŞIRI SATIŞ** (panel 500 hak sanar, anahtar
  50'de biter).
- **Sözleşme:** `ImportItem.maxUses` (opsiyonel, 1…`MAX_USES_CAP`). Alt sınır MAK'ta **1** — ürün
  seviyesindeki `>1` kuralından BİLEREK farklı: ürün alanı bir VARSAYILANDIR (1 olması "her anahtar
  tek satışta tükenir" demek = misconfig), ama TEK BİR ANAHTARIN gerçekten 1 hakkı kalmış olabilir.
  Tek kullanımlık üründe kapasite gönderilirse **TÜM istek 400** (sessizce yok sayılmaz); geçersiz
  değer YALNIZ o satırı reddeder (satır no korunur). Kilitli yeniden-doğrulama artık yalnız
  VARSAYILANA DAYANAN satırları geçersiz kılar (`usedProductDefault`).
- **`productCapacityChange` DARALTILDI:** veri bozan tek geçiş `multi → single` (allocate tek-kullanım
  dalına düşer, anahtar başına N−1 hak yanar). Varsayılanı **düşürmek serbest** — satırlar kendi
  kapasitesini taşır ve atama/stok/rapor yollarının hepsi SATIRDAN okur. Eskiden 409 veriyordu ve
  tam da 50'lik lota geçen operatörü kilitliyordu. İki birim testi yeni kurala güncellendi.
- **Arayüz:** "Her anahtarın kullanım hakkı" alanı (ürün varsayılanıyla dolu, "Varsayılan (N)"
  dönüş düğmesi) + **"Anahtarların kapasiteleri farklı"** seçeneğiyle iki sütunlu yapıştırma
  (mevcut CSV/ayraç çözümleyicisi; **sessiz çıkarım YOK** — seçenek kapalıyken ikinci sütun asla
  yorumlanmaz). Sayaç ve onay modali toplamı SATIR kapasitelerinden hesaplar; okunamayan kapasitede
  tahmini sayı yazmaz, girişten ÖNCE uyarır. Ürün formu etiketi "Anahtar kapasitesi (varsayılan)".
  Tek kullanımlık üründe HİÇBİR ŞEY değişmez (alanlar render edilmez, gövdeye kapasite girmez).
- **DEV SIFIRLAMA:** belgelenmiş yordam ([[dev-veri-sifirlama]]) aynen uygulandı — yedek → **API DUR**
  → WP force-delete → panel TRUNCATE (CASCADE'siz) → **Redis FLUSHALL** → API BAŞLAT → 6 sweep
  zamanlayıcısı doğrulandı. `dev-clean-3.sql` şemayla hizalandı: `supplier_claims` +
  `supplier_claim_items` EKLENDİ (0033'te geldi; `supplier_claims.supplier_id` FK'si yüzünden
  listede olmadan `suppliers` TRUNCATE'i zaten hata verirdi — güvenlik ağının çalıştığının kanıtı),
  `product_guides`/`product_categories` BİLEREK korundu (ürün YAPILANDIRMASI, işlem verisi değil).
  Sonuç: panel 0 sipariş / WP 0 sipariş; site+ürün+kategori+rehber+eşleme+katalog+yayın kanalı yerinde.
  **PROD'A DOKUNULMADI.**
- **TÜM SİPARİŞ TÜRLERİ — GERÇEK WooCommerce, müşteri `admin@dev.local` (11 sipariş):** tek kullanımlık
  tam teslimat · MAK tek-anahtar (kapasite 500 → **TEK atama, 3 birim**) · **MAK KARIŞIK kapasite**
  (aynı üründe 5'lik ve 3'lük anahtar, 7 birim → 5+2 taşma) · süreli hesap (`valid_until` +365 gün) ·
  kod/hediye çeki · çok kalemli karışık sipariş · kısmi teslimat (1/5) · stok yok (pending) ·
  **ya-hep-ya-hiç** (stok 2 / talep 5 → **0 teslim**) · eşlenmemiş ürün (`unmapped`, yanlış teslim YOK) ·
  stoksuz/ön sipariş (pending). Sonra: **tam iade** (anahtar KARANTİNA, satır `canceled`) · **kısmi iade**
  (MAK 7→5; §2 kapasite havuza DÖNMEDİ) · **"Sorun Bildir"** (destek talebi 201) · **otomatik tamamlama**
  (stok girişi 3 bekleyen satırı doldurdu, sipariş `fulfilled`).
- **TESTİN BULDUĞU KUSUR → eklenti v1.1.6:** tam iade sonrası mağaza SİPARİŞ LİSTESİNDEKİ panel-durum
  kolonu/filtresi BAYAT kalıyordu (panel `revoked`, liste "Teslim edildi"). Aynı kavramın İKİ meta
  anahtarı var — `_wpteslimat_status` (metabox/müşteri) ve `_wpteslimat_panel_status` (liste kolonu +
  filtre) — ve ikincisini YALNIZ geri-kanal webhook'u yazıyordu; panel iade için webhook ÜRETMEZ.
  Ortak `set_panel_status()` (iki meta + bayat teslim sayaçlarının temizliği) push/uzlaştırma/iade
  yollarının ÜÇÜNE birden bağlandı. **ÖNCE/SONRA aynı ortamda kanıtlandı:** #76 (düzeltme öncesi
  iade) `panel_status=fulfilled` bayat kaldı, #77 (sonrası) `panel_status=revoked`.
- **Doğrulama:** typecheck 4/4 + 5 kapı · birim shared 68 + api 184 + admin 159 · admin production
  build · **VPS izole PG+Redis: entegrasyon 428/428** (5 yeni) · **kontrol denemesi:** satır kapasitesi
  geri alınınca 3 test KIRMIZI · PHP-lint temiz + eklenti davranış 108/108 · prod `deploy.sh api admin`
  (rollback'li) → `/v1/health` **200 v1.1.0**, admin `/pending` 200, api 0 ERROR · eklenti **v1.1.6**
  yayınlandı (201, 138.544 bayt).
- **DERS:** "ekranda ayarlanamıyor" şikâyetinde önce ŞEMAYA bak — kısıt çoğu zaman veri modelinde
  değil sunumdadır; ve bir alanı "varsayılan" yapınca onu KORUYAN guard'ı da (409) yeniden değerlendir,
  yoksa özellik kendi kilidini getirir.

**MAK TESLİMAT GÖRÜNÜRLÜĞÜ + TEK ANAHTAR TERCİHİ + GERÇEK MAİL ÖNİZLEMESİ (commit 9199d32, CANLI
prod+dev, eklenti v1.1.5, migration YOK):** Kullanıcı ekran görüntüsüyle bildirdi: *"6 adet satın alım
yapılmış ama 16 adet kullanım hakkı olarak teslim ediliyor; 6'dan fazla MAK anahtar varsa 6 farklı
anahtar gidebilir ama tek anahtar varsa aynı anahtarı 6 kez etkinleştirilebilir şeklinde vermeli"* +
*"mail önizlemesi birebir mailde gösterildiği gibi görünmeli, tasarımsal olarak gerçek olmalı"*.
- **ÖLÇÜLDÜ (dev DB) — VERİ DOĞRUYDU, EKRAN YANLIŞ ANLATIYORDU.** Sipariş #69'un payı gerçekte
  **5 + 1 = 6**; paneldeki `10/10` ve `6/10` çipleri **anahtarın TÜM siparişlerdeki** sayacıydı
  (kalan 10 → #58→2, #59→3; #59→1, #67→3, #68→1) ve bu hiçbir yerde YAZMIYORDU. Aynı düzeltme WP
  eklentisinde v1.0.7'de yapılmıştı — **panelin kendi sipariş detayı geride kalmıştı** (bu projede
  tekrarlayan sınıf: aynı bilgiyi gösteren iki yüzeyden biri güncellenip diğeri unutuluyor).
  Artık satırda önce **"bu siparişte N etkinleştirme"** (vurgulu), yanında ETİKETLİ **"anahtar geneli
  X/Y"** (title: "bu siparişin payı değildir"); özet şeridinde "toplam N etkinleştirme hakkı".
  Kip ürünün `usageMode` alanından gelir; `maxUses > 1` yalnız eski API imajı yedeğidir.
- **DAĞITIM KURALI DEĞİŞTİ (asıl istek).** `consumeMultiUseCapacity` sıralamasının BİRİNCİ anahtarı
  artık *"kalan kapasitesi talebi TEK BAŞINA karşılıyor mu"*; FEFO (`expires_at`) ve FIFO
  (`created_at, seq`) AYNEN ikinci/üçüncü anahtar olarak durur. Sonuç: karşılayan anahtar varsa TEK
  anahtar + TEK atama; yoksa eski doldur-taşır davranışı birebir; küçük talep yarım kalmış anahtarı
  "karşılayan" yapar ve FIFO onu ÖNCE seçer → parça kapasite çürümez. **Gerekçe yalnız derli görünüm
  değil:** MAK anahtarı PAYLAŞIMLIDIR, panel yalnız DEFTER tutar (müşteriyi anahtarın kalan
  kapasitesini kullanmaktan alıkoyan teknik bir şey yok) → eline geçen her FAZLADAN anahtar fazladan
  aşırı-etkinleştirme yüzeyidir. FEFO'nun zayıfladığı tek durum: süresi yakın anahtarın KALANI talebi
  karşılamıyorsa o tur atlanır (ondan küçük her sipariş onu yine ilk sırada seçer; MAK'ta `expires_at`
  pratikte NULL). **Dev gerçek HMAC siparişiyle kanıtlandı:** ilk anahtarda 3 boş, talep 5 → eski
  davranış 3+2 (müşteriye İKİ anahtar), yeni davranış tek atama `units=5`, diğer ikisine dokunulmadı.
- **MÜŞTERİ METNİ — iki ayrı yanlış kapandı.** Mail `"(5 adet)"` diyordu ("5 anahtar" gibi okunuyor)
  ve **`units=1` olan MAK anahtarında HİÇBİR ŞEY yazmıyordu** (#69'un ikinci satırı: çıplak anahtar →
  müşteri tamamının kendisine ait olduğunu sanıyor). Karar artık `units`e değil ÜRÜN MODUNA bağlı
  (`mail-render.unitLabel`): `multi` ise HER ZAMAN yazılır → "(bu siparişte N etkinleştirme hakkı)";
  hesap ürününde "kullanım hakkı" (hesap açılır, etkinleştirilmez); `single` ise HİÇ yazılmaz.
  `getDeliveries` + `siteAdminView` EKLEMELİ `usageMode` döndürür → WP eklentisi (v1.1.5) aynı kuralı
  müşteri sayfası + indirilen .txt + mağaza sipariş ekranında uygular (tek kaynak `units_note`);
  alan gelmezse eski `units > 1` kuralına düşer (dağıtım sapması toleransı).
- **MAİL ÖNİZLEMESİ GERÇEĞE BENZETİLDİ.** Ham kaynak Mailpit'ten okundu: **tek parça
  `text/plain; charset=utf-8`, HTML parça YOK** → "gerçek gibi görünmek" = mail istemcisinin düz
  metni gösterdiği gibi göstermek. Önizleme artık e-posta TIPKIBASIMI: zarf başlığı
  (Kimden/Kime/Konu/Tarih), **orantılı** yazı tipi (istemciler düz metni monospace GÖSTERMEZ),
  `pre-wrap` + `overflow-wrap:anywhere`, **beyaz kâğıt — koyu temada da** (panelin teması "müşteriye
  ne gidiyor" yargısını değiştirmemeli; renkler token DEĞİL sabit), `dangerouslySetInnerHTML`'siz
  linkify (React `<a>` düğümleri — şablonu OPERATÖR yazar). Uydurma gönderim tarihi BASILMAZ
  ("Önizleme anı"): `email_log` gövde/zaman saklamaz. Panelin kendi bantları (maskeleme/test modu/
  gönderim kaydı/"arşiv değil") kâğıdın DIŞINDA kalır. `mail.processor` artık `from`u builder'dan
  okur (tek nokta).
- **Doğrulama:** typecheck 4/4 + 5 kapı (use-server 26/89 · nest-wiring 42/133+13 · env 51 ·
  workflows 2/4/47 · tx-pool 37) · birim shared 68 + api **184** + admin **159** · admin production
  build · **VPS izole PG+Redis: entegrasyon 423/423 + yarış 3/3** · **kontrol denemesi: düzeltme geri
  alınınca yeni 3 MAK dağıtım testi KIRMIZI** · PHP-lint temiz + eklenti davranış 108/108 ·
  **tarayıcıda ölçüldü** (kâğıt `rgb(255,255,255)` koyu temada, gövde 14px/1.6, kontrast **7.3:1**,
  375px yatay kayma **0**, `https://www.office.com` gerçek bağlantı) · prod `deploy.sh api admin`
  (rollback'li) → `/v1/health` **200 v1.1.0**, admin `/pending` 200, api **0 ERROR** · eklenti
  **v1.1.5 yayınlandı** (201, 137.848 bayt; public info 1.1.5 + download 200 birebir).
- **DERS:** "yanlış teslim ediliyor" şikâyetinde önce VERİYİ ölç — bu turda kusur teslimatta değil
  ANLATIMDAYDI; ama aynı ekranda ikinci bir gerçek kusur (gereksiz anahtar bölme) de vardı. Bir sayı
  gösterirken KİMİN sayısı olduğunu yazmıyorsan, operatör onu kendi bağlamında toplar.

**ATAMA MOTORUNDA AŞIRI TESLİMAT (LIMIT KAÇAĞI) + 33 DENETİM BULGUSU (commit cb85d8e, CANLI
prod+dev, eklenti v1.1.4, migration YOK):** Kullanıcı "değişikliklerini ve projeyi baştan sona
incele, sorunları fixle, sonra dev/prod hepsini yayınla" dedi. Turun asıl bulgusu, aylardır
"test gürültüsü" sanılan şeyin **üretimde canlı bir para-yolu hatası** olduğuydu.
- **[KRİTİK] `assignAvailableSingleUse` LIMIT'i bazen hiç uygulamıyordu.** Desen
  `UPDATE license_items WHERE id IN (SELECT … LIMIT n FOR UPDATE SKIP LOCKED)` idi. READ
  COMMITTED'da UPDATE hedef satırı eşzamanlı değiştirilmiş bulursa satırın YENİ sürümü üzerinde
  WHERE'i yeniden değerlendirir (EvalPlanQual) ve `IN (…)` alt sorgusu **YENİDEN KOŞAR**; her
  koşuda "ilk n" baştan seçilir, `SKIP LOCKED` o an kilitli olanları atlar → kümelerin BİRLEŞİMİ
  güncellenir ve LIMIT fiilen kalkar. **ÖLÇÜLDÜ** (izole PG+Redis, tek süreç, `fileParallelism:false`,
  ~3 koşumda 1): `qty=6` istenirken **20 satır** — o ürünün TÜM stoğu — döndü, 20'si de tek sipariş
  satırına atandı; motorun kendi olayı `+20 atandı (20/6)` yazdı. Yani müşteriye bedava lisans +
  envanterden sessiz yanma. **DÜZELTME:** seçim `WITH picked AS MATERIALIZED (…)` içinde BİR KEZ
  yapılır — MAK yolu (`consumeMultiUseCapacity`) bu doğru deseni ZATEN kullanıyordu, tek-kullanımlık
  yol geride kalmıştı — artı **fail-closed kalkan**: istenenden fazla kalem dönerse `throw` →
  transaction geri alınır (sessiz aşırı teslimat yerine görünür hata). `MATERIALIZED` AÇIKÇA yazılır
  (tek referanslı CTE inline edilebilir, tuzak geri gelirdi). Regresyon: `allocate-limit.test.ts`.
- **TEŞHİS YÖNTEMİ (ders):** ilk "izolasyon deneyim" beni YANLIŞ yöne götürdü — yeni test dosyasını
  çıkarınca paket yeşil geldi ve dosyayı suçladım; oysa o koşu veritabanını da temizliyordu
  (confounded). **Kontrol deneyi** (kendi değişikliklerimi TAMAMEN çıkarıp `50b0f96`'yı aynı ortamda
  koşmak) hatanın dağıtılmış kodda olduğunu kanıtladı. Sonra: paralellik mi? (zorla tek-fork seri →
  yine kırmızı) · ortam mı? (dev yığınından tamamen izole PG+Redis → yine kırmızı) · dosyalar arası
  mı? (tek dosya 6/6 yeşil → evet) · hangi katman? (testi, sonra `completeLine`'ı, sonra sorgunun
  KENDİSİNİ enstrümante ettim → `{"qty":6,"tip":"number","donen":20}`). **Aralıklı bir kırmızıyı
  "gürültü" saymak, bir üretim hatasını aylarca gizleyebilir.**
- **Kullanıcı istekleri (3):** **mail önizleme** — sipariş detayında göz ikonu → modal; gövde,
  gerçek gönderimin kullandığı AYNI üreticiyle (builder gönderim yolundan TAŞINDI, kopyalanmadı)
  üretilir; rol-farkında maskeleme + `reveal` denetim kaydı (yalnız düz metin gösterilirken) +
  `<pre>` (şablonu operatör yazıyor). `email_log` GÖVDE SAKLAMAZ → ekranda "bu bir arşiv değil,
  anlık yeniden üretim" AÇIKÇA yazılı. **MAK kapasitesi** — `use_count` ASLA düşmez (§2 sessiz
  aşırı-satış); `max_uses = use_count + girilen kalan`; `depleted → available` canlanır (yoksa
  kapasite artar ama kalem hiçbir atamaya girmez); owner-only + sebep zorunlu + ürün `FOR SHARE`
  (import yolunun deseni; yoksa eşzamanlı `multi→single` düzenlemesi yüzlerce aktivasyonu yakardı) +
  commit SONRASI tamamlama motoru tetiklenir (stok girişiyle paylaşılan `triggerAutoComplete`).
  **Envanter sadeleşti** — müşteri lisansını değiştirme kaldırıldı (o iş siparişte), hesap kimlik
  güncelleme sipariş detayına taşındı; envanter = stoğu gör + yanlış girilen kaydı düzelt.
- **`products/limits.ts` (yeni yaprak modül):** `products.controller` ⇄ `stock.service` DÖNGÜSEL
  import'u kırıldı. CommonJS döngüsünde ikinci yüklenen modül KISMİ `exports` görür → sabit
  `undefined` gelir ve zod `.max(undefined)` sınırı **SESSİZCE** uygulamaz (hata yok, log yok).
  Kapanan şey önemsiz değil: `KEY_FORMAT_MAX_LENGTH` katastrofik-backtracking regex DoS yüzeyini
  sınırlıyor. Bugün yalnız `app.module`'deki yükleme SIRASI sayesinde patlamıyordu — invaryant değil.
- **33 denetim bulgusu (3 denetim ajanı → 4 paralel ayrık-dosya işçi):** maskeli fiş uyarısı HİÇ
  render edilmiyordu (bayrak zarfın üst düzeyinde, istemci `claim.masked` okuyor; `ClaimRow` tipi
  alanı tanımladığı için `tsc` sessizdi) · `/review` "Reddet" idempotent no-op'ta bile "müşteriye
  lisans gitmedi" diyordu · owner kendi satırındaki "2FA Kapat" ile kendi GİRİŞ kilidini yakabiliyordu
  (parola denemeleriyle AYNI kova) · destek yanıtı müşteriye ulaşmadığında "kaydedildi" deniyordu ·
  Ctrl+K arama hatası "Sonuç yok."a dönüşüyordu · dashboard KPI'ları elde varken "—" gösteriyordu ·
  **şablon önceliği editörde TERS yazılıydı** (gerçek: ürün+site > ürün > site > genel → bir mağazaya
  özel mail yazan operatör sessizce eziliyordu) · parti detayı AKTİF partide olmayan menü öğesini
  vaat ediyordu · site sihirbazı webhook'un "boş bırakırsanız" doldurulacağını söylüyordu (gerçekte
  connect akışı HER ZAMAN eziyor; kardeş alanın `manual` bayrağı var, webhook'ta yok) ·
  `canceledUnits` sunuma çıkmıyordu (aynı kutuda "2/3 bekliyor" + "Teslim edildi") · tedarikçi
  **kusur karnesi** hesaplanıp atılıyordu ("hangi tedarikçi bozuk anahtar gönderiyor" cevapsızdı) ·
  maliyet raporunda ömrü dolmuş sermaye görünmüyordu · KVKK anonimleştirme 7 sayaçtan 2'sini
  gösterdiği için "hiçbir şey olmadı" gibi okunuyordu · `dead_letter:*` hedef tipi hem ham görünüyor
  hem süzülemiyordu · **WP (v1.1.4):** panelde PASİF eşleme "Eşli" görünüyordu · varyasyonlu üründe
  kutu değiştirdiğinizi sandırıp AYRI ürün-seviyesi kayıt yazıyordu (o varyasyonun siparişleri ESKİ
  ürünü teslim etmeye devam ediyordu) → varyasyon satırları artık salt-okunur ayrı blokta · MAK'ta
  "Değiştir" garantili 400 veriyordu → sebebiyle kapalı (`maxUses>1` çıkarımı; panel `usageMode`
  döndürmüyor, sınırı koda yazıldı) · ham hata enum'u ("Not Found"/"validation_error") kullanıcıya
  basılıyordu → tek kaynak `error_message()` · katalog kırpması sessizdi → `?meta=1` zarfı + görünür
  uyarı (önbellek anahtarı `_v2`, yoksa eski düz-dizi önbellek yeni koda düşüp listeyi BOŞALTIRDI).
- **Doğrulama:** typecheck 4/4 + **5 kapı** (use-server 26/89 · nest-wiring 42 modül/133 sınıf +13
  kuyruk · env 51 · workflows 2/4/47 · tx-pool 37) · birim shared 68 + api 179 + admin 159 · build 3/3 ·
  **VPS'te dev yığınından TAMAMEN İZOLE PG+Redis: entegrasyon 421/421 × 3 ARDIŞIK + yarış 3/3**
  (düzeltme öncesi aynı ortamda ~%50 kırmızıydı; düzeltme sonrası alt kümede ayrıca 8/8) · PHP-lint
  12/12 + eklenti davranış **108/108** · prod `deploy.sh api admin` (rollback'li) → `/v1/health`
  **200 v1.1.0**, admin `/pending` **200**, api **0 ERROR** · dev yığını güncel · **eklenti v1.1.4
  yayınlandı** (201, 135.714 bayt; public `updates/plugin/info` 1.1.4 + `download/1.1.4` 200 birebir).
- **KENDİ HATALARIM:** `sql` şablonunun İÇİNDE ters tırnak (**10. kez** — o bloğa yasak notu düşüldü) ·
  düzeltmeyi VPS'e göndermeden koşu başlattım (bir koşu boşa gitti) · iki kez YANLIŞ ana makine adını
  sorgulayıp (`lisans.` vs `admin.` alt alanı) kısa süre sorun sandım — ölçmeden önce adresi doğrula.
- **OPERATÖRE KALAN (kod değil, DEĞİŞMEDİ):** prod `SMTP_HOST` TANIMSIZ → teslimat mailleri gerçek
  müşteriye ULAŞMIYOR (panel her boot'ta kritik alarm veriyor) · `BACKUP_OFFSITE_CMD` TANIMSIZ →
  yedekler yalnız o sunucuda.
