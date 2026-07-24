import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AccountPayloadSchema } from '@jetlisans/shared';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { ProductsService } from './products.service';

// Ürün alan tabanı — refine'sız düz nesne, böylece update için .partial() türetilebilir
// (ZodEffects/refined şema .partial() vermez).
const ProductObject = z.object({
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
  /** null/omit = düşük-stok uyarısı KAPALI; >=0 ise eşik (§12). */
  lowStockThreshold: z.number().int().nonnegative().optional(),
  /** Stoksuz/ön-sipariş: pending akış, release_at'te teslim (§11). */
  stockless: z.boolean().default(false),
  releaseAt: z.string().datetime().optional(),
});

const CreateProductBody = ProductObject
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

// Kısmi güncelleme: tüm alanlar opsiyonel; verilmeyen alan değişmez (default TETİKLENMEZ).
// Opsiyonel alanlar ayrıca .nullable(): admin bir alanı boşaltıp kaydedince (explicit null)
// kolon TEMİZLENİR (unset); alan hiç yoksa değişmez. CREATE (CreateProductBody) etkilenmez —
// yalnız güncelleme yolu null'ı "temizle" olarak kabul eder.
const UpdateProductBody = ProductObject.partial().extend({
  validityDays: z.number().int().positive().nullable().optional(),
  warrantyDays: z.number().int().nonnegative().nullable().optional(),
  lowStockThreshold: z.number().int().nonnegative().nullable().optional(),
  keyFormat: z.string().nullable().optional(),
  releaseAt: z.string().datetime().nullable().optional(),
});
type UpdateProductBody = z.infer<typeof UpdateProductBody>;

const CreateMappingBody = z.object({
  siteId: z.string().uuid(),
  productId: z.string().uuid(),
  remoteProductId: z.string().min(1),
  remoteVariationId: z.string().optional(),
  bundleQty: z.number().int().positive().optional(),
});
type CreateMappingBody = z.infer<typeof CreateMappingBody>;

const UpdateMappingBody = z.object({ active: z.boolean() });
type UpdateMappingBody = z.infer<typeof UpdateMappingBody>;

/** Admin: ürün + site-ürün eşleme yönetimi. */
@Controller('admin')
@UseGuards(AdminGuard)
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Post('products')
  create(@Body(new ZodBody(CreateProductBody)) body: CreateProductBody) {
    return this.products.create(this.toDbInput(body));
  }

  @Get('products')
  list() {
    return this.products.list();
  }

  @Patch('products/:id')
  update(
    @Param('id') id: string,
    @Body(new ZodBody(UpdateProductBody)) body: UpdateProductBody,
  ) {
    return this.products.update(id, this.toDbInput(body));
  }

  /** Ürün detay panosu (§13): stok kırılımı + parti + PO + satış hızı + düzeltmeler. */
  @Get('products/:id/detail')
  detail(@Param('id') id: string) {
    return this.products.getDetail(id);
  }

  @Post('mappings')
  createMapping(@Body(new ZodBody(CreateMappingBody)) body: CreateMappingBody) {
    return this.products.createMapping(body);
  }

  @Patch('mappings/:id')
  updateMapping(
    @Param('id') id: string,
    @Body(new ZodBody(UpdateMappingBody)) body: UpdateMappingBody,
  ) {
    return this.products.updateMapping(id, body.active);
  }

  /**
   * ISO tarih string alanlarını (releaseAt) Date'e çevirir — Drizzle timestamp
   * kolonu Date bekler. Diğer alanlar aynen geçer; verilmeyen alan yok olur.
   * Explicit null (güncellemede "temizle") null olarak geçirilir — new Date(null)
   * epoch üretirdi, o yüzden null ayrı ele alınır.
   */
  private toDbInput<T extends { releaseAt?: string | null }>(body: T) {
    const { releaseAt, ...rest } = body;
    return {
      ...rest,
      ...(releaseAt !== undefined
        ? { releaseAt: releaseAt === null ? null : new Date(releaseAt) }
        : {}),
    };
  }
}
