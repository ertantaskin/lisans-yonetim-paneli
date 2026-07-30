// Tek HMAC imzalı istek — fault-injection testleri için. Node (harici bağımlılık yok).
// env: BASE, API_KEY, SECRET, METHOD, REQ_PATH, BODY (opsiyonel). Çıktı: "STATUS <kod> <kısa gövde>".
const crypto = require('crypto');
const http = require('http');
const { URL } = require('url');

const BASE = process.env.BASE || 'http://api:3001';
const API_KEY = process.env.API_KEY || '';
const SECRET = process.env.SECRET || '';
const METHOD = (process.env.METHOD || 'POST').toUpperCase();
const REQ_PATH = process.env.REQ_PATH || '/v1/orders';
const BODY = process.env.BODY || '';

function canonicalizePath(raw) {
  const h = raw.indexOf('#');
  const nf = h >= 0 ? raw.slice(0, h) : raw;
  const q = nf.indexOf('?');
  if (q < 0) return nf;
  const s = nf.slice(q + 1).split('&').filter((p) => p.length > 0).sort();
  return s.length > 0 ? nf.slice(0, q) + '?' + s.join('&') : nf.slice(0, q);
}

const ts = String(Math.floor(Date.now() / 1000));
const nonce = 'ft-' + Date.now() + '-' + Math.floor(Math.random() * 1e9);
const bodyHash = crypto.createHash('sha256').update(BODY).digest('hex');
const payload = [METHOD, canonicalizePath(REQ_PATH), ts, nonce, bodyHash].join('\n');
const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

const u = new URL(BASE + REQ_PATH);
const headers = {
  'X-Api-Key': API_KEY,
  'X-Timestamp': ts,
  'X-Nonce': nonce,
  'X-Signature': sig,
};
if (BODY) {
  headers['Content-Type'] = 'application/json';
  headers['Content-Length'] = Buffer.byteLength(BODY);
}

const req = http.request(
  { hostname: u.hostname, port: u.port || 80, path: u.pathname + u.search, method: METHOD, headers, timeout: 12000 },
  (res) => {
    let data = '';
    res.on('data', (c) => (data += c));
    res.on('end', () => {
      console.log('STATUS ' + res.statusCode + ' ' + data.slice(0, 160).replace(/\s+/g, ' '));
      process.exit(0);
    });
  },
);
req.on('error', (e) => { console.log('ERROR ' + e.message); process.exit(0); });
req.on('timeout', () => { console.log('TIMEOUT (12s)'); req.destroy(); process.exit(0); });
if (BODY) req.write(BODY);
req.end();
