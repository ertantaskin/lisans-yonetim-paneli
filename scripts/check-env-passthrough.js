#!/usr/bin/env node
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// check-env-passthrough.js — "`.env`'e yazdım ama hiçbir şey değişmedi" sınıfını yakalar.
//
// NEDEN VAR: konteynerler `docker-compose.yml`de AÇIKÇA listelenen ortam değişkenlerini görür.
// Kod yeni bir `process.env.X` okumaya başlayıp compose'a eklenmezse, operatör `.env`e yazar,
// hiçbir hata çıkmaz, kod SESSİZCE varsayılana düşer ve ayar yapıldığı SANILIR. Bu projede
// iki kez yaşandı:
//   · SITE_SILENCE_HOURS (kod okuyor + .env.example'da belgeli, compose'a eklenmemiş),
//   · admin REQUIRE_AUTH / TZ / APP_VERSION ve api HMAC_IP_FAIL_LIMIT / RETENTION_* / RECONCILE_*.
// İkisi de ancak elle denetimde bulundu; hiçbir test/derleme adımı bunu göremezdi.
//
// NE DENETLER: `apps/api/src` ve `apps/admin` altındaki her `process.env.X` okuması için
//   (1) X, docker-compose.yml'deki ilgili servisin `environment:` bloğunda var mı,
//   (2) X, `.env.example`de belgeli mi (operatör hangi ayarın var olduğunu oradan öğreniyor).
//
// KAPSAM DIŞI: derleme/araç değişkenleri (aşağıdaki BUILD_ONLY listesi) ve çalışma anında
// Node/Next'in kendi doldurduğu değişkenler.
//
// Kullanım:  node scripts/check-env-passthrough.js
// Çıkış kodu: 0 temiz · 1 geçirilmeyen/belgesiz değişken.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const COMPOSE = path.join(REPO_ROOT, 'docker-compose.yml');
const ENV_EXAMPLE = path.join(REPO_ROOT, '.env.example');

const SKIP_DIRS = new Set([
  'node_modules',
  '.next',
  '.turbo',
  'dist',
  'build',
  'out',
  'coverage',
  'theme-backup',
]);

/**
 * Denetlenmeyen değişkenler ve GEREKÇELERİ.
 *  - Çalışma anında runtime'ın kendisi doldurur (NODE_ENV, HOSTNAME, PORT…),
 *  - ya da yalnız DERLEME/araç adımında okunur (konteyner ortamında anlamı yok).
 * Yeni bir istisna eklemeden önce iki kez düşünün: bu listeye giren her değişken,
 * "ayarladım ama çalışmıyor" hatasının geri dönüş yoludur.
 */
const BUILD_ONLY = new Map([
  ['NODE_ENV', 'compose zaten geçiriyor olabilir; runtime standardı'],
  ['TZ', 'compose zaten geçiriyor; runtime standardı'],
  ['PORT', 'platform tarafından atanır'],
  ['HOSTNAME', 'Next standalone bind adresi — compose'],
  ['CI', 'CI koşucusu doldurur'],
  ['VITEST', 'test koşucusu doldurur'],
  ['npm_package_version', 'paket yöneticisi doldurur'],
  ['NEXT_OUTPUT_STANDALONE', 'yalnız next.config derleme anahtarı — konteyner ortamında okunmaz'],
]);

const norm = (p) => p.replace(/\\/g, '/');

function collect(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collect(full, acc);
    } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.includes('.test.')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Ortam değişkeni okumalarını toplar (değişken → ilk görüldüğü dosya).
 *
 * ÜÇ OKUMA DESENİ de taranır — ilk sürüm yalnız birincisine bakıyordu ve api'deki 28
 * değişkenin 14'ünü GÖRMÜYORDU. Üstelik görünmeyenler tam da geçmişte UNUTULAN değişkenlerdi
 * (HMAC_IP_FAIL_LIMIT, SMTP_*, TELEGRAM_*) → denetleyici "temiz" der, boşluk yerinde kalırdı.
 * "Az denetleyen denetleyici" bu projede belgelenmiş bir hata sınıfıdır (bkz. passWithNoTests
 * yüzünden sıfır test koşan dosya).
 *   1) process.env.X / process.env['X']
 *   2) ConfigService: .get('X') / .get<T>('X')
 *   3) env/ayar yardımcıları: adı env|config|days|setting içeren fonksiyona İLK argüman olarak
 *      geçirilen büyük-harf sabit — `envInt('X', 5)`, `this.days('RETENTION_X', 180)`,
 *      `this.optionalDays('RETENTION_X')`.
 *
 * (3)'ün ÇAĞIRAN ADINA bakması bilinçli: "her büyük-harf ilk argüman" kuralı denendi ve
 * DELETE/POST/HMAC/MAK/INCR/PG_CLIENT/BACKUP_BYTES gibi env OLMAYAN sabitleri de topladı —
 * yanlış pozitif veren bir kapı, CI'ı ilgisiz sebeplerle kırıp güvenilirliğini yitirir.
 * BİLİNEN SINIR: adı bu kalıba uymayan YENİ bir env yardımcısı eklenirse taranmaz; böyle bir
 * yardımcı eklerken adına 'env' koyun ya da buraya ekleyin.
 */
function envReads(files) {
  const out = new Map();
  const NAME = /^[A-Z][A-Z0-9_]{2,}$/;
  const add = (name, f) => {
    if (NAME.test(name) && !out.has(name)) out.set(name, norm(path.relative(REPO_ROOT, f)));
  };
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g)) {
      add(m[1] || m[2], f);
    }
    for (const m of text.matchAll(/\.get(?:<[^>]*>)?\(\s*['"]([A-Z0-9_]+)['"]/g)) add(m[1], f);
    for (const m of text.matchAll(
      /\b(\w*(?:env|config|days|setting)\w*)\(\s*['"]([A-Z0-9_]+)['"]/gi,
    )) {
      add(m[2], f);
    }
  }
  return out;
}

/** docker-compose.yml içinden bir servisin bloğunu ayıklar (girintiye dayalı, bağımlılıksız). */
function serviceBlock(compose, service) {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l === `  ${service}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  \S/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

function main() {
  if (!fs.existsSync(COMPOSE)) {
    console.error(`✗ check-env-passthrough: ${norm(path.relative(REPO_ROOT, COMPOSE))} bulunamadı.`);
    process.exit(1);
  }
  const compose = fs.readFileSync(COMPOSE, 'utf8');
  const example = fs.existsSync(ENV_EXAMPLE) ? fs.readFileSync(ENV_EXAMPLE, 'utf8') : '';

  const targets = [
    { service: 'api', dirs: ['apps/api/src'] },
    { service: 'admin', dirs: ['apps/admin'] },
  ];

  const problems = [];
  let checked = 0;

  for (const t of targets) {
    const block = serviceBlock(compose, t.service);
    if (block === null) {
      console.error(`✗ docker-compose.yml içinde '${t.service}' servisi bulunamadı.`);
      process.exit(1);
    }
    const files = t.dirs.flatMap((d) => collect(path.join(REPO_ROOT, d)));
    for (const [name, where] of envReads(files)) {
      if (BUILD_ONLY.has(name)) continue;
      checked++;
      // `environment:` bloğunda anahtar olarak geçmeli (`X: ${X:-}` ya da `X: sabit`).
      if (!new RegExp(`^\\s+${name}\\s*:`, 'm').test(block)) {
        problems.push(
          `${where}\n    '${name}' compose'daki '${t.service}' servisine GEÇİRİLMİYOR → ` +
            `.env'e yazmak SESSİZCE etkisiz kalır (kod varsayılana düşer).`,
        );
      } else if (!new RegExp(`(^|\\n)#?\\s*${name}\\s*=`, 'm').test(example)) {
        problems.push(
          `${where}\n    '${name}' .env.example'de belgeli değil → operatör bu ayarın ` +
            `varlığını hiçbir yerden öğrenemez.`,
        );
      }
    }
  }

  if (problems.length > 0) {
    console.error(`\n✗ Ortam değişkeni denetimi: ${problems.length} sorun\n`);
    for (const p of problems) console.error(`  ${p}\n`);
    process.exit(1);
  }
  console.log(
    `✓ check-env-passthrough: ${checked} çalışma-anı değişkeni — hepsi compose'da geçiyor ve .env.example'de belgeli.`,
  );
}

main();
