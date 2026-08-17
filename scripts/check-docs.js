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
 *   3. MIMARI.md'de `/v1/...` diye anılan her uç, GERÇEK bir rotanın (controller öneki +
 *      metot yolu) segment öneki olmalı.
 *
 * (3) BİR KEZ ZAYIF YAZILDI — kendi kapımın kaçağı: ilk sürüm yalnız İLK SEGMENTE bakıyordu
 * ve kod tabanında çıplak bir `@Controller('admin')` olduğu için `/v1/admin/ne-olursa-olsun`
 * uydurması SESSİZCE geçiyordu. Panel uçlarının neredeyse hepsi `admin/...` altında olduğundan
 * denetim fiilen hiçbir şey doğrulamıyordu. Kontrol denemesiyle ölçüldü ve metot yolları da
 * toplanacak şekilde düzeltildi. Ders (CLAUDE.md tuzak #11): az denetleyen bir denetleyici,
 * denetleyici yokluğundan BETERDİR — yanlış güven verir.
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
/**
 * GERÇEK ROTALAR = controller öneki + metot yolu.
 *
 * ÖNEK TEK BAŞINA YETMEZ: kod tabanında ÇIPLAK bir `@Controller('admin')` var (panel
 * uçlarının bir kısmını metot yollarıyla taşır). Yalnız öneklere bakan bir denetim
 * `/v1/admin/ne-olursa-olsun` uydurmasını GEÇİRİRDİ — panel uçlarının neredeyse hepsi
 * `admin/...` altında olduğu için bu, denetimin asıl işini yapmadığı anlamına gelirdi.
 * (Kontrol denemesinde bu KAÇAK ÖLÇÜLDÜ: uydurma bir `/v1/admin/...` ucu yeşil geçti.)
 */
const routesApi = new Set();
(function walkApi(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkApi(p);
    else if (e.name.endsWith('.controller.ts')) {
      const s = fs.readFileSync(p, 'utf8');
      for (const c of s.matchAll(/@Controller\(\s*'([^']*)'/g)) {
        const prefix = c[1];
        routesApi.add(prefix);
        // Aynı dosyadaki metot yolları bu öneke eklenir. Dosya başına tek controller
        // varsayımı bu kod tabanında geçerli (ölçüldü); değilse denetim yalnız GEVŞER.
        for (const m of s.matchAll(/@(?:Get|Post|Patch|Put|Delete)\(\s*'([^']*)'/g)) {
          const sub = m[1].replace(/^\/+/, '');
          routesApi.add(sub === '' ? prefix : `${prefix}/${sub}`);
        }
      }
    }
  }
})(API_SRC);

/**
 * Belgede anılan uçların KÖK YOLU (parametreye kadar olan sabit önek).
 *
 * ESKİDEN YALNIZ İLK SEGMENT bakılıyordu (`/v1/admin/uydurma` → 'admin' → geçerdi). Yani
 * kapı "gerçek bir controller önekine oturmalı" diyordu ama fiilen yalnız 'admin' / 'orders'
 * gibi kökleri doğruluyordu — panel uçlarının NEREDEYSE HEPSİ `/v1/admin/...` altında
 * olduğundan uydurma bir panel ucu bu denetimden SESSİZCE geçerdi. Az denetleyen bir
 * denetleyici, denetleyici yokluğundan beterdir (yanlış güven verir) → artık uç, gerçek bir
 * controller önekinin TAM segment öneki olmak zorunda.
 *
 * `:param` ve `*` içeren segmentlerde dururuz: `/v1/orders/:id/deliveries` ucunun sabit
 * kısmı `orders`tır ve controller öneki de `orders`. Rota metodlarının yol parçaları
 * (@Get('backup-summary')) taranmadığı için denetim ÖNEK düzeyinde kalır — bilinçli sınır:
 * amaç "böyle bir uç ailesi hiç yok" hatasını yakalamak, her metodu şemaya bağlamak değil.
 */
function docPathPrefix(raw) {
  const segs = [];
  for (const s of raw.split('/')) {
    if (s === '' || s.startsWith(':') || s.startsWith('*') || s.startsWith('{')) break;
    segs.push(s);
  }
  return segs.join('/');
}

const anilan = new Set();
for (const m of doc.matchAll(/`\/v1\/([a-z0-9:*/-]+)/g)) {
  const p = docPathPrefix(m[1]);
  if (p) anilan.add(p);
}

/**
 * Belgedeki uç, GERÇEK bir rotanın segment öneki mi?
 *
 * Yön TEK TARAFLI: belgedeki yol, gerçek rotanın BAŞLANGICI olmalı (`admin/deployments`,
 * gerçek `admin/deployments/backup-summary`ın önekidir → geçer). Tersi KABUL EDİLMEZ —
 * `admin/uydurma`, `admin` rotasının "devamı" sayılıp geçmemeli; kaçak tam oradaydı.
 * Gerçek rotadaki `:param` segmenti her şeye uyar (belgede `:id` yazılışı serbesttir).
 */
const gercek = [...routesApi];
function cozulur(uc) {
  const a = uc.split('/');
  return gercek.some((route) => {
    const b = route.split('/');
    if (a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (b[i].startsWith(':')) continue;
      if (a[i].startsWith(':')) continue;
      if (a[i] !== b[i]) return false;
    }
    return true;
  });
}
const hayaletUc = [...anilan].filter((u) => !cozulur(u)).sort();

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
      // Tüm rota listesini basmak (150+ satır) hatayı OKUNMAZ yapıyordu → yalnız aynı kökteki
      // gerçek rotalar gösterilir; asıl soru zaten "bunu ne diye yazdım, gerçeği hangisi?".
      hayaletUc
        .map((u) => {
          const kok = u.split('/')[0];
          const yakin = gercek.filter((r) => r.split('/')[0] === kok).sort();
          return (
            `\n  '${kok}' kökündeki GERÇEK rotalar (${yakin.length}): ` +
            (yakin.slice(0, 12).join(', ') || '(hiç yok)') +
            (yakin.length > 12 ? ` … +${yakin.length - 12}` : '')
          );
        })
        .join(''),
  );
}

if (!process.exitCode) {
  console.log(
    `✓ check-docs: ${tables.size} tablo, ${new Set(routes).size} admin rotası, ` +
      `${anilan.size} API ucu — hepsi docs/MIMARI.md ile tutarlı.`,
  );
}
