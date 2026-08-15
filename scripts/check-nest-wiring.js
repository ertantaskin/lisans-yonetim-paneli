#!/usr/bin/env node
/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────────
// check-nest-wiring.js — "API hiç boot etmiyor" sınıfını DERLEME ÖNCESİ yakalar.
//
// NEDEN VAR: bu projenin en pahalı sessiz hatalarından biri, bir servise/işleyiciye yeni bir
// constructor bağımlılığı eklenip o bağımlılığı SAĞLAYAN modülün ilgili modülün `imports`una
// EKLENMEMESİDİR. `tsc` de `next build` de bunu GÖRMEZ (ikisi de tip düzeyinde geçerli);
// hata yalnız Nest gerçekten ayağa kalkarken çıkar ve sonucu TÜM API'nin boot etmemesidir.
// Yaşandı:
//   · SecurityProcessor → SweepAlarmService (NotificationsModule import'u eksikti),
//   · AutocompleteProcessor → SweepAlarmService (aynı sınıf; bu tarayıcı o düzeltmeyle eklendi).
//
// NEDEN REFLECTION DEĞİL: `Reflect.getMetadata('design:paramtypes')` yalnız `emitDecoratorMetadata`
// ile derlenmiş kodda vardır; vitest/esbuild bunu ÜRETMEZ. Metadata'ya dayanan bir test SESSİZCE
// hiçbir şey denetlemez (denendi: glue kaldırıldığında test yeşil kaldı). Bu yüzden denetim
// TypeScript AST üzerinden SÖZ DİZİMSEL yapılır — derleyici ayarından bağımsızdır.
//
// İKİ DENETİM YAPILIR:
//   (A) SINIF BAĞIMLILIĞI — sağlayıcının constructor tipi, tüketen modülden görünüyor mu.
//   (B) KUYRUK BAĞIMLILIĞI — `@InjectQueue(Q)` alan bir sağlayıcı için, o kuyruk sağlayıcının
//       modülünde `BullModule.registerQueue({ name: Q })` ile kayıtlı mı.
//
// (B) SONRADAN EKLENDİ (denetim bulgusu): eski sürüm `if (param.decorated) continue` ile TÜM
// dekoratörlü parametreleri atlıyordu — yani `@InjectQueue`'ları da. Oysa bir modül
// `registerQueue` eklemeyi unutursa Nest `BullQueue_<ad>` sağlayıcısını çözemez ve API HİÇ BOOT
// ETMEZ: bu kapının VAR OLMA SEBEBİ olan arıza sınıfının ta kendisi, kapının kör noktasındaydı.
// `tsc`/`next build` görmez (kuyruk adı bir string sabittir, tip düzeyinde her şey geçerlidir).
//
// YANLIŞ POZİTİF POLİTİKASI (bilinçli olarak temkinli): yalnız "bu sınıf bir yerde sağlayıcı
// olarak kayıtlı AMA tüketen modülden görünmüyor" durumunda hata verir. `@Inject(TOKEN)` ile
// verilen özel token'lar (DB/REDIS/PG_CLIENT — @Global modüllerde sağlanır) ve hiçbir modülde
// sağlayıcı olmayan tipler (Logger, Queue, Redis…) KAPSAM DIŞIDIR: bunları denetlemek yanlış
// pozitif üretir ve CI'ı ilgisiz sebeplerle kıran bir kapı güvenilirliğini yitirir.
//
// Kullanım:  node scripts/check-nest-wiring.js [dizin]   (varsayılan: apps/api/src)
//            --verbose  → çözülen her bağımlılığı listeler
// Çıkış kodu: 0 temiz · 1 eksik glue.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const TARGET = ARGS.filter((a) => !a.startsWith('--'))[0] || 'apps/api/src';
const SCAN_DIR = path.resolve(REPO_ROOT, TARGET);

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.turbo', 'coverage']);
const norm = (p) => p.replace(/\\/g, '/');
const rel = (p) => norm(path.relative(REPO_ROOT, p)) || norm(p);

function collectSourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) collectSourceFiles(full, acc);
    } else if (e.isFile() && e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
      acc.push(full);
    }
  }
  return acc;
}

/** Bir dekoratör ifadesinin adı (`@Module({…})` → 'Module', `@Global()` → 'Global'). */
function decoratorName(dec) {
  const expr = dec.expression;
  const callee = ts.isCallExpression(expr) ? expr.expression : expr;
  return ts.isIdentifier(callee) ? callee.text : null;
}

function getDecorators(node) {
  return (ts.canHaveDecorators(node) ? ts.getDecorators(node) : undefined) || [];
}

/** `X`, `forwardRef(() => X)` → 'X'. Dinamik modüller (`M.register(...)`) → null. */
function moduleRefName(node) {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === 'forwardRef' && node.arguments.length === 1) {
      const arg = node.arguments[0];
      if (ts.isArrowFunction(arg) && arg.body && ts.isIdentifier(arg.body)) return arg.body.text;
    }
  }
  return null; // BullModule.registerQueue(...) gibi dinamik modüller
}

/**
 * Sağlayıcı girdisinden isim(ler) çıkarır.
 * `X` → { token:'X', impl:'X' } · `{ provide: T, useClass: C }` → { token:'T', impl:'C' }
 * `{ provide: T, useFactory }` → { token:'T', impl:null } (fabrika bağımlılıkları `inject:` ile
 * verilir, constructor denetimi konusu değildir).
 */
function providerEntry(node) {
  if (ts.isIdentifier(node)) return { token: node.text, impl: node.text };
  if (ts.isObjectLiteralExpression(node)) {
    let token = null;
    let impl = null;
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !p.name) continue;
      const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
      if (key === 'provide' && ts.isIdentifier(p.initializer)) token = p.initializer.text;
      if (key === 'useClass' && ts.isIdentifier(p.initializer)) impl = p.initializer.text;
    }
    if (token || impl) return { token: token || impl, impl };
  }
  return null;
}

function arrayProp(objLit, name) {
  for (const p of objLit.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue;
    const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
    if (key === name && ts.isArrayLiteralExpression(p.initializer)) return p.initializer.elements;
  }
  return [];
}

/**
 * `@InjectQueue(X)` / `@InjectQueue('ad')` parametresinden kuyruk referansını çıkarır.
 * @returns {{ ref: string, literal: boolean } | null} — `ref` sabit adı ya da düz metin.
 */
function injectedQueueRef(param) {
  for (const dec of getDecorators(param)) {
    if (decoratorName(dec) !== 'InjectQueue') continue;
    const expr = dec.expression;
    if (!ts.isCallExpression(expr) || expr.arguments.length === 0) return null;
    const a = expr.arguments[0];
    if (ts.isStringLiteral(a)) return { ref: a.text, literal: true };
    if (ts.isIdentifier(a)) return { ref: a.text, literal: false };
    return { ref: a.getText(), literal: false }; // dinamik → çözülemez, uyarı olarak raporlanır
  }
  return null;
}

/**
 * Bir modülün `imports:` dizisinden `BullModule.registerQueue({ name: Q }, …)` ile kaydedilen
 * kuyruk referanslarını toplar. `registerQueue` DEĞİŞKEN SAYIDA argüman alır (maintenance/ops
 * modülleri tek çağrıda 4-5 kuyruk kaydediyor) → tüm argümanlar taranır.
 */
function registeredQueueRefs(importElements) {
  const refs = [];
  for (const el of importElements) {
    if (!ts.isCallExpression(el)) continue;
    const callee = el.expression;
    if (!ts.isPropertyAccessExpression(callee)) continue;
    const fn = callee.name.text;
    if (fn !== 'registerQueue' && fn !== 'registerQueueAsync') continue;
    for (const arg of el.arguments) {
      if (!ts.isObjectLiteralExpression(arg)) continue;
      for (const p of arg.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name) continue;
        const key = ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) ? p.name.text : null;
        if (key !== 'name') continue;
        if (ts.isStringLiteral(p.initializer)) refs.push({ ref: p.initializer.text, literal: true });
        else if (ts.isIdentifier(p.initializer)) refs.push({ ref: p.initializer.text, literal: false });
      }
    }
  }
  return refs;
}

/** Parametre tipinin sınıf adı (`private readonly x: Foo` → 'Foo'). Generic/union → null. */
function paramTypeName(param) {
  const t = param.type;
  if (!t || !ts.isTypeReferenceNode(t)) return null;
  if (t.typeArguments && t.typeArguments.length > 0) return null; // Queue<T>, Repository<T>…
  const n = t.typeName;
  if (ts.isIdentifier(n)) return n.text;
  return null; // nitelenmiş ad (ns.Type)
}

function main() {
  const files = collectSourceFiles(SCAN_DIR);
  if (files.length === 0) {
    console.error(`✗ check-nest-wiring: '${rel(SCAN_DIR)}' altında kaynak bulunamadı.`);
    process.exit(1);
  }

  /** modulName → { file, imports:[], providers:[{token,impl}], exports:[], global:bool, queues:[] } */
  const modules = new Map();
  /** sınıfAdı → { file, ctorParams:[{name,type,decorated}] } */
  const classes = new Map();
  /**
   * `const X = 'değer'` string sabitleri — kuyruk adları KOD BOYUNCA sabit üzerinden taşınıyor
   * (`export const MAIL_QUEUE = 'mail'` → hem `@InjectQueue(MAIL_QUEUE)` hem
   * `registerQueue({ name: MAIL_QUEUE })`). Sabit AYRI dosyada tanımlanabildiği için (ör.
   * `autocomplete.queue.ts`) harita dosyalar arası tutulur ve çözüm tüm dosyalar okunduktan
   * SONRA yapılır.
   */
  const stringConsts = new Map();

  for (const file of files) {
    const src = ts.createSourceFile(
      file,
      fs.readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const stmt of src.statements) {
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && ts.isStringLiteral(d.initializer)) {
            stringConsts.set(d.name.text, d.initializer.text);
          }
        }
        continue;
      }
      if (!ts.isClassDeclaration(stmt) || !stmt.name) continue;
      const name = stmt.name.text;
      const decs = getDecorators(stmt);
      const modDec = decs.find((d) => decoratorName(d) === 'Module');

      // Sınıfın constructor imzası (her sınıf için — sağlayıcı olup olmadığına sonra bakılır).
      const ctor = stmt.members.find((m) => ts.isConstructorDeclaration(m));
      if (ctor) {
        classes.set(name, {
          file,
          params: ctor.parameters.map((p) => ({
            type: paramTypeName(p),
            decorated: getDecorators(p).length > 0,
            queue: injectedQueueRef(p),
            pos: p.getStart(src),
            src,
          })),
        });
      } else {
        classes.set(name, { file, params: [] });
      }

      if (modDec && ts.isCallExpression(modDec.expression) && modDec.expression.arguments.length) {
        const arg = modDec.expression.arguments[0];
        if (!ts.isObjectLiteralExpression(arg)) continue;
        modules.set(name, {
          file,
          global: decs.some((d) => decoratorName(d) === 'Global'),
          imports: arrayProp(arg, 'imports').map(moduleRefName).filter(Boolean),
          providers: arrayProp(arg, 'providers').map(providerEntry).filter(Boolean),
          exports: arrayProp(arg, 'exports').map(moduleRefName).filter(Boolean),
          queues: registeredQueueRefs(arrayProp(arg, 'imports')),
        });
      }
    }
  }

  // Bir modülün görünür kıldığı token kümesi (exports; export listesindeki MODÜLLER şeffaf geçer).
  const exportedCache = new Map();
  function exportedTokens(modName, seen = new Set()) {
    if (exportedCache.has(modName)) return exportedCache.get(modName);
    const out = new Set();
    const m = modules.get(modName);
    if (!m || seen.has(modName)) return out;
    seen.add(modName);
    for (const e of m.exports) {
      out.add(e);
      if (modules.has(e)) for (const t of exportedTokens(e, seen)) out.add(t);
    }
    exportedCache.set(modName, out);
    return out;
  }

  // Global modüllerin sağladığı/dışa vurduğu her şey her yerden görünür.
  const globalTokens = new Set();
  for (const [name, m] of modules) {
    if (!m.global) continue;
    for (const p of m.providers) globalTokens.add(p.token);
    for (const t of exportedTokens(name)) globalTokens.add(t);
  }

  // Herhangi bir modülde sağlayıcı olarak kayıtlı token'lar — YALNIZ bunlar denetlenir.
  const knownProvided = new Set();
  for (const m of modules.values()) for (const p of m.providers) knownProvided.add(p.token);

  // ── (B) KUYRUK GÖRÜNÜRLÜĞÜ ────────────────────────────────────────────────────────────────
  // Kuyruk referansını gerçek ada çözer: literal ise kendisi, değilse `const X='ad'` sabitinden.
  const queueWarnings = [];
  const resolveQueue = (q, where) => {
    if (!q) return null;
    if (q.literal) return q.ref;
    const v = stringConsts.get(q.ref);
    if (v) return v;
    queueWarnings.push(`${where}: kuyruk adı '${q.ref}' statik olarak çözülemedi (dinamik).`);
    return null;
  };

  /**
   * Bir modülden GÖRÜNEN kuyruk adları. `BullModule.registerQueue` `BullQueue_<ad>` sağlayıcısını
   * YALNIZ onu import eden modüle verir; başka bir modül o modülü import etse bile kuyruğu GÖRMEZ
   * — ancak aradaki modül `exports: [BullModule]` diyorsa geçer (QueueModule kök bağlantı için
   * tam olarak bunu yapıyor; kuyruk KAYDETMEDİĞİ için bugün ek görünürlük üretmiyor).
   */
  const visibleQueueCache = new Map();
  function visibleQueues(modName, seen = new Set()) {
    if (visibleQueueCache.has(modName)) return visibleQueueCache.get(modName);
    const out = new Set();
    const m = modules.get(modName);
    if (!m || seen.has(modName)) return out;
    seen.add(modName);
    for (const q of m.queues) {
      const name = resolveQueue(q, `${rel(m.file)} (registerQueue)`);
      if (name) out.add(name);
    }
    for (const imp of m.imports) {
      const im = modules.get(imp);
      if (im && im.exports.includes('BullModule')) {
        for (const q of visibleQueues(imp, seen)) out.add(q);
      }
    }
    visibleQueueCache.set(modName, out);
    return out;
  }

  // @Global + `exports: [BullModule]` olan modüllerin kuyrukları her yerden görünür.
  const globalQueues = new Set();
  for (const [name, m] of modules) {
    if (!m.global || !m.exports.includes('BullModule')) continue;
    for (const q of visibleQueues(name)) globalQueues.add(q);
  }

  const problems = [];
  const queueProblems = [];
  let checked = 0;
  let queueChecked = 0;

  for (const [modName, m] of modules) {
    const visible = new Set(globalTokens);
    for (const p of m.providers) visible.add(p.token);
    for (const imp of m.imports) for (const t of exportedTokens(imp)) visible.add(t);

    for (const provider of m.providers) {
      const implName = provider.impl;
      if (!implName) continue; // useFactory/useValue — constructor denetimi konusu değil
      const cls = classes.get(implName);
      if (!cls) continue; // sınıf bu dizinde değil (harici) → yargılama
      for (const param of cls.params) {
        // (B) `@InjectQueue(Q)` → kuyruk BU modülde registerQueue ile kayıtlı olmalı.
        if (param.queue) {
          const qname = resolveQueue(param.queue, `${rel(cls.file)} (@InjectQueue)`);
          if (!qname) continue; // çözülemedi → uyarı listesine düştü, yargılama
          queueChecked++;
          if (!visibleQueues(modName).has(qname) && !globalQueues.has(qname)) {
            const { line } = param.src.getLineAndCharacterOfPosition(param.pos);
            queueProblems.push({
              module: modName,
              moduleFile: rel(m.file),
              provider: implName,
              queue: qname,
              ref: param.queue.literal ? `'${qname}'` : param.queue.ref,
              where: `${rel(cls.file)}:${line + 1}`,
            });
          } else if (VERBOSE) {
            console.log(`  ok  ${modName} → ${implName} @InjectQueue('${qname}')`);
          }
          continue;
        }
        if (param.decorated) continue; // @Inject(TOKEN)/@Optional → token, tip değil
        if (!param.type) continue; // generic/union/nitelenmiş → yargılama
        if (!knownProvided.has(param.type)) continue; // Logger/Queue/… hiçbir modülde sağlayıcı değil
        checked++;
        if (visible.has(param.type)) {
          if (VERBOSE) console.log(`  ok  ${modName} → ${implName}(${param.type})`);
          continue;
        }
        const { line } = param.src.getLineAndCharacterOfPosition(param.pos);
        problems.push({
          module: modName,
          moduleFile: rel(m.file),
          provider: implName,
          dep: param.type,
          where: `${rel(cls.file)}:${line + 1}`,
        });
      }
    }
  }

  if (queueWarnings.length > 0) {
    const uniq = [...new Set(queueWarnings)];
    console.warn(`\n! check-nest-wiring: ${uniq.length} kuyruk adı statik olarak çözülemedi:`);
    for (const w of uniq) console.warn(`    ${w}`);
    console.warn(`  Kuyruk adlarını string sabit olarak tanımlayın (ör. const X_QUEUE = 'ad').\n`);
  }

  if (queueProblems.length > 0) {
    console.error(`\n✗ BullMQ kuyruk kaydı eksik: ${queueProblems.length} kuyruk çözülemiyor\n`);
    for (const p of queueProblems) {
      console.error(
        `  ${p.where}\n` +
          `    ${p.provider} → @InjectQueue(${p.ref}) ama '${p.queue}' kuyruğu ${p.module} içinde kayıtlı değil.\n` +
          `    Çözüm: ${p.moduleFile} → imports: [BullModule.registerQueue({ name: ${p.ref} })]\n`,
      );
    }
    console.error(
      `  Bu hata ÇALIŞMA ANINDA çıkar: Nest 'BullQueue_<ad>' sağlayıcısını çözemez ve API HİÇ\n` +
        `  BOOT ETMEZ. 'tsc'/'next build' yakalamaz (kuyruk adı yalnız bir string sabitidir).\n`,
    );
  }

  if (problems.length > 0) {
    console.error(`\n✗ Nest kablolama hatası: ${problems.length} bağımlılık çözülemiyor\n`);
    for (const p of problems) {
      const owners = [...modules.entries()]
        .filter(([n, m]) => m.providers.some((x) => x.token === p.dep) && exportedTokens(n).has(p.dep))
        .map(([n]) => n);
      console.error(
        `  ${p.where}\n` +
          `    ${p.provider} → '${p.dep}' bağımlılığı ${p.module} içinden görünmüyor.\n` +
          `    Çözüm: ${p.moduleFile} → imports: [${owners.join(' | ') || "'" + p.dep + "'i export eden modül"}]\n`,
      );
    }
    console.error(
      `  Bu hata ÇALIŞMA ANINDA çıkar: Nest bağımlılığı çözemez ve API HİÇ BOOT ETMEZ.\n` +
        `  'tsc' ve 'next build' bunu yakalamaz (ikisi de tip düzeyinde geçerlidir).\n`,
    );
  }

  if (problems.length > 0 || queueProblems.length > 0) process.exit(1);

  console.log(
    `✓ check-nest-wiring: ${modules.size} modül, ${checked} sınıf bağımlılığı + ` +
      `${queueChecked} kuyruk bağımlılığı — hepsi çözülebilir.`,
  );
}

main();
