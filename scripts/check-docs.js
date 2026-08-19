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
 *   2b. TERSİ DE: §13.1 rota haritasındaki her rota GERÇEKTEN var olmalı (hayalet ekran yok).
 *   2c. Rota SAYISI iddiaları (MIMARI §13.1 başlığı · CLAUDE.md · smoke-routes.sh) gerçekle eşleşmeli.
 *   3. MIMARI.md'de `/v1/...` diye anılan her uç, GERÇEK bir rotanın (controller öneki +
 *      metot yolu) segment öneki olmalı.
 *   4. `docs/mimari-gorsel.html` (MIMARI.md'den ÜRETİLİR) taze olmalı — bayatsa CI kırılır.
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
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MIMARI = path.join(ROOT, 'docs/MIMARI.md');
const SCHEMA_DIR = path.join(ROOT, 'apps/api/src/db/schema');
const APP_DIR = path.join(ROOT, 'apps/admin/app');
const API_SRC = path.join(ROOT, 'apps/api/src');
const CLAUDE_MD = 'CLAUDE.md';
const SMOKE_SH = 'scripts/smoke-routes.sh';
const CLAUDE_MD_ABS = path.join(ROOT, CLAUDE_MD);
const SMOKE_SH_ABS = path.join(ROOT, SMOKE_SH);

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

/** Sayı iddialarının yaşadığı diğer iki dosya (yoksa denetim SESSİZ kalmaz, sorun listesine düşer). */
const claude = fs.existsSync(CLAUDE_MD_ABS) ? fs.readFileSync(CLAUDE_MD_ABS, 'utf8') : null;
const smoke = fs.existsSync(SMOKE_SH_ABS) ? fs.readFileSync(SMOKE_SH_ABS, 'utf8') : null;

// ── 1. Tablolar ──────────────────────────────────────────────────────────────
const tables = new Set();
for (const f of fs.readdirSync(SCHEMA_DIR)) {
  if (!f.endsWith('.ts') || f === 'index.ts') continue;
  const s = fs.readFileSync(path.join(SCHEMA_DIR, f), 'utf8');
  for (const m of s.matchAll(/pgTable\(\s*'([a-z_]+)'/g)) tables.add(m[1]);
}
const eksikTablo = [...tables].filter((t) => !doc.includes(t)).sort();

// ── 1b. Kuyruklar ────────────────────────────────────────────────────────────
/**
 * NEDEN VAR (ölçüldü): panelin arka planında 11 BullMQ kuyruğu ve 9 tekrarlı iş var, ama
 * "ne koşuyor, hangi sıklıkta, hangi env değiştirir" sorusunun HİÇBİR belgede cevabı yoktu —
 * `daily-digest`, `backup-alarm`, `low-stock`, `site-silence`, `stock-autocomplete` ve
 * `security` şartnamede adıyla HİÇ geçmiyordu. Operasyon panelinde bu bilgi birinci sınıftır:
 * sessizce ölen bir süpürme, günlerce fark edilmeyen bir kesinti demektir (bu projede yaşandı).
 * Bir kuyruk eklenip §16.1 güncellenmezse CI kırılır.
 */
const queues = new Set();
(function walkQueue(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkQueue(p);
    else if (e.name.endsWith('.ts') && !e.name.includes('.test.')) {
      const s = fs.readFileSync(p, 'utf8');
      for (const m of s.matchAll(/export const [A-Z0-9_]*QUEUE\s*=\s*'([a-z0-9-]+)'/g)) {
        queues.add(m[1]);
      }
    }
  }
})(API_SRC);
const eksikKuyruk = [...queues].filter((q) => !doc.includes('`' + q + '`')).sort();

// ── 2. Admin rotaları ────────────────────────────────────────────────────────
const routes = [];
/** Gerçek rota kümesi — HEM ham (`/orders/[id]`) HEM ebeveyn (`/orders`); (2b) bunu kullanır. */
const rotaVar = new Set();
(function walk(dir, base) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (e.name === 'api' || e.name.startsWith('_')) continue;
      walk(path.join(dir, e.name), base ? base + '/' + e.name : e.name);
    } else if (e.name === 'page.tsx' && base) {
      // Dinamik segment ([id]) belgede ebeveyniyle anılır → ebeveyni ara.
      routes.push('/' + base.replace(/\/\[[^\]]+\]$/, ''));
      rotaVar.add('/' + base);
      rotaVar.add(routes[routes.length - 1]);
    }
  }
})(APP_DIR, '');
const eksikRota = [...new Set(routes)].filter((r) => !ROUTE_SKIP.has(r) && !doc.includes(r)).sort();

// ── 2b. TERSİ YÖN: belgede anlatılan ekran GERÇEKTEN var mı ──────────────────
/**
 * NEDEN VAR (ölçüldü): (2) yalnız KOD → BELGE yönünü denetliyordu; belgenin var olmayan bir
 * ekranı anlatması SESSİZCE geçiyordu. §13.1 rota haritası bir dönem `/inventory` (lisans
 * envanteri) diye bir ekran listeliyordu — o rota HİÇ var olmadı; envanter, `/products/[id]`
 * içindeki bir SEKME. Bu, tabloların bir dönem 4 uydurma tablo anlatmasıyla aynı arıza sınıfı
 * (CLAUDE.md tuzak #4) ve tam olarak bu kapının önlemesi gereken şeydi.
 *
 * Kapsam BİLEREK §13.1 tablosuyla sınırlı: belgenin başka yerlerinde `/reveal`, `/bonus`,
 * `/catalog` gibi API ALT YOLLARI da backtick içinde geçiyor; tüm belgeyi taramak onları
 * "hayalet ekran" sanardı (yanlış alarm = kapının kapatılması).
 */
const ROTA_HARITASI = (() => {
  const bas = doc.indexOf('### 13.1');
  if (bas < 0) return null;
  const kalan = doc.slice(bas);
  const son = kalan.indexOf('\n---');
  return son < 0 ? kalan : kalan.slice(0, son);
})();

const hayaletRota = [];
if (ROTA_HARITASI === null) {
  fail(
    "docs/MIMARI.md içinde '### 13.1' başlığı bulunamadı — rota haritası denetimi KOŞMADI.\n" +
      '  Başlık yeniden adlandırıldıysa scripts/check-docs.js içindeki çıpayı da güncelleyin\n' +
      '  (sessizce koşmayan bir kapı, kapı yokluğundan beterdir — CLAUDE.md tuzak #11).',
  );
} else {
  for (const m of ROTA_HARITASI.matchAll(/`(\/[a-z0-9[\]/-]+)`/g)) {
    const r = m[1];
    if (ROUTE_SKIP.has(r)) continue;
    // Gerçek rota kümesi: hem dinamik hâliyle (`/orders/[id]`) hem ebeveyniyle (`/orders`).
    if (!rotaVar.has(r)) hayaletRota.push(r);
  }
}

// ── 2c. Rota SAYISI iddiaları ────────────────────────────────────────────────
/**
 * NEDEN VAR (ölçüldü): sayı üç ayrı yerde ELLE yazılı ve üçü de bayatladı —
 * CLAUDE.md "38 sayfa rotası (duman testi 36 tarar)" derken duman testi 37 rota tarıyordu.
 * Liste doğruydu (smoke-routes.sh kendi kapsamını app/ ağacıyla karşılaştırıyor); yalnız
 * İDDİA yanlıştı. Kapıya bakan biri "iki ekran taranmıyor" sanırdı.
 */
const sayiSorunlari = [];
function sayiDenetle(dosya, metin, kalip, beklenen, ne) {
  const m = metin.match(kalip);
  if (!m) {
    sayiSorunlari.push(
      `${dosya}: "${ne}" iddiası BULUNAMADI (kalıp: ${kalip}).\n` +
        '    Cümle yeniden yazıldıysa buradaki kalıbı da güncelleyin; aksi halde denetim sessizce durur.',
    );
    return;
  }
  if (Number(m[1]) !== beklenen) {
    sayiSorunlari.push(`${dosya}: "${ne}" ${m[1]} yazıyor, gerçek ${beklenen}.`);
  }
}

const rotaSayisi = new Set(routes).size;
// Duman testi kök `/`yi zaten saymaz (bkz. yukarıdaki walk) ve `/login`i BİLEREK atlar.
const dumanBeklenen = rotaSayisi - 1;

sayiDenetle(
  'docs/MIMARI.md §13.1',
  doc,
  /### 13\.1 [^\n]*?\((\d+) rota\)/,
  rotaSayisi,
  'rota haritası başlığı',
);

if (claude === null) {
  sayiSorunlari.push(CLAUDE_MD + ': dosya okunamadı — sayı iddiaları DENETLENMEDİ.');
} else {
  for (const [kalip, beklenen, ne] of [
    [/(\d+) sayfa rotası/, rotaSayisi, 'panel rota sayısı'],
    [/duman testi (\d+) tarar/, dumanBeklenen, 'duman testi kapsamı'],
    [/smoke-routes\.sh[^|]*\|\s*(\d+) admin rotası/, dumanBeklenen, 'doğrulama tablosu'],
  ]) {
    sayiDenetle(CLAUDE_MD, claude, kalip, beklenen, ne);
  }
}

// smoke-routes.sh: listenin KENDİSİ app/ ağacıyla karşılaştırılıyor (betiğin içinde), ama
// yalnız EKSİK yönünü yakalıyor. Buradaki denetim FAZLAyı da yakalar: silinmiş bir ekran
// listede kalırsa duman testi her koşuda 404/500 alır ve gürültü "bilinen arıza" sanılır.
if (smoke !== null) {
  const m = smoke.match(/ROUTES=\(([\s\S]*?)\n\)/);
  if (!m) {
    sayiSorunlari.push(SMOKE_SH + ': ROUTES=( … ) bloğu ayrıştırılamadı — kapsam DENETLENMEDİ.');
  } else {
    const liste = m[1].split(/\s+/).filter((x) => x && !x.startsWith('#'));
    if (liste.length !== dumanBeklenen) {
      sayiSorunlari.push(
        `${SMOKE_SH}: ROUTES ${liste.length} rota içeriyor, gerçek ${dumanBeklenen} ` +
          '(kök `/` ve `/login` hariç).',
      );
    }
    const fazla = liste.filter((r) => !rotaVar.has('/' + r));
    if (fazla.length) {
      sayiSorunlari.push(
        `${SMOKE_SH}: listede var olmayan rota(lar) duruyor: ` +
          fazla.map((r) => '/' + r).join(', '),
      );
    }
  }
} else {
  sayiSorunlari.push(SMOKE_SH + ': dosya okunamadı — duman testi kapsamı DENETLENMEDİ.');
}

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
if (eksikKuyruk.length) {
  fail(
    `${eksikKuyruk.length} BullMQ kuyruğu docs/MIMARI.md §16.1'de HİÇ geçmiyor:\n    ` +
      eksikKuyruk.join(', ') +
      '\n  Arka planda ne koştuğu, hangi sıklıkta koştuğu ve hangi env ile değiştiği' +
      '\n  §16.1 tablosuna yazılmalı (kuyruk adı backtick içinde geçmeli).',
  );
}
if (eksikRota.length) {
  fail(
    `${eksikRota.length} admin rotası docs/MIMARI.md §13.1'de HİÇ geçmiyor:\n    ` +
      eksikRota.join(', ') +
      '\n  Rota haritasına ekleyin (ve scripts/smoke-routes.sh kapsamını kontrol edin).',
  );
}
if (hayaletRota.length) {
  fail(
    `docs/MIMARI.md §13.1 var olmayan ${hayaletRota.length} ekran anlatıyor:\n    ` +
      hayaletRota.join(', ') +
      '\n  Bu rotaların hiçbirinde apps/admin/app/<rota>/page.tsx yok. Şartnameye güvenen biri' +
      '\n  olmayan bir ekranı arar (ya da onu "kaybolmuş" sanıp yeniden yazar).' +
      '\n  Ekran gerçekten kaldırıldıysa haritadan da çıkarın; bir SEKME hâline geldiyse' +
      '\n  ebeveyn rotanın açıklamasında anın (ör. /products/[id] içindeki envanter sekmesi).',
  );
}
if (sayiSorunlari.length) {
  fail(
    'rota SAYISI iddiaları gerçekle uyuşmuyor:\n    ' +
      sayiSorunlari.join('\n    ') +
      '\n  Liste doğru olsa bile yanlış sayı, okuyanı "iki ekran taranmıyor" sanmaya götürür.',
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

// ── 4. Görsel kopya taze mi ──────────────────────────────────────────────────
/**
 * `docs/mimari-gorsel.html` artık ELLE yazılmıyor: MIMARI.md'den üretiliyor
 * (scripts/build-mimari-gorsel.js). Üretilmiş dosyanın commit'lenmiş hâli kaynakla
 * uyuşmuyorsa burada düşer — eskiden bu sapma kimseyi uyarmadan aylarca sürebiliyordu
 * (şartname v2.7'yken görsel kopya v2.6'da donmuştu ve düşürülmüş bir fazı canlı gibi
 * anlatıyordu).
 */
try {
  execFileSync(process.execPath, [path.join(__dirname, 'build-mimari-gorsel.js'), '--check'], {
    stdio: 'pipe',
  });
} catch (e) {
  fail(
    'docs/mimari-gorsel.html BAYAT (MIMARI.md ile üretilmiş kopya uyuşmuyor).' +
      '\n  Düzeltmesi: `pnpm docs:gorsel` — çıkan dosyayı commit edin. Dosya ELLE düzenlenmez.' +
      (e.stderr ? '\n' + String(e.stderr).trim().replace(/^/gm, '  ') : ''),
  );
}

if (!process.exitCode) {
  console.log(
    `✓ check-docs: ${tables.size} tablo, ${queues.size} kuyruk, ${rotaSayisi} admin rotası (duman testi ${dumanBeklenen}), ` +
      `${anilan.size} API ucu, görsel kopya taze — hepsi docs/MIMARI.md ile tutarlı.`,
  );
}
