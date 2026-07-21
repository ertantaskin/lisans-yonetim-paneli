// Jetlisans — /v1/orders yük testi (k6). MIMARI.md §16.
//
// Amaç (iki hedef birden):
//   1) Performans: sipariş push'unun p95 gecikmesi < 300ms.
//   2) Doğruluk: 100 eş zamanlı sipariş × 50 stok altında ÇİFTE ATAMA = 0.
//      (Her başarılı (201) sipariş TAM 1 birim tüketir; SKIP LOCKED sayesinde
//       50 stoktan en fazla 50 sipariş karşılanabilir. Çifte atama olsaydı
//       "başarılı sipariş sayısı > stok" olurdu → `orders_fulfilled` eşiği
//       (count <= STOCK) bunu yakalar. Kalanlar 202 pending_stock döner.)
//
// Bu bir CI/manuel ARTIFACT'tır — panele DEPLOY EDİLMEZ, workspace'e girmez.
// Çalıştırma: bkz. load/README.md
//   BASE_URL=... ADMIN_TOKEN=... k6 run load/orders.k6.js
//
// setup()    : admin API ile test sitesi + ürün + 50 stok + site⇄ürün eşlemesi kurar.
// default()  : 100 VU, her iterasyonda BENZERSIZ sipariş → HMAC imzalı POST /v1/orders.
// teardown() : özet + temizlik notu (silme ucu yok — test verisi elle temizlenir).

import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// ── Yapılandırma (env ile ezilebilir) ───────────────────────────────────────
const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const STOCK = Number(__ENV.STOCK || 50); // import edilecek stok adedi
const VUS = Number(__ENV.VUS || 100); // eş zamanlı sanal kullanıcı
const DURATION = __ENV.DURATION || '20s'; // yük süresi (kısa)

// Sipariş satırlarının hedeflediği uzak ürün kimliği (mapping ile eşleşmeli).
const REMOTE_PRODUCT_ID = 'load-remote-key';
// Bu koşuya özgü ek — sku/domain/payload çakışmasını önler (tekrar çalıştırılabilir).
const RUN_ID = `${Date.now()}`;

// ── Özel metrikler ───────────────────────────────────────────────────────────
const ordersFulfilled = new Counter('orders_fulfilled'); // 201 tam teslim
const ordersPartial = new Counter('orders_partial'); // 207 kısmi
const ordersPending = new Counter('orders_pending'); // 202 stok yok
const ordersRejected = new Counter('orders_rejected'); // beklenmeyen (4xx/5xx)

export const options = {
  scenarios: {
    orders: {
      executor: 'constant-vus',
      vus: VUS,
      duration: DURATION,
    },
  },
  thresholds: {
    // §16 performans hedefi.
    http_req_duration: ['p(95)<300'],
    // ÇİFTE ATAMA=0 invaryantı: tam-teslim sayısı stok adedini AŞAMAZ.
    orders_fulfilled: [`count<=${STOCK}`],
    // check'lerin ezici çoğunluğu geçmeli.
    checks: ['rate>0.99'],
  },
};

// ── İmza yardımcıları ────────────────────────────────────────────────────────

/**
 * İmza yolu kanonikleştirme — panel `canonicalizePath` (shared/api/hmac.ts) +
 * WP `canonical_path` (class-panel-client.php) ile BİREBİR aynı olmalı.
 * Fragment atılır; query param'lar string sıralanır.
 */
function canonicalizePath(rawPath) {
  const hashIdx = rawPath.indexOf('#');
  const noFrag = hashIdx >= 0 ? rawPath.slice(0, hashIdx) : rawPath;
  const qIdx = noFrag.indexOf('?');
  if (qIdx < 0) return noFrag;
  const pathname = noFrag.slice(0, qIdx);
  const sorted = noFrag
    .slice(qIdx + 1)
    .split('&')
    .filter((p) => p.length > 0)
    .sort();
  return sorted.length > 0 ? `${pathname}?${sorted.join('&')}` : pathname;
}

/** Replay penceresinde tekil nonce — VU/iter/zaman/sayaç bileşimi (harici bağımlılık yok). */
let nonceCounter = 0;
function makeNonce() {
  return `k6-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Date.now()}-${nonceCounter++}`;
}

/**
 * HMAC imzalı başlıklar (§4):
 *   X-Signature = HMAC-SHA256(secret, METHOD\nCANONICAL_PATH\nTS\nNONCE\nSHA256(body))
 * `path` /v1 önekini İÇERİR (guard req.url üzerinden imzalar).
 */
function hmacHeaders(method, path, bodyStr, apiKey, secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = makeNonce();
  const bodyHash = crypto.sha256(bodyStr, 'hex');
  const payload = [method.toUpperCase(), canonicalizePath(path), ts, nonce, bodyHash].join('\n');
  const signature = crypto.hmac('sha256', secret, payload, 'hex');
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Timestamp': ts,
    'X-Nonce': nonce,
    'X-Signature': signature,
  };
}

/** Admin uçları için X-Admin-Token başlıkları (HMAC değil). */
function adminHeaders() {
  return { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN };
}

/** Admin POST — hata durumunda kurulumu anlaşılır mesajla durdurur. */
function adminPost(path, body, label) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers: adminHeaders() });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Kurulum başarısız [${label}] ${res.status}: ${res.body}`);
  }
  return res.json();
}

// ── setup: test tenant + ürün + stok + eşleme ────────────────────────────────
export function setup() {
  if (!ADMIN_TOKEN) {
    throw new Error('ADMIN_TOKEN env değişkeni zorunlu (admin uçları X-Admin-Token ister).');
  }

  // 1) Test sitesi — apiKey + hmacSecret YALNIZ burada bir kez döner.
  const site = adminPost(
    '/v1/admin/sites',
    { domain: `load-${RUN_ID}.example.test`, type: 'woocommerce' },
    'site oluştur',
  );

  // 2) Ürün — tek kullanımlık key, partial-auto (varsayılan).
  const product = adminPost(
    '/v1/admin/products',
    { sku: `load-key-${RUN_ID}`, name: 'Yük Testi Anahtarı', kind: 'key', usageMode: 'single' },
    'ürün oluştur',
  );

  // 3) 50 stok import — payload'lar koşuya özgü (dedupe/çakışma yok).
  const items = [];
  for (let i = 0; i < STOCK; i++) items.push({ payload: `LOADKEY-${RUN_ID}-${i}` });
  const imported = adminPost(
    '/v1/admin/stock/import',
    { productId: product.id, items },
    'stok import',
  );
  if (Number(imported.imported) !== STOCK) {
    throw new Error(
      `Stok import beklenen ${STOCK}, gelen ${imported.imported} (rejected=${imported.rejected}).`,
    );
  }

  // 4) Site ⇄ ürün eşlemesi — sipariş satırı REMOTE_PRODUCT_ID ile buraya çözülür.
  adminPost(
    '/v1/admin/mappings',
    { siteId: site.id, productId: product.id, remoteProductId: REMOTE_PRODUCT_ID },
    'eşleme oluştur',
  );

  console.log(
    `Kurulum tamam: site=${site.id} ürün=${product.id} stok=${STOCK} — ${VUS} VU / ${DURATION}.`,
  );
  return { apiKey: site.apiKey, hmacSecret: site.hmacSecret };
}

// ── default: benzersiz siparişleri imzalı olarak push et ─────────────────────
export default function (data) {
  const path = '/v1/orders';
  // BENZERSIZ remoteOrderId — test genelinde tekil (idempotency dedup'a takılmaz).
  const remoteOrderId = `load-${RUN_ID}-${exec.scenario.iterationInTest}-vu${exec.vu.idInTest}`;
  const body = {
    remoteOrderId,
    customerEmail: `buyer+${exec.vu.idInTest}@load.example.test`,
    lines: [{ remoteLineId: 'l1', remoteProductId: REMOTE_PRODUCT_ID, qty: 1 }],
  };
  const bodyStr = JSON.stringify(body); // hash edilen ile GÖNDERİLEN birebir aynı olmalı
  const headers = hmacHeaders('POST', path, bodyStr, data.apiKey, data.hmacSecret);

  const res = http.post(`${BASE_URL}${path}`, bodyStr, { headers });

  // Durum sınıflandırması (§4): 201 tam / 207 kısmi / 202 stok yok.
  if (res.status === 201) ordersFulfilled.add(1);
  else if (res.status === 207) ordersPartial.add(1);
  else if (res.status === 202) ordersPending.add(1);
  else ordersRejected.add(1);

  check(res, {
    'durum 201/207/202': (r) => r.status === 201 || r.status === 207 || r.status === 202,
    'gövde tutarlı (assignments)': (r) => {
      if (r.status === 202) return true; // pending_stock: atama yok, beklenen
      try {
        const b = r.json();
        return Array.isArray(b.assignments) && b.assignments.length > 0;
      } catch (_e) {
        return false;
      }
    },
  });
}

// ── teardown: özet + temizlik notu ───────────────────────────────────────────
export function teardown(_data) {
  // Silme ucu (DELETE) yok — test verisi kalır. Elle temizlik:
  //   - site.domain  = load-<RUN_ID>.example.test
  //   - product.sku  = load-key-<RUN_ID>
  //   - stok payload = LOADKEY-<RUN_ID>-*
  // Yük testleri izole/tek-kullanımlık bir ortamda (staging/test DB) çalıştırılmalı;
  // metrik özeti + eşik sonuçları (p95, orders_fulfilled<=STOCK) test sonu raporundadır.
  console.log(`Test verisi (RUN_ID=${RUN_ID}) kaldı — izole test DB'sinde elle temizleyin.`);
}
