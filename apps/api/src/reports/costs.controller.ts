import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { CostsService, type CostReport } from './costs.service';

/**
 * Query süzgeci doğrulayıcısı — `audit.controller` / `admin-orders.controller` ile BİREBİR
 * aynı desen. BOŞ string ("?from=") "süzgeç temizlendi" sayılır (admin UI seçimi sıfırlarken
 * boş parametre gönderir); dolu ise KURALA uymak zorunda.
 */
const blankOr = (check: (s: string) => boolean, message: string) =>
  z
    .string()
    .max(64)
    .refine((s) => s === '' || check(s), message)
    .optional();

/**
 * `GET /v1/admin/reports/costs` süzgeçleri (zaman penceresi, denetim bulgusu O7).
 *
 * NEDEN AÇIK 400: ayrıştırılamayan bir tarih sessizce yok sayılsaydı operatör kapsamı
 * daralttığını sanarken pencereye HİÇ girmemiş (varsayılan) bir rapora bakardı — bu projede
 * "sessiz süzgeç kaybı" yasak. Servis ayrıca kendi içinde savunmalı davranır (bozuk değer =
 * o sınır uygulanmaz), yani doğrudan servis çağıran testler/işler patlamaz.
 */
export const CostReportQuerySchema = z.object({
  /** ISO tarih/zaman ya da `YYYY-MM-DD` (gün başı olarak yorumlanır). */
  from: blankOr((s) => !Number.isNaN(Date.parse(s)), 'from geçerli bir tarih olmalı'),
  /** ISO tarih/zaman ya da `YYYY-MM-DD` (gün SONU olarak yorumlanır). */
  to: blankOr((s) => !Number.isNaN(Date.parse(s)), 'to geçerli bir tarih olmalı'),
  /** '1' | 'true' → tüm zamanlar (hiçbir tarih sınırı uygulanmaz). */
  all: blankOr((s) => ['1', 'true', '0', 'false'].includes(s), "all yalnız '1' ya da '0' olabilir"),
});
type CostReportQuery = z.infer<typeof CostReportQuerySchema>;

/** '' / boşluk → undefined (süzgeç yok). */
const trimmed = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/**
 * Admin: maliyet raporu (salt-okunur agregasyon, §12/§13). KÂR değil, yalnız
 * MALİYET (PO unit_cost); para birimleri AYRI raporlanır, karıştırılmaz. Prefix
 * ReportsController ile ortak ('admin/reports') ancak route farklı ('costs') —
 * Nest çakışma yaşamaz.
 *
 * ZAMAN PENCERESİ: parametre verilmezse servis VARSAYILAN pencereyi (son 12 ay) uygular ve
 * uyguladığı pencereyi yanıtın `window` alanında DÖNDÜRÜR — ekran bunu yazar (sessiz
 * daraltma yok). Gerekçe: `costs.service.ts` içindeki `CostWindow` jsdoc'u.
 */
@Controller('admin/reports')
@UseGuards(AdminGuard)
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  /** Maliyet raporu: tedarikçi/ay/ürün harcaması + stok değerleme + fire + teslim COGS. */
  @Get('costs')
  async getCostReport(
    @Query(new ZodBody(CostReportQuerySchema)) query: CostReportQuery,
  ): Promise<CostReport> {
    const all = trimmed(query.all);
    return this.costs.getCostReport({
      from: trimmed(query.from),
      to: trimmed(query.to),
      allTime: all === '1' || all === 'true',
    });
  }
}
