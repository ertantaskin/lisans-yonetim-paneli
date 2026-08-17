/**
 * Sürüm karşılaştırma — PANEL VE API İÇİN TEK KAYNAK.
 *
 * NEDEN PAYLAŞILAN PAKETTE: bu kural İKİ AYRI KARARI yönetiyor ve ikisi çelişemez —
 *   · API `updates.service.latest()`: müşteri sitelerinin fiilen İNDİRDİĞİ paket,
 *   · Admin `/releases`: "En yeni" rozeti + düşük sürüm yayınlama kapısı.
 * Bir dönem iki AYRI kopya vardı (`apps/admin/app/releases/semver.ts` ve
 * `apps/api/src/updates/updates.service.ts`) ve davranışları birebir aynıydı; yani sorun
 * bugünkü sonuç değil, YARINKİ SAPMAYDI: biri ön-sürüm (`1.2.0-rc1`) desteği kazansa panel
 * bir sürümü "en yeni" diye damgalarken siteler BAŞKA paketi indirmeye devam ederdi ve bu
 * hiçbir yerde hata üretmezdi. Bu kod tabanında "aynı kavramın iki tanımı" tekrarlayan bir
 * arıza sınıfıdır (bkz. CLAUDE.md → Tekrarlayan tuzaklar #4).
 *
 * KURAL: sitelere sunulan paket EN YÜKSEK SEMVER'dir — yayın SIRASI değil. Yeniden yayınlama
 * `created_at`i tazelediği için "en son eklenen" yanıltıcıdır. Geçersiz biçimli sürüm DAİMA
 * en düşük sayılır ki panel uydurma bir "en yeni" damgası basmasın.
 */

/** "major.minor.patch" → sayısal üçlü; biçime uymuyorsa null (geçersiz). */
export function parseSemver(v: string): [number, number, number] | null {
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

/** Listedeki EN YÜKSEK semver (sitelere fiilen sunulan sürüm) — liste boşsa null. */
export function highestVersion(versions: readonly string[]): string | null {
  if (versions.length === 0) return null;
  return versions.reduce((best, v) => (compareVersions(v, best) > 0 ? v : best));
}
