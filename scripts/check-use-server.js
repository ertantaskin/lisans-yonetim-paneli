#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// check-use-server.js — "'use server' dosyası YALNIZ async fonksiyon export eder"
// kuralını TİP TABANLI doğrular (TypeScript compiler API).
//
// NEDEN VAR: Next 15 SWC, modül düzeyinde `'use server'` taşıyan her dosyaya
// `ensureServerEntryExports` enjekte eder; async fonksiyon OLMAYAN bir export
// görürse ("A 'use server' file can only export async functions, found object")
// TÜM action chunk'ını ÇALIŞMA ANINDA patlatır → o sayfadaki HER server action
// sessizce bozulur. `next build` bunu YAKALAMAZ (hata derleme değil, çalışma anı).
// Bu hata bu projede İKİ KEZ üretime çıktı (commit 9b81c9b — stok düzeltme +
// katalog fetch bozuldu; ve sonraki tarama dalgası).
//
// NEDEN GREP YETMEZ: bir önceki tarama düz metin grep'iyle yapıldı ve
//   const initial = { ok:false };  …  export { initial as initialPOFormState };
// re-export/alias desenini KAÇIRDI (satırda `export const` geçmiyor). Bu tarayıcı
// tip denetleyicisiyle çalışır: alias/re-export zincirini ÇÖZER, salt-tip
// export'ları eler, kalan her DEĞER export'unun çağrılabilir (async fonksiyon)
// olduğunu doğrular.
//
// Kullanım:  node scripts/check-use-server.js [dizin…]   (varsayılan: apps/admin)
//            --verbose  → taranan dosyaları da listeler
// Çıkış kodu: 0 temiz · 1 ihlal ya da tarayıcı hedefini bulamadı.
// ─────────────────────────────────────────────────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const REPO_ROOT = path.resolve(__dirname, '..');
const ARGS = process.argv.slice(2);
const VERBOSE = ARGS.includes('--verbose');
const TARGET_DIRS = ARGS.filter((a) => !a.startsWith('--'));
const SCAN_DIRS = (TARGET_DIRS.length ? TARGET_DIRS : ['apps/admin']).map((d) =>
  path.resolve(REPO_ROOT, d),
);

/** Taranmayacak klasörler (üretilmiş/harici/arşiv kod). */
// `theme-backup`: eski temanın birebir kopyası (build'e girmez, tsconfig'de de excluded) —
// taranırsa aynı export'lar iki kez raporlanır ve sayaç yanıltıcı olur.
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
const EXTS = new Set(['.ts', '.tsx', '.mts', '.cts']);

/** Yol karşılaştırmalarını platformdan bağımsız yapar (Windows ters bölü). */
const norm = (p) => p.replace(/\\/g, '/');
const rel = (p) => norm(path.relative(REPO_ROOT, p)) || norm(p);

/** Dizini yürüyüp TypeScript kaynak dosyalarını toplar. */
function collectSourceFiles(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectSourceFiles(full, acc);
    } else if (entry.isFile()) {
      if (entry.name.endsWith('.d.ts')) continue;
      if (EXTS.has(path.extname(entry.name))) acc.push(full);
    }
  }
  return acc;
}

/**
 * Dosyanın MODÜL DÜZEYİNDE 'use server' direktifi taşıyıp taşımadığı.
 * Prologue (dosya başındaki string ifade dizisi) içinde aranır — böylece istemci
 * bileşeni içindeki satır-içi `'use server'` (fonksiyon gövdesinde) ve yorum
 * satırlarındaki geçişler YANLIŞ POZİTİF üretmez.
 */
function hasModuleUseServerDirective(sourceFile) {
  for (const stmt of sourceFile.statements) {
    if (!ts.isExpressionStatement(stmt)) break;
    const expr = stmt.expression;
    if (!ts.isStringLiteral(expr) && !ts.isNoSubstitutionTemplateLiteral(expr)) break;
    if (expr.text === 'use server') return true;
  }
  return false;
}

/** Bildirim (ya da `const f = async () => {}` başlatıcısı) `async` mi? */
function isAsyncDeclaration(decl) {
  if (!decl) return false;
  const mods = decl.modifiers || [];
  if (mods.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) return true;
  if (ts.isVariableDeclaration(decl) && decl.initializer) return isAsyncDeclaration(decl.initializer);
  if (ts.isExportAssignment(decl) && decl.expression) return isAsyncDeclaration(decl.expression);
  return false;
}

/** Export bildiriminin salt-TİP olup olmadığı (`export type { X }` / `export { type X }`). */
function isTypeOnlyExportDeclaration(decl) {
  if (!decl) return false;
  if (ts.isExportSpecifier(decl)) {
    if (decl.isTypeOnly) return true;
    const exportClause = decl.parent;
    const exportDecl = exportClause && exportClause.parent;
    if (exportDecl && ts.isExportDeclaration(exportDecl) && exportDecl.isTypeOnly) return true;
  }
  return false;
}

/** Alias/re-export zincirini çözer (export { x as y }, export { x } from './z', …). */
function resolveAlias(checker, symbol) {
  let current = symbol;
  for (let i = 0; i < 16; i++) {
    if (!(current.flags & ts.SymbolFlags.Alias)) return current;
    let next;
    try {
      next = checker.getAliasedSymbol(current);
    } catch {
      return current;
    }
    if (!next || next === current) return current;
    current = next;
  }
  return current;
}

/** İnsan-okur bildirim türü (rapor metni için). */
function describeDeclaration(decl) {
  if (!decl) return 'bilinmeyen bildirim';
  if (ts.isVariableDeclaration(decl)) return 'değişken/sabit (obje, dizi, literal…)';
  if (ts.isClassDeclaration(decl)) return 'sınıf';
  if (ts.isEnumDeclaration(decl)) return 'enum';
  if (ts.isFunctionDeclaration(decl)) return 'fonksiyon';
  if (ts.isExportAssignment(decl)) return 'export default ifadesi';
  return ts.SyntaxKind[decl.kind];
}

function main() {
  // 1) Aday dosyaları bul (hafif AST parse — tip denetleyici burada devreye girmez).
  const allFiles = [];
  for (const dir of SCAN_DIRS) collectSourceFiles(dir, allFiles);

  const useServerFiles = [];
  for (const file of allFiles) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!text.includes('use server')) continue; // hızlı ön eleme
    const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, scriptKind);
    if (hasModuleUseServerDirective(sf)) useServerFiles.push(file);
  }

  // Tarayıcının SESSİZCE hiçbir şey yapmaması en kötü senaryodur (yol değişir,
  // klasör taşınır → "temiz" raporu yanlış güven verir). Sıfır dosya = hata.
  if (useServerFiles.length === 0) {
    console.error(
      `✗ check-use-server: taranan dizinlerde modül düzeyi 'use server' dosyası BULUNAMADI ` +
        `(${SCAN_DIRS.map(rel).join(', ')}). Yol yanlış ya da tarayıcı bozuk — sessiz geçilmez.`,
    );
    process.exit(1);
  }

  // 2) Tip denetleyicili program. Roots yalnız 'use server' dosyaları; import edilen
  //    modüller (alias hedefleri dahil) TS tarafından otomatik çözülür.
  const configPath = ts.findConfigFile(SCAN_DIRS[0], ts.sys.fileExists, 'tsconfig.json');
  let options = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve };
  if (configPath) {
    const cfg = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      cfg.config || {},
      ts.sys,
      path.dirname(configPath),
      undefined,
      configPath,
    );
    options = parsed.options;
  }
  const program = ts.createProgram({
    rootNames: useServerFiles,
    options: { ...options, noEmit: true, skipLibCheck: true, incremental: false, composite: false },
  });
  const checker = program.getTypeChecker();

  // 3) Her 'use server' dosyasının DEĞER export'larını denetle.
  const violations = [];
  let checkedExports = 0;

  for (const file of useServerFiles) {
    const sf = program.getSourceFile(file);
    if (!sf) continue;
    const moduleSymbol = checker.getSymbolAtLocation(sf);
    if (!moduleSymbol) continue; // modül değil (hiç import/export yok)

    for (const exp of checker.getExportsOfModule(moduleSymbol)) {
      const decls = exp.declarations || [];
      const localDecl =
        decls.find((d) => norm(d.getSourceFile().fileName) === norm(file)) || decls[0];

      // `export type { X }` / `export { type X }` → çalışma anında export YOK.
      if (isTypeOnlyExportDeclaration(localDecl)) continue;

      const resolved = resolveAlias(checker, exp);
      // Salt-tip semboller (interface / type alias) çalışma anında export edilmez.
      if ((resolved.flags & ts.SymbolFlags.Value) === 0) continue;
      // Çözülemeyen alias (modül bulunamadı vb.) → yanlış pozitif üretme.
      if (resolved.flags & ts.SymbolFlags.Alias) continue;

      checkedExports++;
      const valueDecl = resolved.valueDeclaration || (resolved.declarations || [])[0] || localDecl;

      let signatures = [];
      try {
        const type = checker.getTypeOfSymbolAtLocation(resolved, valueDecl || sf);
        signatures = type.getCallSignatures();
      } catch {
        signatures = [];
      }

      const callable = signatures.length > 0;
      const returnsPromise =
        callable &&
        signatures.every((sig) => {
          try {
            return !!sig.getReturnType().getProperty('then');
          } catch {
            return false;
          }
        });
      const isAsync = isAsyncDeclaration(valueDecl) || returnsPromise;

      if (callable && isAsync) continue;

      const node = localDecl || valueDecl;
      const nodeFile = node ? node.getSourceFile() : sf;
      const pos = node
        ? nodeFile.getLineAndCharacterOfPosition(node.getStart(nodeFile))
        : { line: 0, character: 0 };
      const origin =
        valueDecl && norm(valueDecl.getSourceFile().fileName) !== norm(file)
          ? ` (kaynak: ${rel(valueDecl.getSourceFile().fileName)})`
          : '';
      violations.push({
        file: rel(nodeFile.fileName),
        line: pos.line + 1,
        column: pos.character + 1,
        name: exp.getName(),
        reason: callable
          ? 'fonksiyon ama ASYNC DEĞİL (Promise döndürmüyor)'
          : `çağrılabilir değil — ${describeDeclaration(valueDecl)}`,
        origin,
      });
    }

    if (VERBOSE) console.log(`  · ${rel(file)}`);
  }

  // 4) Rapor.
  if (violations.length > 0) {
    console.error(`\n✗ 'use server' ihlali: ${violations.length} export async fonksiyon değil\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}:${v.column}  export '${v.name}' — ${v.reason}${v.origin}`);
    }
    console.error(
      `\n  Next 15 bu dosyalara \`ensureServerEntryExports\` enjekte eder: async fonksiyon olmayan\n` +
        `  bir export ÇALIŞMA ANINDA "can only export async functions" ile TÜM action chunk'ını\n` +
        `  patlatır → o sayfadaki HER server action bozulur (next build yakalamaz).\n` +
        `  Çözüm: başlangıç durumu objelerini/sabitleri tüketici istemci bileşenine ya da\n` +
        `  nötr bir modüle taşıyın; 'use server' dosyasında yalnız \`export async function\`\n` +
        `  ve \`export type/interface\` bırakın (bkz. commit 9b81c9b).\n`,
    );
    process.exit(1);
  }

  console.log(
    `✓ check-use-server: ${useServerFiles.length} 'use server' dosyası, ${checkedExports} değer export'u — hepsi async fonksiyon.`,
  );
}

main();
