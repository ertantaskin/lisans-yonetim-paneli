import { sql, type SQL } from 'drizzle-orm';

/**
 * "AYAKTA" (canlı) ATAMA STATÜLERİ — raporların TEK KAYNAĞI.
 *
 * NEDEN VAR (denetim bulgusu R4): aynı kavram panelde en az BEŞ yerde elle yazılmıştı
 * (`maintenance/reconcile.service.ts` özel `STANDING_STATUSES`, `reports.service.ts`
 * velocity, `reorder.service.ts` sales, `products.service.ts`…). Kopyalardan biri
 * (`costs.service.ts` deliveredCogs) yalnız `'active'` sayıyordu → AYNI EKRANDA velocity
 * "şu kadar birim satıldı" derken maliyet raporu daha az birimin COGS'unu gösteriyordu.
 *
 * TANIM (reconcile.service.ts'teki gerekçenin aynısı):
 *   • `active`    — müşteride, çalışıyor.
 *   • `suspended` — müşteride ama GEÇİCİ olarak gizlenmiş (§4). Teslim EDİLMİŞTİR; iade
 *     değildir (revoke ayrı bir statüdür) → teslimat/maliyet defterinden düşmez.
 *   • `expired`   — süreli hesabın ömrü doldu. Yine TESLİM EDİLMİŞTİ ve §2 gereği "hak geri
 *     gelmez" (kalem havuza dönmez, kapasite iade edilmez) → maliyeti oluşmuştur.
 * HARİÇ: `revoked` (gerçek iade — §2) ve `replaced` (değişimde net'lenen eski atama);
 * ikisi de sayılırsa iade edilen/değiştirilen anahtar hem satış hem maliyet olarak
 * ÇİFT görünür.
 *
 * KAPSAM NOTU (entegratöre): bu sabitin GERÇEK yeri `assignment/assign.ts`'tir
 * (`notExpiredCond` ile aynı gerekçe) ve `reconcile.service.ts` de oradan import etmelidir.
 * Bu denetim partisinde o iki dosya BAŞKA işçilerde olduğu için sabit geçici olarak
 * `reports/` altında tanımlandı; taşınması raporda ayrıca istendi.
 */
export const STANDING_STATUSES: SQL = sql`('active', 'suspended', 'expired')`;
