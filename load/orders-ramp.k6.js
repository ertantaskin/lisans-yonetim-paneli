// Kontrollü YAZMA yükü — kademeli eşzamanlılık + istek timeout'u (wedge olmadan eğri).
// Havuz max:10 olduğundan constant-100VU sırayı şişirir; bu test 10→25→50 VU kademesiyle
// sürdürülebilir throughput (sipariş/sn) ve p95'in hangi eşzamanlılıkta bozulduğunu ölçer.
import http from 'k6/http';
import crypto from 'k6/crypto';
import exec from 'k6/execution';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_TOKEN = __ENV.ADMIN_TOKEN || '';
const STOCK = Number(__ENV.STOCK || 2000);
const REMOTE_PRODUCT_ID = 'ramp-remote-key';
const RUN_ID = `${Date.now()}`;
const REQ_TIMEOUT = __ENV.REQ_TIMEOUT || '8s';

const f201 = new Counter('orders_fulfilled');
const p202 = new Counter('orders_pending');
const err = new Counter('orders_rejected');

export const options = {
  scenarios: {
    w: {
      executor: 'ramping-vus',
      startVUs: 5,
      stages: [
        { duration: '10s', target: 10 },
        { duration: '10s', target: 25 },
        { duration: '15s', target: 50 },
        { duration: '5s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<300', 'p(99)<1000'],
    orders_fulfilled: [`count<=${STOCK}`],
    checks: ['rate>0.98'],
  },
};

function canonicalizePath(rawPath) {
  const h = rawPath.indexOf('#');
  const nf = h >= 0 ? rawPath.slice(0, h) : rawPath;
  const q = nf.indexOf('?');
  if (q < 0) return nf;
  const s = nf.slice(q + 1).split('&').filter((p) => p.length > 0).sort();
  return s.length > 0 ? `${nf.slice(0, q)}?${s.join('&')}` : nf.slice(0, q);
}
let nc = 0;
function nonce() {
  return `k6w-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Date.now()}-${nc++}`;
}
function hmac(method, path, bodyStr, apiKey, secret) {
  const ts = String(Math.floor(Date.now() / 1000));
  const n = nonce();
  const bh = crypto.sha256(bodyStr, 'hex');
  const payload = [method.toUpperCase(), canonicalizePath(path), ts, n, bh].join('\n');
  return {
    'Content-Type': 'application/json',
    'X-Api-Key': apiKey,
    'X-Timestamp': ts,
    'X-Nonce': n,
    'X-Signature': crypto.hmac('sha256', secret, payload, 'hex'),
  };
}
function adminPost(path, body, label) {
  const res = http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': ADMIN_TOKEN },
  });
  if (res.status < 200 || res.status >= 300) throw new Error(`[${label}] ${res.status}: ${res.body}`);
  return res.json();
}

export function setup() {
  if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN zorunlu.');
  const site = adminPost('/v1/admin/sites', { domain: `ramp-${RUN_ID}.example.test`, type: 'woocommerce' }, 'site');
  const product = adminPost('/v1/admin/products', { sku: `ramp-${RUN_ID}`, name: 'Ramp', kind: 'key', usageMode: 'single' }, 'ürün');
  const items = [];
  for (let i = 0; i < STOCK; i++) items.push({ payload: `RAMPKEY-${RUN_ID}-${i}` });
  adminPost('/v1/admin/stock/import', { productId: product.id, items }, 'stok');
  adminPost('/v1/admin/mappings', { siteId: site.id, productId: product.id, remoteProductId: REMOTE_PRODUCT_ID }, 'eşleme');
  console.log(`Kurulum: stok=${STOCK}`);
  return { apiKey: site.apiKey, hmacSecret: site.hmacSecret };
}

export default function (data) {
  const path = '/v1/orders';
  const rid = `ramp-${RUN_ID}-${exec.scenario.iterationInTest}-vu${exec.vu.idInTest}`;
  const body = {
    remoteOrderId: rid,
    customerEmail: `b+${exec.vu.idInTest}@ramp.test`,
    lines: [{ remoteLineId: 'l1', remoteProductId: REMOTE_PRODUCT_ID, qty: 1 }],
  };
  const bodyStr = JSON.stringify(body);
  const res = http.post(`${BASE_URL}${path}`, bodyStr, {
    headers: hmac('POST', path, bodyStr, data.apiKey, data.hmacSecret),
    timeout: REQ_TIMEOUT,
  });
  if (res.status === 201) f201.add(1);
  else if (res.status === 202) p202.add(1);
  else err.add(1);
  check(res, { '201/202': (r) => r.status === 201 || r.status === 202 });
}
