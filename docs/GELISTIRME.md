# Geliştirme Ortamı (Yerel)

Bu belge, paneli **ve** panele bağlı bir **WordPress + WooCommerce test sitesini**
yerelde tek komutla ayağa kaldırmayı anlatır. Amaç: WP eklentisini gerçek bir
WordPress kurulumuna karşı, "normal bir siteye bağlanmış gibi" geliştirmek.

## Hızlı başlangıç

```bash
cp .env.example .env    # ilk sefer: değerleri doldur (aşağıda "En az gerekenler")
pnpm wp:dev             # panel + WordPress + WooCommerce + eklenti — tek komut
```

Bittiğinde:

| Ne | Adres | Giriş |
|---|---|---|
| WordPress sitesi | http://localhost:8090 | `admin` / `admin12345` (wp-admin) |
| Panel (admin) | http://localhost:3005 | auth kapalıysa doğrudan açılır |
| Panel API | http://localhost:3001/v1/health | — |
| Mailpit (mail kutusu) | http://localhost:8025 | — |

### En az gerekenler (`.env`)

`pnpm wp:dev` için şu üç değer yeterli (yereldir, üretim sırrı DEĞİL — istediğini yaz):

```
POSTGRES_USER=jetlisans
POSTGRES_PASSWORD=dev
POSTGRES_DB=jetlisans
DATABASE_URL=postgres://jetlisans:dev@postgres:5432/jetlisans
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

## Eklenti geliştirme akışı

`apps/wp-plugin/jetlisans` klasörü WordPress container'ına **salt-okunur bind-mount**
edilir: host'ta dosyayı düzenle → WP'de **anında** yansır (yeniden kurulum/kopyalama yok).
WordPress kendi eklenti dosyalarını değiştiremez (kaynak tek doğruluk kaynağı).

PHP değişikliğinden sonra çoğu şey anında geçerlidir. Yeni hook/aktivasyon mantığı
eklediysen eklentiyi bir tur kapat/aç:

```bash
pnpm wp:cli plugin deactivate jetlisans && pnpm wp:cli plugin activate jetlisans
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

- WP eklentisi paneli **`http://api:3001`** olarak görür (`JETLISANS_PANEL_URL` sabiti,
  `docker-compose.wp.yml` içinde).
- Panel webhook'u WP'yi **`http://wordpress/wp-json/jetlisans/v1/webhook`** olarak görür.
- `api_key` + `hmac_secret`: `pnpm wp:dev` panelde site açıp bu sırları WP'ye
  **sabit** (wp-config) olarak yazar → önerilen güvenli kurulumun (§8) birebir aynısı.

## Sık sorunlar

- **"API 120sn'de hazır olmadı"** — ilk çalıştırmada api/admin imajları derlenir;
  `docker compose logs api` ile ilerlemeyi izle, sonra `pnpm wp:dev` tekrar çalıştır.
- **Panel bağlantısı kurulamadı ("aynı domain zaten kayıtlı")** — daha önce site
  açılmış. Panelden o sitenin secret'ını rotate edip `pnpm wp:cli config set
  JETLISANS_API_KEY '<key>' --type=constant` ile elle yaz (HMAC için de aynısı).
- **Webhook/My Account boş** — kalıcı bağlantılar kapalı olabilir; script açar ama
  gerekirse `pnpm wp:cli rewrite structure '/%postname%/'` + `... rewrite flush`.
