# Jetlisans — Merkezi Lisans Dağıtım Paneli

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

## Görsel kimlik (kesinleşti — satnaing/shadcn-admin nötr dili; Base UI + 2026 indigo BIRAKILDI)

Referans: **satnaing/shadcn-admin** (shadcn-admin.netlify.app) birebir. Stack: klasik
**shadcn/ui deseni + Radix UI** (Base UI değil) + Tailwind v4 (CSS-first, `tailwind.config.js`
YOK — token'lar `@theme`/`@theme inline` içinde) + TanStack Table + Recharts + lucide +
cmdk + sonner + next-themes; hepsi ücretsiz/MIT. Framework: **Next.js 15 (sunucu-taraflı)**
korunur (şablon Vite olsa da güvenlik gereği). Palet: **standart shadcn nötr oklch** —
`--background/--foreground/--card/--primary/--secondary/--muted/--accent/--border/--ring`
+ `--sidebar-*` + `--chart-1..6`; nötr primary (açıkta koyu, koyuda açık), renk YOK
(monokrom). Semantik uzantı (durum dili, renkli tutulur): `--success` (emerald),
`--warning` (amber), `--destructive` (rose) — açık temada AA (≥4.5:1) sağlayacak koyulukta,
koyu temada daha açık. Tema: `.dark` class (next-themes `attribute=class`). **Tek kaynak:**
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
audit'ten (a11y/kontrast) geçti. **ÇOKLU-ADMIN AUTH (§8, 4 faz, canlı, adversaryel-denetimli):**
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
- **WP eklentisi** (`apps/wp-plugin/jetlisans`, ince istemci): HMAC istemci, sipariş push
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

migration 0000-0010. Kalan (bilinçli/ertelenen): §15 AI operasyon (Faz 4), site-bağlama 15dk sihirbazı,
k6/Playwright yük-e2e (CI), private update endpoint. Yol haritası §18.

## Geliştirme

`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Yarış testi (gerçek PG ister): `pnpm --filter @jetlisans/api test:race`. Lokal Node 22
önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.
DB dışa kapalıdır; lokalde host'tan PG/Redis'e erişmek için `docker-compose.override.yml`
(gitignore'da) 127.0.0.1'e port açar — yarış testi bunu kullanır.
