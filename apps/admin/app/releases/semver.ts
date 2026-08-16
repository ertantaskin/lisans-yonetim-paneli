/**
 * Sürüm karşılaştırma — /releases ekranının TEK KAYNAĞI.
 *
 * NEDEN AYRI DOSYA: `actions.ts` `'use server'` taşır (oradan yalnız async fonksiyon export
 * edilebilir) ve `queries.ts` `server-only`dır. Hem sunucu aksiyonunun yayın kapısı hem
 * sayfanın "En yeni" rozeti aynı sıralamayı kullanmak zorunda; iki kopya tutmak bu ekranda
 * zaten yaşanan sapmayı (rozet bir sürümü "en yeni" derken sitelere BAŞKA sürüm sunuluyor)
 * yeniden üretirdi.
 *
 * SIRALAMA KURALI, API İLE BİREBİR: `updates.service.ts` → `compareVersions`. Sitelere sunulan
 * paket `latest()` ile EN YÜKSEK SEMVER'dir (yayın SIRASI değil). Geçersiz biçimli sürüm daima
 * en düşük sayılır — panelin uydurma "en yeni" damgası basmaması için.
 */

/** "major.minor.patch" → sayısal üçlü; biçime uymuyorsa null (geçersiz). */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** a>b → +1, a<b → -1, eşit → 0. Geçersiz biçim daima daha düşük; iki geçersizde 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! > pb[i]! ? 1 : -1;
  }
  return 0;
}

/**
 * Listedeki EN YÜKSEK semver (sitelere fiilen sunulan sürüm) — liste boşsa null.
 * `rows[0]` KULLANILMAZ: liste `created_at DESC` gelir ve yeniden yayınlama `created_at`i
 * tazelediği için en üstteki satır eski bir sürüm olabilir.
 */
export function highestVersion(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}
