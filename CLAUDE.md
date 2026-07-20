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

## Görsel kimlik (kesinleşti — Stripe tarzı)

Accent indigo `#635BFF` (koyu: `#8A84FF`), soft `#F0EFFF`/`#232057`, metin
laciverti `#0A2540` (saf siyah yok), zemin `#F6F9FC` (koyu: `#0C1526`). İndigo
yalnızca etkileşim; durum renkleri sabit: yeşil=bitti, amber=aksiyon, kırmızı=sorun.

## Durum

Tasarım (v2.6) + **Faz 0 + Faz 1 (panel) + WP eklentisi CANLI ve uçtan uca e2e doğrulandı.**
`docker compose up` ile 6 servis (PG17+Redis7+API+admin+Caddy+Mailpit) ayakta. WP test ortamı:
`docker-compose.wp.yml` (WordPress+WooCommerce+MySQL). **Tam zincir kanıtlandı:** Woo sipariş →
HMAC push → panel atomik atama → My Account'ta çözülmüş key → geri kanal webhook (HMAC doğrulandı).

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

Kalan: **VPS deploy** (gerçek domain + Let's Encrypt + yedek), Faz 2 zenginleştirmeleri
(hesap ürünleri, tedarik zinciri, self-servis, WP eklentisi yönetim aksiyonları). Yol haritası §18.

## Geliştirme

`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Yarış testi (gerçek PG ister): `pnpm --filter @jetlisans/api test:race`. Lokal Node 22
önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.
DB dışa kapalıdır; lokalde host'tan PG/Redis'e erişmek için `docker-compose.override.yml`
(gitignore'da) 127.0.0.1'e port açar — yarış testi bunu kullanır.
