# Geliştirme Ortamı (Yerel)

Bu belge, paneli **ve** panele bağlı bir **WordPress + WooCommerce test sitesini**
yerelde tek komutla ayağa kaldırmayı anlatır. Amaç: WP eklentisini gerçek bir
WordPress kurulumuna karşı, "normal bir siteye bağlanmış gibi" geliştirmek.

## Hızlı başlangıç

```bash
cp .env.example .env                                          # 1) değerleri doldur (aşağıda "En az gerekenler")
cp docker-compose.override.yml.example docker-compose.override.yml   # 2) yerel portları aç — ATLAMA
pnpm wp:dev                                                   # 3) panel + WordPress + WooCommerce + eklenti
```

> **2. adım neden zorunlu?** Kök `docker-compose.yml` üretim topolojisidir:
> postgres/redis/api/admin/mailpit **host'a hiç port yayınlamaz** (dışarıya tek kapı
> Caddy'nin 80/443'ü). Override dosyası olmadan `localhost:3001`, `localhost:3005` ve
> `localhost:8025` **erişilemez**; `pnpm wp:dev` API sağlığını bekleyip hata vererek durur.
> Şablon her portu `127.0.0.1`e bağlar (LAN'a açılmaz) ve dosyanın kendisi `.gitignore`dadır.

Bittiğinde:

| Ne | Adres | Giriş | Portu açan |
|---|---|---|---|
| WordPress sitesi | http://localhost:8090 | `admin` / `admin12345` (wp-admin) | `docker-compose.wp.yml` (hazır) |
| Panel (admin) | http://localhost:3005 | auth kapalıysa doğrudan açılır | **override** |
| Panel API | http://localhost:3001/v1/health | — | **override** |
| Mailpit (mail kutusu) | http://localhost:8025 | — | **override** |
| PostgreSQL | `localhost:5432` | `.env`deki kimlikler | **override** (testler için) |
| Redis | `localhost:6379` | — | **override** (testler için) |

"override" = 2. adımda kopyaladığın `docker-compose.override.yml`. Yalnız WordPress'in
portu kök yapılandırmadan gelir — bu yüzden override yokken tek çalışan adres 8090'dır.

### En az gerekenler (`.env`)

`pnpm wp:dev` için aşağıdaki blok yeterlidir (yereldir, üretim sırrı DEĞİL — istediğini yaz):

```
POSTGRES_USER=lisanspanel
POSTGRES_PASSWORD=dev
POSTGRES_DB=lisanspanel
DATABASE_URL=postgres://lisanspanel:dev@postgres:5432/lisanspanel
REDIS_URL=redis://redis:6379
MASTER_KEY=<openssl rand -base64 32>
ADMIN_TOKEN=<openssl rand -hex 24>
```

`ADMIN_TOKEN` boşsa panel çalışır ama script siteyi panele **otomatik bağlayamaz**
(WP kurulur, bağlantıyı elle yaparsın). Diğer tüm env'ler opsiyonel (env-gated,
varsayılan kapalı: auth, AI, Sentry, Telegram — bkz. `.env.example`).

## İzole dev/staging (VPS) — alt alan adlarıyla CANLI

Prod'a **hiç dokunmadan** VPS'te ayrı proje (`-p lisansdev`, ayrı DB/ağ/volume) olarak çalışır,
prod Caddy (443/TLS) üzerinden alt alan adlarıyla erişilir:

| Ortam | URL | Giriş |
|---|---|---|
| Dev panel (admin) | https://dev-admin.167-233-108-12.sslip.io | auth kapalı |
| Dev panel API | https://dev-api.167-233-108-12.sslip.io/v1/health | — |
| Dev WordPress | https://dev-wp.167-233-108-12.sslip.io | `admin` / `admin12345` |

Yönetim (VPS'te): `./scripts/dev-stack.sh up|wp|down|status|subdomains`.

> **Not:** Alt alan adları prod Caddy'nin `lisansdev_default` ağına bağlı olmasına dayanır.
> Prod Caddy `deploy.sh` ile yeniden yaratılırsa bu bağ kopar → `./scripts/dev-stack.sh subdomains`
> ile yeniden bağla (dev rotaları 502 verirse sebep budur; prod ETKİLENMEZ).

## Komutlar

| Komut | İş |
|---|---|
| `pnpm stack:up` | Yalnız panel yığını (postgres/redis/api/admin/caddy/mailpit) |
| `pnpm stack:down` | Panel yığınını durdur |
| `pnpm stack:logs` | api + admin loglarını izle |
| `pnpm wp:dev` | **Her şeyi kur/bağla** (idempotent — tekrar çalıştırmak güvenli) |
| `pnpm wp:down` | WordPress yığınını durdur |
| `pnpm wp:cli <...>` | WP-CLI çalıştır (ör. `pnpm wp:cli plugin list`) |

### Testler

| Komut | İş | Gereksinim |
|---|---|---|
| `pnpm typecheck` | Tip denetimi **+ yedi kapı** (use-server · Nest kablolama · env geçirme · iş akışı YAML · tx/havuz · **eklenti sürümü** · **şartname↔kod**) | — |
| `pnpm test` | Birim testleri (shared + api + admin) | — |
| **`pnpm test:iso`** | **Entegrasyon + yarış paketi, izole PostgreSQL/Redis konteynerleriyle** | yalnız `docker` |
| `pnpm test:integration` | Entegrasyon paketi (var olan bir DB'ye karşı) | `DATABASE_URL` + `REDIS_URL` + `MASTER_KEY` |
| `pnpm test:race` | Yarış testi (100 sipariş × 50 stok → çifte atama = 0) | aynı |

**`pnpm test:iso` neden var:** entegrasyon paketi gerçek PostgreSQL + Redis ister ve uzun süre
elle kuruluyordu; elle kurulum üç kez sahte/eksik doğrulama üretti (`db:migrate` unutuldu →
"tablo yok"; `REDIS_URL` verilmedi → yeni testler kapısız kaldı; **bayat `node_modules`** →
paket lockfile'ın istediğinden eski vitest ile koştu). Betik kendi ağını + PG 17 + Redis 7
konteynerlerini kurar, `--frozen-lockfile` ile kurulum yapar, migration'ları uygular, paketi
koşar ve temizler. **Node/pnpm hostta gerekmez** (her şey `node:22` konteynerinde koşar) —
VPS'te node PATH'te olmadığı için bu şart. Prod/dev yığınlarına dokunmaz, port yayınlamaz.
Hata ayıklarken `KEEP=1 pnpm test:iso` konteynerleri bırakır.

## Eklenti geliştirme akışı

`apps/wp-plugin/wpteslimat` klasörü WordPress container'ına **salt-okunur bind-mount**
edilir: host'ta dosyayı düzenle → WP'de **anında** yansır (yeniden kurulum/kopyalama yok).
WordPress kendi eklenti dosyalarını değiştiremez (kaynak tek doğruluk kaynağı).

PHP değişikliğinden sonra çoğu şey anında geçerlidir. Yeni hook/aktivasyon mantığı
eklediysen eklentiyi bir tur kapat/aç:

```bash
pnpm wp:cli plugin deactivate wpteslimat && pnpm wp:cli plugin activate wpteslimat
```

Hata ayıklama logu: WordPress container'ında `wp-content/debug.log` (WP_DEBUG_LOG açık).

## Uçtan uca test (sipariş → teslimat)

1. Panelde (`localhost:3005`) bir **ürün** oluştur, WooCommerce ürün ID'siyle **eşle**,
   biraz **stok** (key) gir.
2. WooCommerce'te (`localhost:8090`) o ürünü içeren bir sipariş oluştur ve
   "processing/completed" durumuna getir → eklenti panele HMAC imzalı push atar.
3. WordPress "Siparişlerim → Görüntüle" ekranında panelden çözülmüş key görünür.
4. Panelde sipariş/atama; mail Mailpit'te (`localhost:8025`).

## Nasıl bağlanıyor? (ağ)

Her iki yığın da aynı Docker ağındadır (`lisans-yonetim-paneli_default`):

- WP eklentisi paneli **`http://api:3001`** olarak görür (`WPTESLIMAT_PANEL_URL` sabiti,
  `docker-compose.wp.yml` içinde).
- Panel webhook'u WP'yi **`http://wordpress/wp-json/wpteslimat/v1/webhook`** olarak görür.
- `api_key` + `hmac_secret`: `pnpm wp:dev` panelde site açıp bu sırları WP'ye
  **sabit** (wp-config) olarak yazar → önerilen güvenli kurulumun (§8) birebir aynısı.

## Sık sorunlar

- **"API 120sn'de hazır olmadı" / `localhost:3005` açılmıyor** — en sık sebep **override
  dosyasının kopyalanmamış olmasıdır**: o zaman API host'a hiç port yayınlamaz, `curl
  localhost:3001` sonsuza kadar başarısız olur ve tekrar denemek ASLA çözmez. Önce
  kontrol et: `docker compose port api 3001` bir adres yazdırmıyorsa
  `cp docker-compose.override.yml.example docker-compose.override.yml` yapıp
  `pnpm wp:dev` komutunu tekrar çalıştır. Override varsa ve konteyner ayaktaysa gerçekten
  ilk derleme sürüyor olabilir — `docker compose logs -f api` ile izle.
- **Panel bağlantısı kurulamadı ("aynı domain zaten kayıtlı")** — daha önce site
  açılmış. Panelden o sitenin secret'ını rotate edip `pnpm wp:cli config set
  WPTESLIMAT_API_KEY '<key>' --type=constant` ile elle yaz (HMAC için de aynısı).
- **Webhook/My Account boş** — kalıcı bağlantılar kapalı olabilir; script açar ama
  gerekirse `pnpm wp:cli rewrite structure '/%postname%/'` + `... rewrite flush`.
