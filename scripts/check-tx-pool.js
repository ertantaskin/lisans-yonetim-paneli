#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-tx-pool.js — "transaction içinden KÖK HAVUZ" sınıfını DERLEME ÖNCESİ yakalar.
//
// NEDEN VAR (bu projede ÜÇ kez yaşandı, ikisi ÖLÇÜLMÜŞ tam kesinti):
//   · createOrder tx'i içinden `products.resolveMapping/getById` (kök havuz) — k6: 100 VU'da
//     SIFIR tamamlanan iterasyon, havuzun tamamı 60 sn'de bir `FATAL idle_in_transaction`.
//   · supplier-claims.create tx'i içinden `listQuarantine` (kök havuz).
//   · createOrder tx'i içinden `loadOrderResult` (kök havuz) — bu kapı o düzeltmeyle eklendi.
//
// MEKANİK: postgres.js'te `db.transaction()` havuzdan BİR bağlantı rezerve eder. Gövdeden
// `this.db` ile sorgu atmak İKİNCİ bir bağlantı ister. Havuz `max:10` iken 10 eşzamanlı tx
// bağlantıların hepsini tutar ve her biri 11.'yi bekler → dairesel bekleme. postgres.js'in
// havuz kuyruğunda istemci-taraflı zaman aşımı YOKTUR; kilidi ancak `lock_timeout` /
// `idle_in_transaction_session_timeout` kırar. O pencerede `/v1/health` dahil HER ŞEY cevapsız.
//
// ADVISORY-LOCK BUNU ENGELLEMEZ: kilit kaç tx'in KİLİDİ GEÇTİĞİNİ sınırlar, kaçının BAĞLANTI
// TUTTUĞUNU değil. (supplier-claims'te tam olarak bu yanlış gerekçe yazılıydı.)
//
// NE DENETLENİR:
//   (A) DOĞRUDAN — tx gövdesinde `this.db` kullanımı. Yanlış pozitifi yok.
//   (B) BİR SEVİYE DOLAYLI — tx gövdesinden `this.<metot>(...)` çağrısı; o metot AYNI sınıfta
//       tanımlı, gövdesinde `this.db` kullanıyor ve çağrıya tx bağlayıcısı (ör. `tx`) argüman
//       olarak GEÇİLMEMİŞ. Üç gerçek olayın üçü de tam bu şekildeydi.
//
// BİLİNÇLİ SINIR: çağrı grafiği yalnız BİR seviye ve yalnız aynı dosya/sınıf içinde izlenir.
// Servisler arası (`this.products.getById(...)`) dolaylılık kapsam DIŞIDIR — orada callee'nin
// executor alıp almadığını bilmek tam bir tip çözümlemesi ister ve yanlış pozitif üretirdi.
// Bu kapı "her şeyi yakalar" demez; YAŞANMIŞ üç vakanın ÜÇÜNÜ de yakalar (kontrol denemesiyle
// doğrulandı) ve yanlış pozitif üretmez.
//
// KAÇIŞ KAPAĞI: bir satır gerçekten meşruysa (ör. commit SONRASI çalışan bir geri çağırım)
// hemen üstüne `// tx-pool-ok: <gerekçe>` yaz. Gerekçesiz kaçış kabul edilmez (boş bırakılırsa
// yine hata verir) — "az denetleyen denetleyici, denetleyici yokluğundan beterdir".
//
// Kullanım:  node scripts/check-tx-pool.js [dizin]   (varsayılan: apps/api/src)
//            --verbose → taranan her tx gövdesini listeler
// Çıkış kodu: 0 temiz · 1 ihlal.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = process.argv.find((a) => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
const DIR = path.resolve(ROOT || 'apps/api/src');
const VERBOSE = process.argv.includes('--verbose');

/** Dizin ağacındaki tüm .ts dosyaları (test/spec ve d.ts hariç). */
function collect(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      collect(full, out);
    } else if (
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.d.ts') &&
      !entry.name.includes('.test.') &&
      !entry.name.includes('.spec.')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** `// tx-pool-ok: <gerekçe>` — GEREKÇELİ olmak zorunda (boş gerekçe kaçış saymaz). */
function hasWaiver(sourceText, node, sf) {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const lines = sourceText.split(/\r?\n/);
  for (let i = line - 1; i >= 0 && i >= line - 3; i--) {
    const m = /\/\/\s*tx-pool-ok:\s*(\S.*)$/.exec(lines[i] || '');
    if (m) return true;
    // Yalnız yorum satırlarını geriye doğru tara; kod satırına çarpınca dur.
    if ((lines[i] || '').trim() && !(lines[i] || '').trim().startsWith('//')) break;
  }
  return false;
}

/** node, `this.db` erişimi mi? */
function isThisDb(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ThisKeyword &&
    node.name.text === 'db'
  );
}

const violations = [];
let txBodies = 0;

for (const file of collect(DIR)) {
  const text = fs.readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/');

  // 1) Sınıf başına metot haritası: ad → { node, usesThisDb, paramCount }
  const classMethods = new Map(); // ClassDeclaration → Map(ad → bilgi)
  const collectMethods = (node) => {
    if (ts.isClassDeclaration(node)) {
      const map = new Map();
      for (const member of node.members) {
        if ((ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member)) && member.name && ts.isIdentifier(member.name)) {
          let usesThisDb = false;
          const scan = (n) => {
            if (isThisDb(n)) usesThisDb = true;
            ts.forEachChild(n, scan);
          };
          if (member.body || member.initializer) scan(member.body || member.initializer);

          // EXECUTOR SÖZLEŞMESİ: `exec: ... = this.db` gibi VARSAYILANI kök havuz olan bir
          // parametre, metodun "beni bir tx'ten çağırıyorsan executor'ını geçir" dediği anlamına
          // gelir. Böyle bir metot tx içinden argümansız çağrılırsa gövdesi kök havuza düşer —
          // gövdede artık `this.db` GEÇMEDİĞİ için yalnız gövdeyi taramak bunu KAÇIRIR.
          // (Bu kapının ilk sürümü tam olarak bu yüzden kontrol denemesinde YEŞİL kaldı.)
          let hasExecutorParam = false;
          if (ts.isMethodDeclaration(member)) {
            for (const p of member.parameters) {
              if (p.initializer && isThisDb(p.initializer)) hasExecutorParam = true;
            }
          }
          map.set(member.name.text, { usesThisDb, hasExecutorParam, node: member });
        }
      }
      classMethods.set(node, map);
    }
    ts.forEachChild(node, collectMethods);
  };
  collectMethods(sf);

  /** Verilen düğümü kapsayan sınıfın metot haritası. */
  const methodsFor = (node) => {
    let cur = node;
    while (cur) {
      if (ts.isClassDeclaration(cur)) return classMethods.get(cur) || new Map();
      cur = cur.parent;
    }
    return new Map();
  };

  // 2) `<bir şey>.transaction(async (tx) => {...})` gövdelerini bul ve içini denetle.
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'transaction' &&
      node.arguments.length > 0 &&
      (ts.isArrowFunction(node.arguments[0]) || ts.isFunctionExpression(node.arguments[0]))
    ) {
      const cb = node.arguments[0];
      const txParam =
        cb.parameters.length > 0 && ts.isIdentifier(cb.parameters[0].name)
          ? cb.parameters[0].name.text
          : null;
      txBodies++;
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      if (VERBOSE) console.log(`  · ${rel}:${line + 1} tx gövdesi (bağlayıcı: ${txParam ?? '—'})`);

      const methods = methodsFor(node);

      const inspect = (n) => {
        // (A) DOĞRUDAN kök havuz.
        if (isThisDb(n) && !hasWaiver(text, n, sf)) {
          const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
          violations.push({
            file: rel,
            line: pos.line + 1,
            kind: 'A',
            detail: `transaction gövdesinde \`this.db\` (kök havuz) — \`${txParam ?? 'tx'}\` kullanılmalı`,
          });
        }
        // (B) BİR SEVİYE DOLAYLI: this.<metot>(...) ve o metot this.db kullanıyor.
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
          const name = n.expression.name.text;
          const info = methods.get(name);
          if (info && (info.usesThisDb || info.hasExecutorParam)) {
            const passesTx =
              txParam != null &&
              n.arguments.some((a) => {
                let found = false;
                const walk = (x) => {
                  if (ts.isIdentifier(x) && x.text === txParam) found = true;
                  ts.forEachChild(x, walk);
                };
                walk(a);
                return found;
              });
            if (!passesTx && !hasWaiver(text, n, sf)) {
              const pos = sf.getLineAndCharacterOfPosition(n.getStart(sf));
              violations.push({
                file: rel,
                line: pos.line + 1,
                kind: 'B',
                detail: info.hasExecutorParam
                  ? `transaction gövdesinden \`this.${name}(...)\` — o metot executor parametresi SUNUYOR (varsayılanı \`this.db\`) ama çağrıya \`${txParam ?? 'tx'}\` GEÇİLMEMİŞ → gövdesi kök havuza düşer`
                  : `transaction gövdesinden \`this.${name}(...)\` — o metot \`this.db\` kullanıyor ve çağrıya \`${txParam ?? 'tx'}\` GEÇİLMEMİŞ`,
              });
            }
          }
        }
        ts.forEachChild(n, inspect);
      };
      if (cb.body) inspect(cb.body);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

if (violations.length > 0) {
  console.error(`\n✗ check-tx-pool: ${violations.length} ihlal — transaction içinden kök havuz kullanımı.\n`);
  for (const v of violations) {
    console.error(`  [${v.kind}] ${v.file}:${v.line}`);
    console.error(`      ${v.detail}`);
  }
  console.error(
    '\n  NEDEN ÖNEMLİ: tx bir bağlantıyı REZERVE eder; gövdeden kök havuza sorgu atmak ikinci bir\n' +
      '  bağlantı ister. Havuz dolduğunda dairesel bekleme oluşur ve /v1/health dahil TÜM API cevapsız\n' +
      '  kalır (bu projede k6 ile iki kez ölçüldü). Advisory-lock bunu ENGELLEMEZ.\n' +
      '\n  DÜZELTME: metoda `exec: Pick<Database, ...> = this.db` parametresi ekleyip tx içinden `tx` geçir\n' +
      '  (products.getById / loadOrderResult deseni). Yan etki commit SONRASI çalışmalıysa tx dışına taşı.\n' +
      '  Gerçekten meşruysa satırın üstüne gerekçeli `// tx-pool-ok: ...` yaz.\n',
  );
  process.exit(1);
}

console.log(`✓ check-tx-pool: ${txBodies} transaction gövdesi — hiçbirinde kök havuz kullanımı yok.`);
