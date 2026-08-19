#!/usr/bin/env node
/**
 * WP EKLENTİSİ SÜRÜM TUTARLILIĞI KAPISI.
 *
 * NEDEN VAR (ölçüldü, tahmin değil): sürüm numarası eklentide ÜÇ yerde yazılıdır —
 * `wpteslimat.php` başlığındaki `Version:`, aynı dosyadaki `WPTESLIMAT_VERSION` sabiti ve
 * `readme.txt` içindeki `Stable tag:`. 2026-08-18'deki v1.1.8 yükseltmesinde başlık ve
 * readme güncellendi, **sabit 1.1.7'de kaldı** ve bu hiçbir yerde görülmedi: `php -l`
 * sözdizimine bakar, eklenti davranış testleri sürüme bakmaz, `tsc` PHP görmez. Sapma ancak
 * YAYIN denendiğinde (`publish-plugin.sh`) ortaya çıktı — yani yayın, sebebi bilinmeden
 * DURDU ve eklenti bir gün boyunca "yayınlanmayı bekliyor" sanıldı.
 *
 * SESSİZ OLSAYDI DAHA KÖTÜYDÜ: `class-updater.php` yeni sürümü `WPTESLIMAT_VERSION` ile
 * karşılaştırır (`version_compare($new, WPTESLIMAT_VERSION, '<=')`). Sabit geride kalırsa
 * müşteri sitesi güncellemeyi kurar, sabit hâlâ eski sürümü söyler → panel siteyi ESKİ
 * sürümde görür ve güncelleyici aynı güncellemeyi SONSUZA KADAR yeniden önerir.
 *
 * NE DENETLER: üç yazım birbirine EŞİT ve SemVer olmalı. `readme.txt` changelog'unda o sürüm
 * için bir başlık (`= X.Y.Z =`) bulunması da beklenir — sürüm yükseltilip changelog'a satır
 * yazılmaması, müşteri güncelleme ekranında BOŞ "Yenilikler" demektir.
 *
 * Kullanım: node scripts/check-plugin-version.js   (çıkış 0 temiz · 1 sapma)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PHP = path.join(ROOT, 'apps/wp-plugin/wpteslimat/wpteslimat.php');
const README = path.join(ROOT, 'apps/wp-plugin/wpteslimat/readme.txt');

const sorunlar = [];
function fail(msg) {
  sorunlar.push(msg);
}

/** Tek eşleşme bekler: yoksa/çoklanmışsa SESSİZ geçmez, sapma sayılır. */
function tek(dosya, metin, kalip, ad) {
  const m = metin.match(kalip);
  if (!m) {
    fail(`${ad} bulunamadı (${path.relative(ROOT, dosya)}). Kalıp değiştiyse kapıyı güncelleyin.`);
    return null;
  }
  return m[1].trim();
}

if (!fs.existsSync(PHP) || !fs.existsSync(README)) {
  console.error('\n✗ check-plugin-version: eklenti dosyaları bulunamadı.');
  process.exit(1);
}

const php = fs.readFileSync(PHP, 'utf8');
const readme = fs.readFileSync(README, 'utf8');

const baslik = tek(PHP, php, /^\s*\*\s*Version:\s*(.+)$/m, "eklenti başlığı 'Version:'");
const sabit = tek(
  PHP,
  php,
  /define\('WPTESLIMAT_VERSION',\s*'([^']*)'\)/,
  'WPTESLIMAT_VERSION sabiti',
);
const stable = tek(README, readme, /^Stable tag:\s*(.+)$/m, "readme.txt 'Stable tag:'");

const SEMVER = /^\d+\.\d+\.\d+$/;
for (const [ad, deger] of [
  ['başlık', baslik],
  ['WPTESLIMAT_VERSION', sabit],
  ['Stable tag', stable],
]) {
  if (deger !== null && !SEMVER.test(deger)) fail(`${ad} SemVer değil: '${deger}'`);
}

if (baslik !== null && sabit !== null && stable !== null) {
  const kume = new Set([baslik, sabit, stable]);
  if (kume.size !== 1) {
    fail(
      `sürüm üç yerde AYNI değil — başlık='${baslik}' · WPTESLIMAT_VERSION='${sabit}' · ` +
        `Stable tag='${stable}'.\n    Üçünü birlikte güncelleyin (scripts/release-plugin.sh ` +
        `üçünü de sed'ler); yalnız birini değiştirmek yayını DURDURUR ve müşteri sitesinde ` +
        `sonsuz "güncelleme var" döngüsü üretir.`,
    );
  } else if (!readme.includes(`= ${baslik} =`)) {
    fail(
      `readme.txt changelog'unda '= ${baslik} =' başlığı yok — müşteri güncelleme ekranında ` +
        `"Yenilikler" BOŞ görünür.`,
    );
  }
}

if (sorunlar.length) {
  console.error('\n✗ check-plugin-version:\n  ' + sorunlar.join('\n  '));
  process.exit(1);
}
console.log(
  `✓ check-plugin-version: eklenti sürümü v${baslik} — başlık · sabit · Stable tag · changelog tutarlı.`,
);
