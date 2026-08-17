/**
 * Sürüm karşılaştırma — /releases ekranının tek kaynağı, **paylaşılan pakete devredildi**.
 *
 * NEDEN BU DOSYA HÂLÂ VAR: `actions.ts` `'use server'` taşır (oradan yalnız async fonksiyon
 * export edilebilir) ve `queries.ts` `server-only`dır; hem sunucu aksiyonunun yayın kapısı hem
 * sayfanın "En yeni" rozeti nötr bir modülden okumak zorunda.
 *
 * NEDEN GÖVDE BURADA DEĞİL: aynı kural API'de de karar veriyor (`updates.service.latest()` →
 * müşteri sitelerinin fiilen indirdiği paket). İki kopya birebir aynıydı, yani sorun bugünkü
 * sonuç değil YARINKİ SAPMAYDI — biri ön-sürüm desteği kazansa panel bir sürümü "en yeni" diye
 * damgalarken siteler başkasını indirir ve hiçbir yerde hata çıkmazdı. Tanım artık
 * `@lisans/shared` → `domain/semver.ts`.
 */
export { compareVersions, highestVersion, parseSemver } from '@lisans/shared';
