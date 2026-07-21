# Yük testi — k6 (`load/`)

`POST /v1/orders` sipariş push'unun **performans** ve **doğruluk** yük testi (MIMARI.md §16).
Bu klasör **standalone bir CI/manuel artifact'tır** — pnpm workspace'e girmez, panele
**deploy edilmez**. Sadece k6 gerektirir.

## Neyi doğrular

1. **Performans:** sipariş push'unun `http_req_duration` **p95 < 300ms** (§16 hedefi).
2. **Çifte atama = 0:** 100 eş zamanlı sipariş × 50 stok altında hiçbir lisans iki kez
   atanmaz. Her başarılı (`201`) sipariş **tam 1 birim** tüketir; `FOR UPDATE SKIP LOCKED`
   sayesinde 50 stoktan **en fazla 50** sipariş karşılanabilir. Çifte atama olsaydı
   "başarılı sipariş sayısı > stok" olurdu — bu yüzden betik `orders_fulfilled` sayacına
   `count <= STOCK` eşiği koyar. Kalan siparişler `202 pending_stock` döner (beklenen).

## Kurulum (k6)

k6 ayrı bir yürütücüdür (Node değil). Kurulum: <https://k6.io/docs/get-started/installation/>

- Windows: `winget install k6` veya `choco install k6`
- macOS: `brew install k6`
- Linux / Docker: bkz. resmi doküman

## Çalıştırma

Admin uçları (site/ürün/stok kurulumu) `X-Admin-Token` ister; sipariş push'u HMAC imzalıdır
(betik imzayı `crypto.hmac` ile üretir). Sadece iki env zorunlu:

```bash
BASE_URL=http://localhost:3000 \
ADMIN_TOKEN=<panel ADMIN_TOKEN> \
k6 run load/orders.k6.js
```

PowerShell (Windows):

```powershell
$env:BASE_URL="http://localhost:3000"; $env:ADMIN_TOKEN="<ADMIN_TOKEN>"; k6 run load/orders.k6.js
```

### Ayarlanabilir env

| Env          | Varsayılan              | Açıklama                                  |
| ------------ | ----------------------- | ----------------------------------------- |
| `BASE_URL`   | `http://localhost:3000` | Panel API kökü (`/v1` öneki betikte eklenir) |
| `ADMIN_TOKEN`| _(zorunlu)_             | Admin token (`X-Admin-Token`)             |
| `STOCK`      | `50`                    | Import edilen stok adedi (= tam-teslim üst sınırı) |
| `VUS`        | `100`                   | Eş zamanlı sanal kullanıcı (sipariş)      |
| `DURATION`   | `20s`                   | Yük süresi                                |

## Akış

- **setup()** — admin API ile: test sitesi oluşturur (`apiKey`+`hmacSecret` yanıttan alınır),
  ürün oluşturur, `STOCK` adet stok import eder, site⇄ürün eşlemesi kurar.
- **default()** — `VUS` sanal kullanıcı; her iterasyonda **benzersiz** `remoteOrderId` ile
  HMAC imzalı `POST /v1/orders`. `check()`: durum `201/207/202` + gövde tutarlılığı.
- **teardown()** — özet + temizlik notu.

## Beklenen sonuç

- `http_req_duration ... p(95)<300` ✓ (§16)
- `orders_fulfilled ... count<=50` ✓ (çifte atama yok)
- `checks ... rate>0.99` ✓
- Özette: `orders_fulfilled` ≈ 50, gerisi `orders_pending` (202). Herhangi bir eşik
  kırmızıysa (`✗`) k6 çıkış kodu ≠ 0 → CI adımı fail eder.

## Temizlik / güvenlik

- Panelde silme ucu yoktur; test verisi (`site.domain=load-<ts>.example.test`,
  `product.sku=load-key-<ts>`, `LOADKEY-<ts>-*`) **kalır**.
- Bu nedenle yük testini **izole bir staging/test veritabanında** çalıştırın — üretimde değil.
- Her koşu zaman damgalı `RUN_ID` kullanır → tekrar tekrar çalıştırılabilir (çakışma yok).
