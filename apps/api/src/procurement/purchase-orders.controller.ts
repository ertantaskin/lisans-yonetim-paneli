import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { PurchaseOrdersService } from './purchase-orders.service';

const CreatePoBody = z.object({
  supplierId: z.string().uuid(),
  productId: z.string().uuid(),
  // Oluştururken yalnız draft veya ordered (partial/received teslim almayla oluşur).
  status: z.enum(['draft', 'ordered']).default('draft'),
  // Üst sınırlar int4 taşmasına karşı (PG kolonları `integer`): sınırsız girdi 2147483647
  // üstünde PG 22003 ile 500 üretirdi; artık kullanıcı 400 alır.
  // qtyOrdered: stok import tavanıyla (stock.controller count max 1_000_000) hizalı.
  qtyOrdered: z.number().int().positive().max(1_000_000),
  unitCostCents: z.number().int().nonnegative().max(2_000_000_000).optional(),
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
  // Kabul edilen adet servis tarafında min(qty, kalan) ile zaten kırpılır (int4 taşması YOK),
  // yine de qtyOrdered ile aynı tavan: absürt girdi doğrulamada 400 alsın, aritmetiğe girmesin.
  qty: z.number().int().positive().max(1_000_000),
  batchLabel: z.string().min(1),
  notes: z.string().optional(),
});
type ReceiveBody = z.infer<typeof ReceiveBody>;

/** Admin: satın alma emri yönetimi (§12). ADMIN_TOKEN gerektirir. */
@Controller('admin/purchase-orders')
@UseGuards(AdminGuard)
export class PurchaseOrdersController {
  constructor(private readonly purchaseOrders: PurchaseOrdersService) {}

  /**
   * SÖZLEŞME DEĞİŞTİ (denetim R3): yanıt artık DÜZ DİZİ değil `{ items, truncated }` zarfı.
   * Liste tavana (PurchaseOrdersService.LIST_LIMIT) dayandığında `truncated=true` döner ve
   * arayüz "liste eksik" uyarısını basmalıdır — sessiz kırpma bu projede yasak.
   */
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

  /**
   * Teslim al: kısmi teslim destekli (kabul = min(qty, kalan)); yeni parti açar.
   *
   * AKTÖR (denetim bulgusu): servis denetim kaydına sabit 'panel:admin' yazıyordu, yani
   * audit_log "teslim alan kim" sorusuna cevap VERMİYORDU — oysa jsdoc'u aktörün düştüğünü
   * söylüyordu. Çoklu-admin (§8) canlı; stok girişi/düzeltme uçları çoktan @AdminActor
   * kullanıyor, bu uç atlanmıştı.
   */
  @Post(':id/receive')
  receive(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(ReceiveBody)) body: ReceiveBody,
    @AdminActor() actor: string,
  ) {
    return this.purchaseOrders.receive(id, body, actor);
  }
}
