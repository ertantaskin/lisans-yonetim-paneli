import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { PurchaseOrdersService } from './purchase-orders.service';

const CreatePoBody = z.object({
  supplierId: z.string().uuid(),
  productId: z.string().uuid(),
  // Oluştururken yalnız draft veya ordered (partial/received teslim almayla oluşur).
  status: z.enum(['draft', 'ordered']).default('draft'),
  qtyOrdered: z.number().int().positive(),
  unitCostCents: z.number().int().nonnegative().optional(),
  currency: z.string().min(1).max(8).optional(),
  eta: z.string().datetime().optional(),
  notes: z.string().optional(),
});
type CreatePoBody = z.infer<typeof CreatePoBody>;

const UpdatePoBody = z.object({
  status: z.enum(['draft', 'ordered', 'partial', 'received', 'cancelled']).optional(),
  eta: z.string().datetime().nullable().optional(),
  notes: z.string().nullable().optional(),
});
type UpdatePoBody = z.infer<typeof UpdatePoBody>;

const ReceiveBody = z.object({
  qty: z.number().int().positive(),
  batchLabel: z.string().min(1),
  notes: z.string().optional(),
});
type ReceiveBody = z.infer<typeof ReceiveBody>;

/** Admin: satın alma emri yönetimi (§12). ADMIN_TOKEN gerektirir. */
@Controller('admin/purchase-orders')
@UseGuards(AdminGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  @Get()
  list() {
    return this.purchaseOrders.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.purchaseOrders.getById(id);
  }

  @Post()
  create(@Body(new ZodBody(CreatePoBody)) body: CreatePoBody) {
    return this.purchaseOrders.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdatePoBody)) body: UpdatePoBody,
  ) {
    return this.purchaseOrders.update(id, body);
  }

  /** Teslim al: kısmi teslim destekli (kabul = min(qty, kalan)); yeni parti açar. */
  @Post(':id/receive')
  receive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ReceiveBody)) body: ReceiveBody,
  ) {
    return this.purchaseOrders.receive(id, body);
  }
}
