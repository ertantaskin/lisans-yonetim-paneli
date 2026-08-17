#!/usr/bin/env node
/**
 * BELGE ↔ KOD SAPMA KAPISI.
 *
 * NEDEN VAR (ölçüldü, tahmin değil): `docs/MIMARI.md` projenin şartnamesi ve CLAUDE.md "HER
 * önemli kararda önce bu dokümana bak" diyor. Ölçüldüğünde:
 *   · şemadaki **32 tablonun 15'i** belgede HİÇ geçmiyordu (supplier_claims, product_guides,
 *     product_categories, admin_users, deployments, notifications, security_events, customers,
 *     saved_views, site_remote_products, stock_adjustments, plugin_releases, …),
 *   · belge **4 UYDURMA tablo** anlatıyordu (`stock_batches`, `customer_tags`, `panel_users`,
 *     `blocklist`) — hiçbiri hiç var olmadı; şartnameye güvenip kod yazan biri var olmayan bir
 *     tabloya yazardı,
 *   · **38 admin rotasının 36'sı** anılmıyordu (panelde bir ekranın var olup olmadığı ancak
 *     kod okunarak öğrenilebiliyordu),
 *   · API tablosunda var olmayan bir uç yazılıydı (`/v1/products/mapped`).
 * Elle güncelleme disiplini bunu ENGELLEMEDİ; kapı engeller.
 *
 * NE DENETLER (üçü de "belgede geçiyor mu" düzeyinde — kolon/parametre ayrıntısı DEĞİL;
 * amaç eksiksizlik, kopya şema değil):
 *   1. Şemadaki her `pgTable('...')` adı MIMARI.md'de geçmeli.
 *   2. `apps/admin/app` altındaki her sayfa rotası MIMARI.md'de geçmeli.
 *   3. MIMARI.md'de `/v1/...` diye anılan her uç, gerçek bir controller önekine oturmalı.
 *
 * Kapsam BİLEREK dar: belgeyi kopya-şemaya çevirmek onu okunmaz yapar ve her kolon
 * değişikliğinde CI kırardı. Denetlenen şey "bu şeyden hiç bahsedilmemiş" hatasıdır.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MIMARI = path.join(ROOT, 'docs/MIMARI.md');
const SCHEMA_DIR = path.join(ROOT, 'apps/api/src/db/schema');
const APP_DIR = path.join(ROOT, 'apps/admin/app');
const API_SRC = path.join(ROOT, 'apps/api/src');

/** Rotası olmayan/kapsam dışı bırakılanlar — gerekçesiyle. */
const ROUTE_SKIP = new Set([
  '/login', // kimlik doğrulama akışı, "ekran" olarak anlatılmıyor (yine de haritada var)
]);

function fail(msg) {
  console.error('\n✗ check-docs: ' + msg);
  process.exitCode = 1;
}

if (!fs.existsSync(MIMARI)) {
  fail('docs/MIMARI.md bulunamadı.');
  process.exit(1);
}
const doc = fs.readFileSync(MIMARI, 'utf8');

// ── 1. Tablolar ──────────────────────────────────────────────────────────────
const tables = new Set();
for (const f of fs.readdirSync(SCHEMA_DIR)) {
  if (!f.endsWith('.ts') || f === 'index.ts') continue;
  const s = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8');
  for (const m of s.matchAll(/pgTable\(\s*'([a-z_]+)'/g)) tables.add(m[1]);
}
const eksikTablo = [...tables].filter((t) => !doc.includes(t)).sort();

// ── 2. Admin rotaları ────────────────────────────────────────────────────────
const routes = [];
(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'api' || e.name.startsWith('_')) continue;
      walk(path.join(dir, e.name), base ? base + '/' + e.name : e.name);
    } else if (e.name === 'page.tsx' && base) {
      // Dinamik segment ([id]) belgede ebeveyniyle anılır → ebeveyni ara.
      routes.push('/' + base.replace(/\/\[[^\]]+\]$/, ''));
    }
  }
})(APP_DIR, '');
const eksikRota = [...new Set(routes)]
  .filter((r) => !ROUTE_SKIP.has(r) && !doc.includes(r))
  .sort();

// ── 3. Belgede anılan API uçları gerçek mi ───────────────────────────────────
const prefixes = new Set();
(function walkApi(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkApi(p);
    else if (e.name.endsWith('.controller.ts')) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/@Controller\(\s*'([^']*)'/g)) prefixes.add(m[1]);
    }
  }
})(API_SRC);

const anilan = new Set();
for (const m of doc.matchAll(/`\/v1\/([a-z0-9-]+)/g)) anilan.add(m[1]);
// İlk segmenti bir controller önekinin ilk segmentiyle eşleşmeyen uç = uydurma.
const gercekKokler = new Set([...prefixes].map((p) => p.split('/')[0]));
const hayaletUc = [...anilan].filter((u) => !gercekKokler.has(u)).sort();

// ── Rapor ────────────────────────────────────────────────────────────────────
if (eksikTablo.length) {
  fail(
    `${eksikTablo.length} tablo docs/MIMARI.md §3'te HİÇ geçmiyor:\n    ` +
      eksikTablo.join(', ') +
      "\n  Şartnameye güvenen biri bu tabloların varlığından habersiz kalır. §3'e ekleyin.",
  );
}
if (eksikRota.length) {
  fail(
    `${eksikRota.length} admin rotası docs/MIMARI.md §13.1'de HİÇ geçmiyor:\n    ` +
      eksikRota.join(', ') +
      '\n  Rota haritasına ekleyin (ve scripts/smoke-routes.sh kapsamını kontrol edin).',
  );
}
if (hayaletUc.length) {
  fail(
    `docs/MIMARI.md var olmayan API ucu anlatıyor:\n    ` +
      hayaletUc.map((u) => '/v1/' + u).join(', ') +
      '\n  Gerçek controller önekleri: ' +
      [...gercekKokler].sort().join(', '),
  );
}

if (!process.exitCode) {
  console.log(
    `✓ check-docs: ${tables.size} tablo, ${new Set(routes).size} admin rotası, ` +
      `${anilan.size} API ucu — hepsi docs/MIMARI.md ile tutarlı.`,
  );
}
