# Jetlisans — Playwright e2e duman testleri

Admin panelinin temel akışlarını (yönlendirme, ana ekranların yüklenmesi) uçtan uca
doğrulayan **ayrık** test paketi. §16 "e2e Playwright" kapsamındadır.

Bu klasör pnpm workspace'ine **dahil değildir** (workspace glob'u `apps/*` + `packages/*`).
Kendi `package.json` + `node_modules`'ı vardır, monorepo build'ini etkilemez ve hiçbir
servise **deploy edilmez** — CI/manuel bir artifacttır.

## Çalıştırma

```bash
cd e2e
npm install
npx playwright install chromium          # tarayıcıyı bir kez indir
BASE_URL=https://admin.167-233-108-12.sslip.io npx playwright test
```

`BASE_URL` verilmezse varsayılan olarak canlı VPS paneline gider. Lokal panele karşı
koşmak için: `BASE_URL=http://localhost:3000 npx playwright test`.

## Kimlik doğrulama (auth) açıksa

Panelde auth **env-gated**tir (`SESSION_SECRET` ayarlıysa açık). Auth açıkken korumalı
rotalar `/login`'e yönlenir. Testler bunu graceful ele alır:

- **Kimlik bilgisi verilmezse** testler otomatik **SKIP** edilir (kırılgan başarısızlık yok).
- **Kimlik bilgisi verilirse** giriş yapılıp akışa devam edilir:

```bash
E2E_USER='admin@ornek.com' E2E_PASS='parola' \
  BASE_URL=https://admin.167-233-108-12.sslip.io npx playwright test
```

Auth kapalıyken (`SESSION_SECRET` yok) `E2E_USER`/`E2E_PASS` gerekmez; testler doğrudan koşar.

## Kapsam (`tests/smoke.spec.ts`)

- Kök yol `/` → `/pending` yönlendirir.
- `/orders` yüklenir, "Siparişler" başlığı görünür.
- `/pending` yüklenir, uygulama kabuğu (sidebar) render olur.
