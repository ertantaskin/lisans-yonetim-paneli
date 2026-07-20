import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { StockService } from './stock.service';

const ImportBody = z.object({
  productId: z.string().uuid(),
  /** Opsiyonel parti bağlama (§12): verilirse tüm satırlar bu batch'e yazılır (recall/toplu-değiştir). */
  batchId: z.string().uuid().optional(),
  items: z
    .array(
      z.object({
        // key/code/custom: düz string. account: alan→değer nesnesi (veya JSON string).
        payload: z.union([z.string().min(1), z.record(z.string(), z.unknown())]),
        expiresAt: z.string().datetime().optional(),
      }),
    )
    .min(1)
    .max(10_000),
});
type ImportBody = z.infer<typeof ImportBody>;

const PreviewBody = z.object({
  productId: z.string().uuid(),
  // Girilecek/tahmini stok adedi — önizleme salt-okunur, üst sınırı import ile aynı tutulur.
  count: z.number().int().min(0).max(1_000_000),
});
type PreviewBody = z.infer<typeof PreviewBody>;

/** Admin: şifreli stok import. */
@Controller('admin/stock')
@UseGuards(AdminGuard)
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('import')
  import(@Body(new ZodBody(ImportBody)) body: ImportBody) {
    return this.stock.import(body.productId, body.items, body.batchId);
  }

  /** "Onayla ve Dağıt" önizleme (§13): bu giriş bekleyen talebi ne kadar karşılar. */
  @Post('preview')
  preview(@Body(new ZodBody(PreviewBody)) body: PreviewBody) {
    return this.stock.preview(body.productId, body.count);
  }

  @Get(':productId/available')
  async available(@Param('productId') productId: string) {
    return { productId, available: await this.stock.availableCount(productId) };
  }
}
