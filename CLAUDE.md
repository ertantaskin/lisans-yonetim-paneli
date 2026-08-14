# Lisans Yönetim Paneli — Merkezi Lisans Dağıtım Paneli

Dijital lisans satışı (Windows/Office key, hesaplar, kodlar) için WooCommerce'ten
ayrık merkezi stok/teslimat paneli. Tam mimari şartname: `docs/MIMARI.md`
(v2.6, 23 bölüm — HER önemli kararda önce bu dokümana bak).
Canlı görsel kopya: https://claude.ai/code/artifact/4adb7a2c-ba7d-4379-b0ee-2f7b07b56b7c

## Yığın (kesinleşti)

- NestJS (Node 22, Fastify) API + Next.js admin, pnpm + Turborepo monorepo
- PostgreSQL 17 + Drizzle ORM, Redis 7 + BullMQ, Docker Compose + Caddy
- UI: Tailwind v4 + shadcn/ui + TanStack Table/Query; WP eklentisi ince istemci (PHP)

## Değişmez kurallar

- Lisans verisi ASLA WP veritabanında durmaz; panel tek doğruluk kaynağı
- Atama: `FOR UPDATE SKIP LOCKED` + idempotency key (site+order+line) — çifte satış imkânsız
- Kısmi teslimat birinci sınıf akış (partial-auto varsayılan politika)
- Payload'lar AES-256-GCM envelope encryption; reveal/kopyalama audit'e düşer
- HMAC-SHA256 + timestamp + nonce imzalı API; site başına scope + dinamik satış kotası
- Ödeme tamamen WP/geçit tarafında — panel ödemeye dokunmaz, ödenmiş siparişi görür
- Yenileme/abonelik entegrasyonu YOK (bilinçli kapsam dışı); havale rezervasyonu YOK

## Ürün modeli

`usage_mode: single | multi` (MAK: 1 key = 500 kullanım, atomik kapasite düşümü,
iadede hak otomatik dönmez). Tipler: key, hesap, süreli hesap (`validity_days`,
teslimle başlar), kod/hediye çeki, stoksuz/ön sipariş (`stockless`, `release_at`).

## Görsel kimlik

> **GÜNCEL REFERANS (2026-08-14): shadcnspace** — `dashboard.shadcnspace.com` (analytics +
> ecommerce panoları) tarayıcıda ÖLÇÜLEREK uyarlandı. Aşağıdaki satnaing/shadcn-admin bölümü
> **paletin ve token mimarisinin** kaynağı olarak GEÇERLİ (ikisi de standart shadcn nötr oklch
> paletini kullanıyor — ölçüldü, değerler birebir aynı); DEĞİŞEN kısımlar:
> **font Inter/JetBrains Mono → Geist / Geist Mono** (`next/font/google`, `latin-ext` ŞART —
> `latin` alt kümesinde ş/ğ/İ/ı/ç yok) · **`--radius` 0.625rem → 0.5rem** (kart `rounded-xl`
> 12px, düğme/alan `rounded-lg` 8px) · **kabuk `variant="inset"`** (sayfa zemini `bg-sidebar`,
> içerik `m-2 ml-0 rounded-xl outline shadow-sm` ile YÜZEN kart; başlık `sticky top-2` +
> `rounded-t-xl`) · **sidebar aktif öğe DOLU pill** (`bg-primary text-primary-foreground`;
> eskiden soluk `bg-sidebar-accent`), hover `bg-primary/5 text-primary` + `translate-x-1`
> (ikon modunda ve `motion-reduce`'ta kapalı) · **grup etiketi 12px/600 uppercase muted** ·
> **tablo başlığı `h-11 text-sm font-semibold` KOYU, büyük harf YOK** (hücre `px-4 py-3` —
> referansın `py-6`'sı 8-12 kolonlu operasyon tablolarında kullanılamazdı, bilinçli sapma) ·
> **gölge dili `shadow-sm` → `shadow-xs`** (referansla birebir: `0 1px 2px rgb(0 0 0/.05)`) ·
> **yalnız-ikon düğme = DAİRE** · kart `px-6`, başlık 16px, açıklama 14px · StatTile etiketi
> normal cümle düzeninde 14px muted (eskiden 11px BÜYÜK HARF).
>
> **BİLİNÇLİ SAPMALAR (referansı KOPYALAMADIK):** (1) referansın `main`'i `overflow:hidden`
> olduğu için **sticky başlıkları çalışmıyor** (ölçüldü: 600px kaydırınca başlık −592'ye gitti)
> → bizde `overflow-x-clip` + `sticky top-2` ile başlık GERÇEKTEN sabit; (2) `--ring` referansta
> açık temada oklch(0.708) — bizde 0.48 KALIYOR, çünkü odak göstergesi TEK kaynak bu outline'dır
> ve 0.708 kontrastı 6.54:1'den ~2.5:1'e düşürürdü (belgelenmiş a11y kararı, §17); (3) 5 hue'lu
> semantik durum dili (`success/info/warning/attention/destructive`) KORUNDU — referansta yok
> ama panelin durum dili buna bağlı.
>
> **ESKİ TEMA YEDEĞİ:** `apps/admin/theme-backup/legacy/` (16 dosya birebir) +
> `theme-backup/README.md` + `bash apps/admin/theme-backup/restore.sh` ile tek komutta geri
> yüklenir. Klasör `tsconfig.json` `exclude` ve `check-use-server.js` `SKIP_DIRS` içinde —
> build'e/taramaya GİRMEZ (girseydi göreli import'lar typecheck'i kırardı).

Referans (palet + token mimarisi): **satnaing/shadcn-admin** (shadcn-admin.netlify.app). Stack: klasik
**shadcn/ui deseni + Radix UI** (Base UI değil) + Tailwind v4 (CSS-first, `tailwind.config.js`
YOK — token'lar `@theme`/`@theme inline` içinde) + TanStack Table + Recharts + lucide +
cmdk + sonner + next-themes; hepsi ücretsiz/MIT. Framework: **Next.js 15 (sunucu-taraflı)**
korunur (şablon Vite olsa da güvenlik gereği). Palet: **standart shadcn nötr oklch** —
`--background/--foreground/--card/--primary/--secondary/--muted/--accent/--border/--ring`
+ `--sidebar-*` + `--chart-1..6`; nötr primary (açıkta koyu, koyuda açık), renk YOK
(monokrom). Semantik uzantı (durum dili, renkli tutulur) — **BEŞ hue** (kullanıcı kararı, eskiden
üçtü): `--success` (emerald: elimde/sağlıklı), **`--info` (mavi: teslim edildi/tamamlandı)**,
`--warning` (amber: bekliyor), **`--attention` (mor: insan kararı — İncelemede/Askıda)**,
`--destructive` (rose: ölü/engelli) — açık temada AA (≥4.5:1) sağlayacak koyulukta, koyu temada
daha açık. Rozet = soluk tint (%13-16) + saç teli `ring-inset` (%28-30). Tema: `.dark` class (next-themes `attribute=class`). **Tek kaynak:**
`apps/admin/app/globals.css`. Kabuk: resmi shadcn **sidebar block** deseni
(`ui/sidebar.tsx` — SidebarProvider/Sidebar/SidebarInset/SidebarTrigger, cookie kalıcılık,
Ctrl/⌘+B, icon-collapse, mobil sheet) + `app-sidebar` + `site-header` (breadcrumb).
**Migrasyon TAMAM:** tüm sayfalar/primitifler standart shadcn token kullanıyor; legacy compat
köprüsü kaldırıldı (kod tabanında sıfır `ink/surface/accent-soft…`). 20 dosya deterministik
codemod ile taşındı, 5-lensli adversaryel denetimden geçti (kritik + kontrast bulguları
düzeltildi), production build + iki temada WCAG AA tarayıcıda doğrulandı.
**KRİTİK NOT:** `@theme inline`'da her renk token'ı base + `-foreground` çift olmalı
(`--color-muted`+`--color-muted-foreground`, `--color-accent`+`--color-accent-foreground`);
base atlanırsa Tailwind v4 o `bg-*` utility'sini HİÇ üretmez (sessiz kırılma).
**UI TAMAMLANDI (canlı):** Siparişler/Stok/Siteler shadcn-admin **DataTable** (TanStack: arama,
faceted filtre, sıralama, sayfalama, kolon görünürlüğü); sipariş detayı Card/Table/StatTile/timeline;
formlar shadcn Input/Label/Textarea/Button/Alert; loading/error/404 state'leri. Ekranlar 2. adversaryel
audit'ten (a11y/kontrast) geçti. **STOK YÖNETİMİ ÜRÜN-MERKEZLİ HUB'A TAŞINDI (commit 3613262, CANLI):**
kullanıcı "/stock çok karışık, çok üründe yönetilemez" dedi → `/stock` 4 ağır bölümü (liste+import+
oluştur+global eşleme) üst üste yığmaktan **sadeleşti** (yalnız ürün DataTable + "Yeni Ürün" Sheet;
7.23→1.93 kB; STOK kolonuna düşük-stok göstergesi). Ürün-özel işler `/products/[id]` DETAY sayfasında
toplandı (bağlamsal): **Key/Stok İçe Aktar** (ürün SABİT→dropdown yok), **Site Eşlemeleri** (yalnız o
ürünün eşlemeleri), başlıkta **Düzenle**. Backend: `products/:id/detail` eşlemeleri de döndürür
(detailMappings, migration YOK); global "tüm eşlemeler" tablosu kaldırıldı (ürün+site bazına). Bileşenler
parametreleştirildi (import-stock-form `fixedProductId`, mappings-manager `productId`, edit/create Sheet
ayrıştırıldı); batches "stok gir" derin bağlantısı `/products/{id}?batchId=`. typecheck+build temiz, deploy. **ÇOKLU-ADMIN AUTH (§8, 4 faz, canlı, adversaryel-denetimli):**
API `admin_users` (scrypt/role/token_version, migration 0007-0008) + `auth/login|validate` + CRUD;
Next imzalı oturum (HMAC, role+ver, TTL 12s) + middleware her-istek `validate` (revocation) +
`/admins` owner-only RBAC + open-redirect/rate-limit/atomik-lockout korumaları. **env-gated
(SESSION_SECRET + ADMIN_SEED_*), varsayılan KAPALI** (auth kapalıyken UI sarı uyarı bandı) —
aktivasyon + detay: memory `admin-auth`. **Kritik:** login/logout MUTLAKA native form POST → Route
Handler (Server Action + redirect cookie'yi bindiremiyor). Detay: MIMARI.md §17. Marka: "Lisans Paneli".

## Durum

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

## Geliştirme

**Yayın/dağıtım (özet — tam süreç `docs/RUNBOOK-RELEASE.md`):** Panel: kod→dev'de test→`git push`→VPS'te
`./scripts/deploy.sh api admin` (rollback'li). WP eklentisi: `./scripts/release-plugin.sh <sürüm>` veya panel
`/releases`. İzole dev (VPS): `./scripts/dev-stack.sh up`. Yerel WP dev: `pnpm wp:dev`. Geçmiş: `CHANGELOG.md`
+ `docs/DEPLOY-LOG.md`. Kısayollar: `pnpm stack:up|down|logs`, `wp:dev|down|cli`.

`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Yarış testi (gerçek PG ister): `pnpm --filter @lisans/api test:race`. Lokal Node 22
önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.
DB dışa kapalıdır; lokalde host'tan PG/Redis'e erişmek için `docker-compose.override.yml`
(gitignore'da) 127.0.0.1'e port açar — yarış testi bunu kullanır.

`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Yarış testi (gerçek PG ister): `pnpm --filter @lisans/api test:race`. Lokal Node 22
önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.
DB dışa kapalıdır; lokalde host'tan PG/Redis'e erişmek için `docker-compose.override.yml`
(gitignore'da) 127.0.0.1'e port açar — yarış testi bunu kullanır.

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
