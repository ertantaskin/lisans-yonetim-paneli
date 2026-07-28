import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { PendingLinesService } from './pending-lines.service';

/**
 * Gövde: hepsi opsiyonel — hiçbiri verilmezse TÜM eşlemesiz bekleyen satırlar taranır.
 * `remoteVariationId: null` bilinçli olarak "varyasyonsuz (ürün-seviyesi) satırlar" demektir;
 * alan hiç gönderilmezse varyasyon filtresi uygulanmaz (özet ekranındaki grup anahtarı birebir
 * geri gönderilebilsin diye null anlamlıdır).
 */
const ResolveBody = z.object({
  siteId: z.string().uuid().optional(),
  remoteProductId: z.string().min(1).max(255).optional(),
  remoteVariationId: z.string().min(1).max(255).nullish(),
  orderId: z.string().uuid().optional(),
  lineId: z.string().uuid().optional(),
});
type ResolveBody = z.infer<typeof ResolveBody>;

/**
 * Admin: bekleyen (eşlemesiz) satır tanılaması + eşleme-sonrası geriye dönük çözüm (§3/§13).
 * ADMIN_TOKEN gerektirir. Global prefix 'v1' main.ts'te set edilir.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class PendingLinesController {
  constructor(private readonly pendingLines: PendingLinesService) {}

  /** "Neden bekliyor" özeti: site + mağaza ürünü bazında gruplar (mappedNow = tek tıkla çözülür). */
  @Get('pending-lines')
  summary() {
    return this.pendingLines.summary();
  }

  /** Bir siparişin satır satır tanısı (sipariş detayı ekranı) — salt-okunur. */
  @Get('pending-lines/diagnose/:orderId')
  diagnose(@Param('orderId', new ParseUUIDPipe()) orderId: string) {
    return this.pendingLines.diagnose(orderId);
  }

  /**
   * MEVCUT eşlemeleri bekleyen satırlara geriye dönük uygular + teslimatı dener.
   * Yeni eşleme OLUŞTURMAZ (otomatik eşleştirme yok — §3 güvenlik kuralı).
   */
  @Post('pending-lines/resolve')
  resolve(@Body(new ZodBody(ResolveBody)) body: ResolveBody, @AdminActor() actor: string) {
    return this.pendingLines.resolvePending(body, actor);
  }
}
