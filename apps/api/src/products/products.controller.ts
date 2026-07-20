import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AccountPayloadSchema } from '@jetlisans/shared';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { ProductsService } from './products.service';

const CreateProductBody = z
  .object({
    sku: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['key', 'account', 'custom', 'code']).default('key'),
    usageMode: z.enum(['single', 'multi']).default('single'),
    maxUses: z.number().int().positive().optional(),
    validityDays: z.number().int().positive().optional(),
    /** Süreli hesapta süre bitince davranış (§11). */
    onExpiry: z.enum(['hide', 'keep']).default('hide'),
    /** Hesap ürünü (kind=account) alan şeması — {username,password,...}. */
    payloadSchema: AccountPayloadSchema.optional(),
    fulfillmentPolicy: z
      .enum(['partial-auto', 'partial-approval', 'all-or-nothing'])
      .default('partial-auto'),
    warrantyDays: z.number().int().nonnegative().optional(),
    keyFormat: z.string().optional(),
    lowStockThreshold: z.number().int().nonnegative().default(0),
  })
  // Çok kullanımlık (MAK) ürünü maxUses>1 ZORUNLU — aksi halde import sessizce
  // kapasite=1'e düşer (MAK anahtarı tek satışta tükenir).
  .refine((b) => b.usageMode !== 'multi' || (b.maxUses != null && b.maxUses > 1), {
    message: "usageMode='multi' için maxUses > 1 zorunlu",
    path: ['maxUses'],
  })
  // Hesap ürünü payloadSchema ZORUNLU — yapılandırılmış payload'ın yaptırımı buna bağlı.
  .refine((b) => b.kind !== 'account' || (b.payloadSchema != null && b.payloadSchema.length > 0), {
    message: "kind='account' için payloadSchema zorunlu",
    path: ['payloadSchema'],
  });
type CreateProductBody = z.infer<typeof CreateProductBody>;

const CreateMappingBody = z.object({
  siteId: z.string().uuid(),
  productId: z.string().uuid(),
  remoteProductId: z.string().min(1),
  remoteVariationId: z.string().optional(),
  bundleQty: z.number().int().positive().optional(),
});
type CreateMappingBody = z.infer<typeof CreateMappingBody>;

/** Admin: ürün + site-ürün eşleme yönetimi. */
@Controller('admin')
@UseGuards(AdminGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post('products')
  create(@Body(new ZodBody(CreateProductBody)) body: CreateProductBody) {
    return this.products.create(body);
  }

  @Get('products')
  list() {
    return this.products.list();
  }

  @Post('mappings')
  createMapping(@Body(new ZodBody(CreateMappingBody)) body: CreateMappingBody) {
    return this.products.createMapping(body);
  }
}
