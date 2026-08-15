#!/usr/bin/env node
/**
 * GitHub Actions iş akışı dosyalarının GERÇEKTEN ayrıştırılabilir olduğunu denetler.
 *
 * NEDEN VAR (yaşandı, 19 gün sürdü):
 * `.github/workflows/ci.yml` içinde bir adım adı `- name: 'use server' export denetimi`
 * biçiminde yazılmıştı. YAML'de tek tırnakla BAŞLAYAN bir skalerden sonra düz metin gelemez →
 * dosyanın TAMAMI ayrıştırılamaz hâle geldi ("bad indentation of a mapping entry"). GitHub
 * Actions böyle bir dosyayı reddeder, yani o commit'ten (2026-07-28, ee59e14) sonra CI'daki
 * HİÇBİR kapı koşmadı: 'use server' denetimi, Nest DI kablolaması, env passthrough, typecheck,
 * birim testleri, WP php-lint, migration drift, bash -n. Hepsi yeşil sanıldı; hiçbiri çalışmadı.
 *
 * Acı ironi: dosyayı kıran satır, tam da "sessiz kırılmayı önleyecek" kapıyı ekleyen commit'te
 * girdi. Bu projenin tekrarlayan dersi burada bir kez daha doğrulandı:
 *   **Sessizce hiç çalışmayan bir kapı, kapı olmamasından BETERDİR** — yanlış güven verir.
 *
 * NEDEN CI ADIMI DEĞİL: iş akışı dosyası ayrıştırılamıyorsa o dosyadaki hiçbir adım koşmaz,
 * dolayısıyla kendini denetleyemez. Bu yüzden kapı YEREL `pnpm typecheck` zincirindedir
 * (bu projede her commit öncesi koşulur) ve ayrıca CI'da da koşar (CI sağlamken çift güvence).
 *
 * NE DENETLER:
 *   1) Her `.github/workflows/*.yml|*.yaml` GEÇERLİ YAML mı,
 *   2) En üstte `on:` ve `jobs:` var mı (Actions'ın kabul etmesi için zorunlu),
 *   3) `on:` gerçekten OTOMATİK bir tetikleyici içeriyor mu (yalnız `workflow_dispatch` ise
 *      kapılar PR'da HİÇ koşmaz — "CI sessizce çalışmıyor" sonucunun bir başka biçimi),
 *   4) Her iş `runs-on` (veya `uses:`) taşıyor mu — taşımayan işi Actions REDDEDER,
 *   5) Her iş en az bir `steps` taşıyor mu (boş iş sessizce hiçbir şey yapmaz),
 *   6) Her adım `run:` VEYA `uses:` taşıyor mu ve `run:` boş değil mi,
 *   7) YAML anchor/alias (`&x` / `*x` / `<<: *x`) kullanılmış mı — **js-yaml bunları sorunsuz
 *      çözer ama GitHub Actions DESTEKLEMEZ** ve dosyayı reddeder. Yani kapı "geçerli YAML"
 *      der, Actions çalıştırmaz: tam olarak bu betiğin var olma sebebi olan sessiz arıza.
 *      (Bu yazım alışkanlığı projede mevcut — `docker-compose.yml` `&default-logging` kullanıyor.)
 *
 * Kapsam denetimi de var: hiç iş akışı dosyası bulunamazsa DÜŞER — betiğin kendisi yanlış
 * yapılandırılıp sessizce "0 dosya kontrol ettim, temiz" demesin.
 *
 * NOT: bu liste "geçerli YAML" ile "Actions'ın kabul ettiği workflow" arasındaki farkın
 * TAMAMINI kapatmaz (tam şema doğrulaması ayrı bir iştir); yalnız sonucu SESSİZ ÖLÜ CI olan
 * yapısal hataları kapsar. Yeni bir sessiz-ölüm biçimi görülürse buraya eklenmelidir.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, '.github', 'workflows');

/** GitHub Actions `on:` anahtarını YAML 1.1 uyumlu ayrıştırıcılarda `true` olarak okur. */
const ON_KEYS = ['on', true];

function fail(msg) {
  console.error(`✗ check-workflows: ${msg}`);
  process.exitCode = 1;
}

if (!fs.existsSync(DIR)) {
  fail(`${path.relative(ROOT, DIR)} klasörü yok — CI iş akışı bulunamadı.`);
  return;
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  .sort();

if (files.length === 0) {
  fail(`${path.relative(ROOT, DIR)} içinde hiç iş akışı dosyası yok.`);
  return;
}

let steps = 0;
let jobs = 0;

for (const file of files) {
  const rel = path.join('.github', 'workflows', file);
  const raw = fs.readFileSync(path.join(DIR, file), 'utf8');

  let doc;
  try {
    doc = yaml.load(raw);
  } catch (e) {
    const where = e.mark ? ` (satır ${e.mark.line + 1}, sütun ${e.mark.column + 1})` : '';
    fail(
      `${rel} GEÇERLİ YAML DEĞİL${where}: ${String(e.reason || e.message).split('\n')[0]}\n` +
        `  GitHub Actions bu dosyayı REDDEDER → bu iş akışındaki HİÇBİR kapı koşmaz.\n` +
        `  Sık sebep: tırnakla BAŞLAYIP düz metinle devam eden bir değer\n` +
        `    yanlış:  - name: 'use server' export denetimi\n` +
        `    doğru:   - name: "'use server' export denetimi"`,
    );
    continue;
  }

  // YAML anchor/alias: js-yaml çözer, GitHub Actions REDDEDER. Kalıplar bilerek DAR tutuldu
  // (yalnız YAML'in anchor olarak yorumlayacağı konumlar) — `run:` gövdesindeki `&&` gibi
  // kabuk yazımları yanlış pozitif üretmesin diye.
  const anchorLine = raw
    .split('\n')
    .findIndex(
      (l) =>
        /^\s*[\w."'-]+:\s*&[A-Za-z0-9_-]+\s*$/.test(l) ||
        /^\s*-\s*\*[A-Za-z0-9_-]+\s*$/.test(l) ||
        /^\s*<<:\s*\*[A-Za-z0-9_-]+\s*$/.test(l),
    );
  if (anchorLine >= 0) {
    fail(
      `${rel} YAML anchor/alias kullanıyor (satır ${anchorLine + 1}).\n` +
        `  Bu dosya yerel olarak GEÇERLİ ayrıştırılır ama GitHub Actions anchor DESTEKLEMEZ ve\n` +
        `  iş akışını reddeder → hiçbir kapı koşmaz. Değeri açıkça tekrarlayın.`,
    );
  }

  if (!doc || typeof doc !== 'object') {
    fail(`${rel} boş ya da eşleme (mapping) değil.`);
    continue;
  }
  const onKey = ON_KEYS.find((k) => k in doc);
  if (onKey === undefined) {
    fail(`${rel} içinde tetikleyici (\`on:\`) yok — iş akışı hiç tetiklenmez.`);
  } else {
    // Yalnız elle tetiklenen bir iş akışı, PR'da hiçbir şeyi korumaz. `push`/`pull_request`/
    // `schedule` gibi OTOMATİK bir tetikleyici aranır; `on` string, dizi veya eşleme olabilir.
    const on = doc[onKey];
    const triggers =
      typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
    if (triggers.length > 0 && triggers.every((t) => t === 'workflow_dispatch')) {
      fail(
        `${rel} YALNIZ \`workflow_dispatch\` ile tetikleniyor — push/PR'da HİÇ koşmaz.\n` +
          `  Kapılar yalnız biri elle çalıştırdığında devreye girer; sessizce korumasız kalırsınız.`,
      );
    }
  }
  if (!doc.jobs || typeof doc.jobs !== 'object') {
    fail(`${rel} içinde \`jobs:\` yok.`);
    continue;
  }

  for (const [jobName, job] of Object.entries(doc.jobs)) {
    jobs++;
    if (!job || typeof job !== 'object') {
      fail(`${rel} → iş "${jobName}" geçersiz.`);
      continue;
    }
    // `uses:` ile başka bir iş akışını çağıran iş (reusable workflow) `steps`/`runs-on` taşımaz.
    if (typeof job.uses === 'string') continue;
    // `runs-on` YOKSA Actions işi reddeder → iş akışı hiç koşmaz.
    if (!job['runs-on']) {
      fail(`${rel} → iş "${jobName}" \`runs-on\` taşımıyor — Actions bu işi REDDEDER.`);
    }
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      fail(`${rel} → iş "${jobName}" hiç adım taşımıyor (sessizce hiçbir şey yapmaz).`);
      continue;
    }
    for (const [i, step] of job.steps.entries()) {
      steps++;
      const where = `${rel} → "${jobName}" adım ${i + 1} (${step?.name ?? 'adsız'})`;
      if (!step || typeof step !== 'object') {
        fail(`${rel} → "${jobName}" adım ${i + 1} geçersiz.`);
        continue;
      }
      // Bir adım ya komut çalıştırır (`run`) ya bir eylem çağırır (`uses`); ikisi de yoksa
      // Actions iş akışını reddeder.
      if (!('run' in step) && !('uses' in step)) {
        fail(`${where} ne \`run:\` ne \`uses:\` taşıyor — Actions iş akışını REDDEDER.`);
      }
      if ('run' in step && String(step.run ?? '').trim() === '') {
        fail(`${where} BOŞ \`run:\` taşıyor.`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log(
    `✓ check-workflows: ${files.length} iş akışı, ${jobs} iş, ${steps} adım — hepsi ayrıştırılabilir.`,
  );
}
