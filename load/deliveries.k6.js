// Lisans Yönetim Paneli — /v1/orders/:id/deliveries OKUMA yükü testi (k6).
//
// Amaç: "Hesabım → Siparişlerim → Ürün görüntüle" ekranının panele attığı GET'i,
// yani müşterinin lisansını GÖRÜNTÜLEME yolunu, artan eşzamanlılık altında ölçmek.
// (orders.k6.js YAZMA yolunu — sipariş push — ölçer; bu dosya OKUMA yolunu ölçer.)
//
// NOT (dürüstlük): bu test yalnız PANEL okuma ucunu ölçer; gerçek "10.000 kişi aynı
// anda sipariş sayfasını açtı" senaryosunda WordPress'in kendi sayfa render'ı + FPM
// işçi havuzu ayrı (ve genelde daha ağır) bir sınırdır. Buradaki sayı, paylaşılan
// darboğaz olan panel/Postgres okuma ucunun throughput + p95 eğrisidir.
//
// Çalıştırma (izole test/dev ortamında):
//   BASE_URL=http://127.0.0.1:3002 ADMIN_TOKEN=... k6 run load/deliveries.k6.js
//
// setup()   : site + ürün + stok + eşleme kurar, TEK sipariş push eder → panel orderId'si
//             (bu siparişin çözülmüş teslimatı olur; default() onu tekrar tekrar okur).
// default() : HMAC imzalı GET /v1/orders/:orderId/deliveries (payload'lı okuma).

import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const REMOTE_PRODUCT_ID = 'read-remote-key';
const RUN_ID = `${Date.now()}`;

const readOk = new Counter('deliveries_ok'); // 200 + teslimat döndü
const readEmpty = new Counter('deliveries_empty'); // 200 ama teslimat yok (beklenmez)
const readErr = new Counter('deliveries_error'); // 4xx/5xx/0

// Artan eşzamanlılık: 50 → 150 → 300 → 500 VU basamakları (eğriyi görmek için).
// constant-vus yerine ramping: latency'nin hangi eşzamanlılıkta bozulduğu görünür.
export const options = {
  setupTimeout: '120s',
  scenarios: {
    read: {
      executor: 'ramping-vus',
      startVUs: 10,
      stages: [
        { duration: '10s', target: 50 },
        { duration: '10s', target: 150 },
        { duration: '15s', target: 300 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<800'],
    checks: ['rate>0.99'],
  },
};

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

let nonceCounter = 0;
function makeNonce() {
  return `k6r-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Date.now()}-${nonceCounter++}`;
}

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

function adminHeaders() {
  return { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN };
}

function adminPost(path, body, label) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), { headers: adminHeaders() });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Kurulum başarısız [${label}] ${res.status}: ${res.body}`);
  }
  return res.json();
}

export function setup() {
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN env değişkeni zorunlu.');

  const site = adminPost(
    '/v1/admin/sites',
    { domain: `read-${RUN_ID}.example.test`, type: 'woocommerce' },
    'site oluştur',
  );
  const product = adminPost(
    '/v1/admin/products',
    { sku: `read-key-${RUN_ID}`, name: 'Okuma Testi Anahtarı', kind: 'key', usageMode: 'single' },
    'ürün oluştur',
  );
  adminPost(
    '/v1/admin/stock/import',
    { productId: product.id, items: [{ payload: `READKEY-${RUN_ID}-0` }] },
    'stok import',
  );
  adminPost(
    '/v1/admin/mappings',
    { siteId: site.id, productId: product.id, remoteProductId: REMOTE_PRODUCT_ID },
    'eşleme oluştur',
  );

  // TEK sipariş push → çözülmüş teslimatı olan bir panel orderId üret (HMAC imzalı).
  const path = '/v1/orders';
  const body = {
    remoteOrderId: `read-order-${RUN_ID}`,
    customerEmail: `buyer@read.example.test`,
    lines: [{ remoteLineId: 'l1', remoteProductId: REMOTE_PRODUCT_ID, qty: 1 }],
  };
  const bodyStr = JSON.stringify(body);
  const res = http.post(`${BASE_URL}${path}`, bodyStr, {
    headers: hmacHeaders('POST', path, bodyStr, site.apiKey, site.hmacSecret),
  });
  if (res.status !== 201) {
    throw new Error(`Sipariş push beklenen 201, gelen ${res.status}: ${res.body}`);
  }
  const orderId = res.json().orderId;
  if (!orderId) throw new Error('Panel orderId dönmedi — teslimat okunamaz.');

  console.log(`Kurulum tamam: orderId=${orderId} — okuma yükü başlıyor.`);
  return { apiKey: site.apiKey, hmacSecret: site.hmacSecret, orderId };
}

export default function (data) {
  const path = `/v1/orders/${data.orderId}/deliveries`;
  const headers = hmacHeaders('GET', path, '', data.apiKey, data.hmacSecret);
  const res = http.get(`${BASE_URL}${path}`, { headers, timeout: '8s' });

  let hasDeliveries = false;
  if (res.status === 200) {
    try {
      const b = res.json();
      hasDeliveries = Array.isArray(b.deliveries) && b.deliveries.length > 0;
    } catch (_e) {
      hasDeliveries = false;
    }
    if (hasDeliveries) readOk.add(1);
    else readEmpty.add(1);
  } else {
    readErr.add(1);
  }

  check(res, {
    'durum 200': (r) => r.status === 200,
    'teslimat döndü': () => hasDeliveries,
  });
}

export function teardown(_data) {
  console.log(`Okuma testi bitti (RUN_ID=${RUN_ID}) — test verisi izole DB'de kaldı.`);
}
