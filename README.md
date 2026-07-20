# Jetlisans — Merkezi Lisans Dağıtım Paneli

Dijital lisans (Windows/Office key, hesaplar, kodlar) satışı için WooCommerce'ten
ayrık, çoklu site destekli merkezi stok/teslimat paneli.

## Bu repoda ne var

- **[docs/MIMARI.md](docs/MIMARI.md)** — tam mimari şartname (v2.6, Markdown)
- **docs/mimari-gorsel.html** — aynı dokümanın görsel/tasarımlı hali (tarayıcıda aç)
- **CLAUDE.md** — Claude Code'un projeyi tanıması için karar özeti

## Hızlı başlangıç (lokal)

```bash
cp .env.example .env          # değerleri doldur (POSTGRES_PASSWORD, MASTER_KEY, ADMIN_TOKEN)
docker compose up -d --build  # PG17 + Redis7 + API + admin + Caddy + Mailpit
```

- Admin paneli: `https://localhost` (Caddy iç TLS — tarayıcı uyarısını geç)
- API sağlık: `https://api.localhost/v1/health`
- Mailpit (yakalanan teslimat mailleri): override ile `http://localhost:8025`

Geliştirme: `pnpm install` · `pnpm build|typecheck|lint|test` ·
`pnpm --filter @jetlisans/api test:race` (yarış testi, gerçek PG ister).

## Durum

**Faz 0 + Faz 1 (MVP) backend/panel tamam ve canlı e2e doğrulandı** (WP eklentisi hariç):
şifreli stok, HMAC imzalı sipariş API'si, atomik atama (çifte satış imkânsız), kısmi
teslimat + tamamlama motoru, BullMQ mail, geri kanal webhook, Next.js admin paneli.
Kalan: **WP eklentisi** (ince istemci), VPS deploy, Faz 2 zenginleştirmeleri.
Yol haritası: [docs/MIMARI.md §18](docs/MIMARI.md). Karar özeti: `CLAUDE.md`.
