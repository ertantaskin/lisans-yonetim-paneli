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
Tasarım (v2.6) tamamlandı. **Faz 0 iskeleti kuruldu** (pnpm+Turborepo monorepo,
NestJS/Fastify API, Next.js admin, Drizzle şema + ilk migration, Docker Compose
PG17+Redis7+Caddy, CI + yarış testi). Build/typecheck/lint/test yeşil. Kalan:
Docker'la lokal doğrulama + VPS deploy. Sıradaki iş: **Faz 1 (MVP)** — atomik atama
akışı, kısmi teslimat motoru, sipariş API'si, WP eklentisi. Yol haritası `docs/MIMARI.md` §18.

## Geliştirme
`pnpm install` · `pnpm build|typecheck|lint|test` · `docker compose up -d --build`
(PG+Redis+API+admin+Caddy). Migration: `pnpm db:generate` (şema→SQL) / `pnpm db:migrate`.
Yarış testi (gerçek PG ister): `pnpm --filter @jetlisans/api test:race`. Lokal Node 22
önerilir (şu an pnpm 9 + Node 20 ile çalışıyor); runtime imajları node:22.
