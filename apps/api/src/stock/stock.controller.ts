import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { StockService } from './stock.service';

const ImportBody = z.object({
  productId: z.string().uuid(),
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

/** Admin: şifreli stok import. */
@Controller('admin/stock')
@UseGuards(AdminGuard)
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('import')
  import(@Body(new ZodBody(ImportBody)) body: ImportBody) {
    return this.stock.import(body.productId, body.items);
  }

  @Get(':productId/available')
  async available(@Param('productId') productId: string) {
    return { productId, available: await this.stock.availableCount(productId) };
  }
}
