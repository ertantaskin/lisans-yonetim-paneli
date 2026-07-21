import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { SupplyOpsService } from './supply-ops.service';

const RecallBody = z.object({ reason: z.string().min(1) });
type RecallBody = z.infer<typeof RecallBody>;

const BulkReplaceBody = z.object({ actor: z.string().min(1).optional() });
type BulkReplaceBody = z.infer<typeof BulkReplaceBody>;

const CreateAdjustmentBody = z.object({
  productId: z.string().uuid(),
  licenseItemId: z.string().uuid().optional(),
  action: z.enum(['void', 'damage', 'correct', 'recall']),
  qty: z.number().int().nonnegative().default(0),
  reason: z.string().min(1),
});
type CreateAdjustmentBody = z.infer<typeof CreateAdjustmentBody>;

/**
 * Admin: tedarik operasyonları (§12) — parti geri çekme + sebepli stok düzeltme.
 * ADMIN_TOKEN gerektirir. Kritik aksiyonlar sebep + audit ile yazılır.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class SupplyOpsController {
  constructor(private readonly supplyOps: SupplyOpsService) {}

  @Get('batches')
  listBatches() {
    return this.supplyOps.listBatches();
  }

  @Post('batches/:id/recall')
  recall(
    @Param('id') id: string,
    @Body(new ZodBody(RecallBody)) body: RecallBody,
    @AdminActor() actor: string,
  ) {
    return this.supplyOps.recallBatch(id, body.reason, actor);
  }

  /**
   * Toplu değiştirme (§13): partiye ait satılmış + aktif atamalı kalemleri MEVCUT değişim
   * makinesiyle yenisiyle değiştirir (stok olmayanı atlar). Dön: { total, replaced, skippedNoStock }.
   */
  @Post('batches/:id/bulk-replace')
  bulkReplace(
    @Param('id') id: string,
    @Body(new ZodBody(BulkReplaceBody)) body: BulkReplaceBody,
    @AdminActor() actor: string,
  ) {
    // actor artık oturumdan (x-admin-actor header) gelir; body.actor legacy/yok sayılır.
    void body;
    return this.supplyOps.bulkReplaceBatch(id, actor);
  }

  @Post('stock-adjustments')
  createAdjustment(
    @Body(new ZodBody(CreateAdjustmentBody)) body: CreateAdjustmentBody,
    @AdminActor() actor: string,
  ) {
    return this.supplyOps.createAdjustment(body, actor);
  }

  @Get('stock-adjustments')
  listAdjustments(@Query('productId') productId?: string) {
    return this.supplyOps.listAdjustments(productId);
  }
}
