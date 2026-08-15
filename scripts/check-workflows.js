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
 *   3) Her iş en az bir `steps` taşıyor mu (boş iş sessizce hiçbir şey yapmaz),
 *   4) Hiçbir `run:` adımı BOŞ değil.
 * Kapsam denetimi de var: hiç iş akışı dosyası bulunamazsa DÜŞER — betiğin kendisi yanlış
 * yapılandırılıp sessizce "0 dosya kontrol ettim, temiz" demesin.
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

  if (!doc || typeof doc !== 'object') {
    fail(`${rel} boş ya da eşleme (mapping) değil.`);
    continue;
  }
  if (!ON_KEYS.some((k) => k in doc)) {
    fail(`${rel} içinde tetikleyici (\`on:\`) yok — iş akışı hiç tetiklenmez.`);
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
    // `uses:` ile başka bir iş akışını çağıran iş (reusable workflow) `steps` taşımaz.
    if (typeof job.uses === 'string') continue;
    if (!Array.isArray(job.steps) || job.steps.length === 0) {
      fail(`${rel} → iş "${jobName}" hiç adım taşımıyor (sessizce hiçbir şey yapmaz).`);
      continue;
    }
    for (const [i, step] of job.steps.entries()) {
      steps++;
      if (!step || typeof step !== 'object') {
        fail(`${rel} → "${jobName}" adım ${i + 1} geçersiz.`);
        continue;
      }
      if ('run' in step && String(step.run ?? '').trim() === '') {
        fail(`${rel} → "${jobName}" adım ${i + 1} (${step.name ?? 'adsız'}) BOŞ \`run:\` taşıyor.`);
      }
    }
  }
}

if (!process.exitCode) {
  console.log(
    `✓ check-workflows: ${files.length} iş akışı, ${jobs} iş, ${steps} adım — hepsi ayrıştırılabilir.`,
  );
}
