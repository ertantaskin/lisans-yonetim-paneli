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
// NE DENETLER: `apps/api/src` ve `apps/admin` altındaki her çalışma-anı env okuması için
//   (1) X, docker-compose.yml'deki ilgili servisin `environment:` bloğunda var mı,
//   (2) X, `.env.example`de belgeli mi (operatör hangi ayarın var olduğunu oradan öğreniyor).
// Taranan okuma biçimleri `envReads()` başlığında; `process.env.X` DIŞINDA `config.get('X')`,
// `config.getOrThrow('X')`, env yardımcıları ve `const X_ENV='ADI'` sabit dolaylaması dahildir.
// Statik olarak çözülemeyen okumalar SESSİZCE atlanmaz, uyarı olarak listelenir.
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
 * DÖRT OKUMA DESENİ taranır — ilk sürüm yalnız birincisine bakıyordu ve api'deki 28
 * değişkenin 14'ünü GÖRMÜYORDU. Üstelik görünmeyenler tam da geçmişte UNUTULAN değişkenlerdi
 * (HMAC_IP_FAIL_LIMIT, SMTP_*, TELEGRAM_*) → denetleyici "temiz" der, boşluk yerinde kalırdı.
 * "Az denetleyen denetleyici" bu projede belgelenmiş bir hata sınıfıdır (bkz. passWithNoTests
 * yüzünden sıfır test koşan dosya) — ve yanlış güven verdiği için denetleyici YOKLUĞUNDAN BETERDİR.
 *   1) process.env.X / process.env['X']
 *   2) ConfigService: .get('X') / .get<T>('X') / .getOrThrow('X') / .getOrThrow<T>('X')
 *   3) env/ayar yardımcıları: adı env|config|days|setting içeren fonksiyona İLK argüman olarak
 *      geçirilen büyük-harf sabit — `envInt('X', 5)`, `this.days('RETENTION_X', 180)`,
 *      `this.optionalDays('RETENTION_X')`.
 *   4) SABİT ARA DEĞİŞKEN: `const X_ENV = 'ENV_ADI'` + `config.get(X_ENV)` → 'ENV_ADI'e çözülür.
 *
 * (2)'de `getOrThrow` DESTEĞİ SONRADAN EKLENDİ (denetim bulgusu): eski regex `get` sonrası
 * doğrudan `(` beklediği için `.getOrThrow(` HİÇ eşleşmiyordu. YALNIZ bu yolla okunan dört
 * değişken vardı: MAIL_FROM, SMTP_PORT, REDIS_URL, ADMIN_TOKEN. Hepsi bugün compose'da geçiyor
 * (canlı arıza YOK) — ama zod şeması MAIL_FROM ve SMTP_PORT'a VARSAYILAN verdiği için biri
 * compose'dan düşerse hiçbir hata çıkmaz: mailler sessizce `teslimat@localhost`'tan gider.
 * Yani kapının korumak için VAR OLDUĞU senaryo tam da kapının kör noktasındaydı.
 *
 * (4) da aynı denetimin bulgusu: `stock.service.ts` env adını literal yazmıyor, onu
 * `autocomplete.queue.ts`teki `AUTOCOMPLETE_INLINE_CAP_ENV` sabitinden alıyordu → tarayıcı
 * göremiyordu. Sabitler ÖNCE toplanır (dosyalar arası), sonra `get(SABİT)` kullanımı çözülür.
 *
 * (3)'ün ÇAĞIRAN ADINA bakması bilinçli: "her büyük-harf ilk argüman" kuralı denendi ve
 * DELETE/POST/HMAC/MAK/INCR/PG_CLIENT/BACKUP_BYTES gibi env OLMAYAN sabitleri de topladı —
 * yanlış pozitif veren bir kapı, CI'ı ilgisiz sebeplerle kırıp güvenilirliğini yitirir.
 * Aynı sebeple (4)'te İDENTİFİER argümanı yalnız ConfigService benzeri bir alıcıda
 * (`this.config.` / `config.` / `configService.`) aranır: `map.get(key)` / `cookies.get(X)` /
 * `redis.get(idKey)` gibi yüzlerce ilgisiz `.get(` çağrısı denetime girmesin.
 *
 * ÇÖZÜLEMEYEN dinamik okumalar (`this.config.get(name)` — ad bir PARAMETRE) SESSİZCE ATLANMAZ:
 * `warnings` dizisinde raporlanır. Sessiz atlama, kapının kör noktasını görünmez kılar.
 *
 * BİLİNEN SINIR: adı (3)'ün kalıbına uymayan YENİ bir env yardımcısı (ör. `isSet('X')`) yalnız
 * o değişken BAŞKA bir yerde de okunuyorsa görülür; böyle bir yardımcı eklerken adına 'env'
 * koyun ya da buraya ekleyin.
 *
 * @returns {{ reads: Map<string,string>, warnings: string[] }}
 */
function envReads(files) {
  const out = new Map();
  const warnings = [];
  const NAME = /^[A-Z][A-Z0-9_]{2,}$/;
  const add = (name, f) => {
    if (NAME.test(name) && !out.has(name)) out.set(name, norm(path.relative(REPO_ROOT, f)));
  };

  // ── Geçiş 1: `const X = 'ENV_ADI'` sabitleri (dosyalar arası; sabit bir dosyada tanımlanıp
  // başka dosyada kullanılıyor — AUTOCOMPLETE_INLINE_CAP_ENV tam olarak böyle). Yalnız DEĞERİ
  // env adı biçiminde olan sabitler alınır: 'webhook'/'tq' gibi kuyruk/anahtar sabitleri elenir.
  const texts = new Map();
  const constEnv = new Map();
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    texts.set(f, text);
    for (const m of text.matchAll(
      /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*['"]([A-Za-z0-9_]+)['"]/g,
    )) {
      if (NAME.test(m[2])) constEnv.set(m[1], m[2]);
    }
  }

  // ── Geçiş 2: okumalar.
  for (const f of files) {
    const text = texts.get(f);
    const where = norm(path.relative(REPO_ROOT, f));
    for (const m of text.matchAll(/process\.env(?:\.([A-Z0-9_]+)|\[['"]([A-Z0-9_]+)['"]\])/g)) {
      add(m[1] || m[2], f);
    }
    // (2) literal argüman — alıcıdan bağımsız (büyük-harf literal `.get('X')` pratikte hep env).
    for (const m of text.matchAll(/\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*['"]([A-Z0-9_]+)['"]/g)) {
      add(m[1], f);
    }
    // (4) identifier argüman — YALNIZ ConfigService benzeri alıcıda (yanlış pozitif kalkanı).
    for (const m of text.matchAll(
      /(?:this\.)?\b\w*[Cc]onfig\w*\.get(?:OrThrow)?(?:<[^>]*>)?\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g,
    )) {
      const resolved = constEnv.get(m[1]);
      if (resolved) add(resolved, f);
      else warnings.push(`${where} — config.get(${m[1]}): ad sabit değil (dinamik), çözülemedi.`);
    }
    // (3) env/ayar yardımcıları.
    for (const m of text.matchAll(
      /\b(\w*(?:env|config|days|setting)\w*)\(\s*['"]([A-Z0-9_]+)['"]/gi,
    )) {
      add(m[2], f);
    }
  }
  return { reads: out, warnings };
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
  const warnings = [];
  let checked = 0;

  for (const t of targets) {
    const block = serviceBlock(compose, t.service);
    if (block === null) {
      console.error(`✗ docker-compose.yml içinde '${t.service}' servisi bulunamadı.`);
      process.exit(1);
    }
    const files = t.dirs.flatMap((d) => collect(path.join(REPO_ROOT, d)));
    const { reads, warnings: w } = envReads(files);
    for (const line of w) warnings.push(line);
    for (const [name, where] of reads) {
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

  // ÇÖZÜLEMEYEN okumalar SESSİZCE atlanmaz — kapının kör noktası GÖRÜNÜR olmalı. Bunlar CI'ı
  // kırmaz (ad çalışma anında belli olur, statik olarak bilinemez) ama listelenir: bir yardımcı
  // env adını parametre olarak alıyorsa asıl okuma ÇAĞIRANDA literal olmalıdır — orası taranır.
  if (warnings.length > 0) {
    const uniq = [...new Set(warnings)];
    console.warn(`\n! check-env-passthrough: ${uniq.length} çözülemeyen (dinamik) env okuması:`);
    for (const w of uniq) console.warn(`    ${w}`);
    console.warn(
      `  Bunlar yardımcı sarmalayıcılardır; env ADI çağırandan literal geçmelidir (o çağrılar taranır).\n`,
    );
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
