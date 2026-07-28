import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AccountPayloadSchema } from '@lisans/shared';
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
//
// KRİTİK (denetim bulgusu): bu şema CREATE'in refine'larını TAŞIMIYORDU (.partial() ZodEffects'i
// düşürür) → MAK kapasitesi SESSİZCE kaybolabiliyordu. Senaryo: max_uses=500 MAK ürünü stokta
// 10 anahtarla dururken operatör "Tek kullanımlık"a çevirir; form single modda `maxUses` alanını
// GÖNDERMEZ → ürünün max_uses'i 500 KALIR, ama atama artık single dalına düşer ve anahtarın
// TAMAMINI 'assigned' yapar → anahtar başına 499 birim kapasite KALICI kaybolur (panel hâlâ
// şişik "available" gösterir). Refine'ların eşdeğeri aşağıda; asıl güvenlik kapısı ise
// products.update() içindeki "bu üründe lisans varken usage_mode/max_uses değişmez" 409'udur
// (yalnız gövde doğrulaması yeterli değil — mevcut stoğu şema göremez).
const UpdateProductBody = ProductObject.partial()
  .extend({
    validityDays: z.number().int().positive().nullable().optional(),
    warrantyDays: z.number().int().nonnegative().nullable().optional(),
    lowStockThreshold: z.number().int().nonnegative().nullable().optional(),
    keyFormat: z.string().nullable().optional(),
    releaseAt: z.string().datetime().nullable().optional(),
  })
  // CREATE ile AYNI kural: multi (MAK) ise kapasite >1 olmalı. Kısmi gövdede yalnız
  // `usageMode` GÖNDERİLDİĞİNDE denetlenir (alan yoksa mod değişmiyor demektir).
  .refine((b) => b.usageMode !== 'multi' || (b.maxUses != null && b.maxUses > 1), {
    message: "usageMode='multi' için maxUses > 1 zorunlu (kapasiteyi de gönderin)",
    path: ['maxUses'],
  })
  // Ters yön: single'a dönerken kapasite ya hiç gönderilmez ya da 1'e indirilir. Böylece
  // "single ürün ama max_uses=500" tutarsız durumu gövde seviyesinde de oluşamaz.
  .refine((b) => b.usageMode !== 'single' || b.maxUses == null || b.maxUses === 1, {
    message: "usageMode='single' ürün için maxUses 1 olmalı (ya da hiç gönderilmemeli)",
    path: ['maxUses'],
  })
  // CREATE ile AYNI kural: hesap ürününde alan şeması zorunlu (yapılandırılmış payload
  // yaptırımı buna bağlı — kind='account' gönderilip şema düşürülürse import/teslimat kırılır).
  .refine((b) => b.kind !== 'account' || (b.payloadSchema != null && b.payloadSchema.length > 0), {
    message: "kind='account' için payloadSchema zorunlu",
    path: ['payloadSchema'],
  });
type UpdateProductBody = z.infer<typeof UpdateProductBody>;

const CreateMappingBody = z.object({
  siteId: z.string().uuid(),
  productId: z.string().uuid(),
  remoteProductId: z.string().min(1),
  // "Eşlenmemiş gelen ürünler" tek-tıkla eşleme, varyasyonsuz ürün için null gönderebilir →
  // nullish (service '0'/boş/null → null normalize eder). optional-only olsaydı null 400 yerdi.
  remoteVariationId: z.string().nullish(),
  bundleQty: z.number().int().positive().optional(),
});
type CreateMappingBody = z.infer<typeof CreateMappingBody>;

// Eşleme kısmi güncelleme: aktif/pasif toggle VE/VEYA hedef panel ürününü değiştir (remap) + bundle.
// En az bir alan zorunlu (boş PATCH anlamsız). Eşleme her zaman elle — otomatik değişim yok.
const UpdateMappingBody = z
  .object({
    active: z.boolean().optional(),
    productId: z.string().uuid().optional(),
    bundleQty: z.number().int().positive().optional(),
  })
  .refine(
    (b) => b.active !== undefined || b.productId !== undefined || b.bundleQty !== undefined,
    { message: 'En az bir alan gerekli (active/productId/bundleQty)' },
  );
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

  /** Eşlenmemiş gelen ürünler (§3): gerçek siparişlerde gelmiş ama aktif eşlemesi olmayan
   *  mağaza ürünleri — buradan tek-tıkla eşle (elle ID yazma, typo riski yok). */
  @Get('mappings/unmapped')
  unmappedIncoming() {
    return this.products.listUnmapped();
  }

  /** Site katalog özeti (proaktif eşleme picker'ı): ürün sayısı + son senkron. */
  @Get('catalog/summary')
  catalogSummary() {
    return this.products.catalogSummary();
  }

  /** Bir sitenin senkron kataloğu + eşleme durumu — panelde PROAKTİF eşleme ekranı (§3). */
  @Get('catalog')
  catalog(@Query('siteId', new ParseUUIDPipe()) siteId: string) {
    return this.products.listCatalog(siteId);
  }

  @Patch('mappings/:id')
  updateMapping(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateMappingBody)) body: UpdateMappingBody,
  ) {
    return this.products.updateMapping(id, body);
  }

  /** Eşlemeyi tamamen kaldır (§3) — operatör kontrolünde; ürün artık çözülmez (unmapped→pending). */
  @Delete('mappings/:id')
  deleteMapping(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.products.deleteMapping(id);
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
