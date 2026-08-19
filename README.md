# Lisans Yönetim Paneli — Merkezi Lisans Dağıtım Paneli

Dijital lisans (Windows/Office key, hesaplar, kodlar) satışı için WooCommerce'ten
ayrık, çoklu site destekli merkezi stok/teslimat paneli.

## Bu repoda ne var

- **[docs/MIMARI.md](docs/MIMARI.md)** — tam mimari şartname (v2.7). **Tek yetkili tanım**;
  veri modeli + rota haritası + API tablosu `pnpm check:docs` ile kod tarafından denetlenir.
- **docs/mimari-gorsel.html** — aynı belgenin **üretilmiş** görsel kopyası (tarayıcıda aç).
  `pnpm docs:gorsel` üretir, `pnpm check:docs` tazeliğini denetler — **elle düzenlenmez**.
- **CLAUDE.md** — karar özeti + değişmez kurallar + **tekrarlayan tuzaklar** (kısa tutulur;
  her oturumda okunur)
- **[docs/GECMIS.md](docs/GECMIS.md)** — tur-tur çalışma günlüğü (hangi şikâyet, kök neden,
  ölçüm, düzeltme, doğrulama). CLAUDE.md'deki tuzak maddelerinin ardındaki vakalar burada.
- **[docs/GELISTIRME.md](docs/GELISTIRME.md)** — yerel geliştirme + WordPress test ortamı + testler
- **[CHANGELOG.md](CHANGELOG.md)** · **[docs/DEPLOY-LOG.md](docs/DEPLOY-LOG.md)** — sürüm ve dağıtım geçmişi
- **[docs/RUNBOOK-RELEASE.md](docs/RUNBOOK-RELEASE.md)** · **[docs/RUNBOOK-DR.md](docs/RUNBOOK-DR.md)** — yayın ve felaket kurtarma

## Hızlı başlangıç (lokal)

```bash
cp .env.example .env          # değerleri doldur (POSTGRES_PASSWORD, MASTER_KEY, ADMIN_TOKEN)
docker compose up -d --build  # PG17 + Redis7 + API + admin + Caddy + Mailpit
```

- Admin paneli: `https://localhost` (Caddy iç TLS — tarayıcı uyarısını geç)
- API sağlık: `https://api.localhost/v1/health`
- Mailpit (yakalanan teslimat mailleri): override ile `http://localhost:8025`

## Geliştirme & doğrulama

```bash
pnpm install
pnpm typecheck      # tip + ALTI kapı (use-server · DI · env · workflow · tx/havuz · şartname↔kod)
pnpm test           # birim (shared + api + admin)
pnpm test:iso       # entegrasyon + yarış — izole PostgreSQL/Redis konteynerleriyle (yalnız docker)
pnpm build
```

Yerel WordPress test sitesiyle uçtan uca geliştirme: **[docs/GELISTIRME.md](docs/GELISTIRME.md)**
(`pnpm wp:dev`). Yayın ve dağıtım: **[docs/RUNBOOK-RELEASE.md](docs/RUNBOOK-RELEASE.md)**.
Yedek / felaket kurtarma: **[docs/RUNBOOK-DR.md](docs/RUNBOOK-DR.md)**.

## Durum

**Tasarım + Faz 0/1/2 TAMAM; panel ve WP eklentisi canlı** (VPS + Docker Compose + Caddy TLS).
Kodlanabilir mimari eksik yok; kalanlar yalnız yapısal kapsam-dışı maddelerdir (fiyat senkronu /
marketplace adaptörü / abonelik — gerekçeleri `docs/MIMARI.md` sonundaki "Bilinçli kapsam DIŞI").

> **Ayrıntılı durum burada TEKRARLANMAZ** — bir dönem README kendi "Durum" listesini tutuyordu ve
> aylarca "Faz 1 MVP" demeye devam etti. Güncel özet: **`CLAUDE.md` → Durum**; sürüm bazlı geçmiş:
> `CHANGELOG.md`; tur-tur günlük: `docs/GECMIS.md`.

Yol haritası: [docs/MIMARI.md §18](docs/MIMARI.md).
