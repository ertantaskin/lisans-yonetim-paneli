import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
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
import { ProductCategoriesService } from './product-categories.service';
import { ProductGuidesService } from './product-guides.service';
import { KEY_FORMAT_MAX_LENGTH, checkKeyFormatSafety } from '../stock/stock.service';

/**
 * `keyFormat` = operatörün yazdığı SERBEST düzenli ifade; stok girişinde 10.000'e kadar
 * payload'a karşı SENKRON test edilir ve Node'da regex için zaman aşımı YOKTUR. Eskiden bu
 * alan yalnız `z.string().optional()` idi: ne uzunluk tavanı ne desen denetimi vardı →
 * katastrofik geri-izlemeli tek bir desen (`^(a+)+$`) event loop'unu üstel süre bloklayıp
 * TÜM API'yi (sipariş teslimatı dahil) donduruyordu.
 *
 * Doğrulama artık KAYDETME ANINDA yapılır (import anında değil): uzunluk tavanı + gerçek
 * `new RegExp` derleme denemesi + katastrofik kalıp sezgisi. Kural TEK KAYNAKTAN gelir
 * (`checkKeyFormatSafety`, stock.service) — deseni derleyip çalıştıran yer ile kabul eden
 * yerin kuralı ayrışamaz. Sezgi TEMKİNLİdir; yanlış-pozitifte operatör ne yapması gerektiğini
 * söyleyen Türkçe mesajı 400 ile görür (sessiz reddetme yok). CREATE ve UPDATE şemalarının
 * İKİSİ de bu alanı kullanır — biri atlanırsa güncelleme yolu açık kalırdı.
 */
const KeyFormatPattern = z
  .string()
  .max(KEY_FORMAT_MAX_LENGTH, `Anahtar biçimi en fazla ${KEY_FORMAT_MAX_LENGTH} karakter olabilir.`)
  .superRefine((value, ctx) => {
    const reason = checkKeyFormatSafety(value);
    if (reason) ctx.addIssue({ code: z.ZodIssueCode.custom, message: reason });
  });

/*
 * SAYISAL ÜST SINIRLAR — gerekçe (aynı üslup: procurement/purchase-orders.controller.ts:16).
 *
 * PG kolonları `integer` (int4): sınırsız girdi 2.147.483.647 üstünde 22003 ile ham 500
 * üretirdi. Ama asıl tehlike taşma DEĞİL, TAŞMAYAN absürt değerlerdir — ÖLÇÜLDÜ:
 * `validityDays = 5e8` int4'e RAHATÇA sığar, ürün kaydı BAŞARILI olur ve arıza günler sonra,
 * o ürüne gelen ilk siparişte patlar: teslimat `now + gün` hesabı Invalid Date üretir,
 * `toISOString()` RangeError atar → mağazanın sipariş push'u 500 alır (yani hata,
 * yapılandırmayı yapan ekranda değil, para kazandıran yolda görünür).
 *
 * Bu yüzden sınırlar int4 tavanı değil, İŞ ANLAMI taşıyan değerlerdir.
 */
/**
 * 10 yıl. Tarihe çevrilen alanların (teslimde başlayan geçerlilik, garanti penceresi) tavanı:
 * bu panelde satılan hiçbir dijital ürünün ömrü/garantisi 10 yılı aşmaz ("süresiz" isteniyorsa
 * alan BOŞ bırakılır — null zaten "süre yok" demektir). `now + 3650 gün` her zaman geçerli bir
 * Date'tir, yani yukarıdaki gecikmeli arıza sınıfı tamamen kapanır.
 */
const MAX_DAYS = 3650;
/**
 * Anahtar başına kullanım hakkı (MAK). Gerçek MAK anahtarları birkaç bin aktivasyon taşır;
 * 100.000 fazlasıyla pay bırakır ama "1 anahtar = 2 milyar birim" gibi tek satırla tüm stok
 * sayaçlarını (Σ max_uses − use_count) anlamsızlaştıran girdiyi engeller.
 */
const MAX_USES_CAP = 100_000;
/**
 * Düşük stok eşiği + benzeri adet alanları. Stok girişi tavanıyla (stock.controller count
 * max 1.000.000) hizalı: erişilebilecek en yüksek stok adedinden büyük bir eşik zaten
 * "her zaman uyarı ver" demektir.
 */
const MAX_QTY = 1_000_000;

// Ürün alan tabanı — refine'sız düz nesne, böylece update için .partial() türetilebilir
// (ZodEffects/refined şema .partial() vermez).
const ProductObject = z.object({
  sku: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['key', 'account', 'custom', 'code']).default('key'),
  usageMode: z.enum(['single', 'multi']).default('single'),
  maxUses: z.number().int().positive().max(MAX_USES_CAP).optional(),
  validityDays: z.number().int().positive().max(MAX_DAYS).optional(),
  /** Süreli hesapta süre bitince davranış (§11). */
  onExpiry: z.enum(['hide', 'keep']).default('hide'),
  /** Hesap ürünü (kind=account) alan şeması — {username,password,...}. */
  payloadSchema: AccountPayloadSchema.optional(),
  fulfillmentPolicy: z
    .enum(['partial-auto', 'partial-approval', 'all-or-nothing'])
    .default('partial-auto'),
  warrantyDays: z.number().int().nonnegative().max(MAX_DAYS).optional(),
  /** Anahtar biçimi (regex) — ReDoS kapısı için bkz. `KeyFormatPattern`. */
  keyFormat: KeyFormatPattern.optional(),
  /** null/omit = düşük-stok uyarısı KAPALI; >=0 ise eşik (§12). */
  lowStockThreshold: z.number().int().nonnegative().max(MAX_QTY).optional(),
  /** Stoksuz/ön-sipariş: pending akış, release_at'te teslim (§11). */
  stockless: z.boolean().default(false),
  releaseAt: z.string().datetime().optional(),
  /**
   * Kategori (§17): `/stock` giriş ekranı bunun üzerinden gruplanır. Serbest METİN DEĞİL —
   * `product_categories` kaydının id'si (kullanıcı kararı: ad tek yerden yönetilsin, ikiz
   * kategori olmasın). null/boş = Kategorisiz (geçerli bir durum, ürün gizlenmez).
   */
  categoryId: z.string().uuid().nullable().optional(),
  /**
   * Kurulum / etkinleştirme rehberi (§7): `product_guides` kaydının id'si. Metin ürüne
   * GÖMÜLMEZ — aynı anlatı onlarca SKU'da ortaktır ve tek yerden düzeltilebilmelidir.
   * null/boş = rehber yok (geçerli durum; her ürün talimat gerektirmez).
   */
  guideId: z.string().uuid().nullable().optional(),
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
    // ÜST SINIRLAR CREATE ile BİREBİR aynı olmalı: bu blok `.partial()` alanlarının ÜZERİNE
    // yazar (`.extend`), yani sınır burada tekrarlanmazsa CREATE'te kapatılan kapı PATCH ile
    // açık kalırdı — `keyFormat` ReDoS kapısında da aynı gerekçe yazılı.
    validityDays: z.number().int().positive().max(MAX_DAYS).nullable().optional(),
    warrantyDays: z.number().int().nonnegative().max(MAX_DAYS).nullable().optional(),
    lowStockThreshold: z.number().int().nonnegative().max(MAX_QTY).nullable().optional(),
    // CREATE ile AYNI ReDoS kapısı (bkz. `KeyFormatPattern`) + güncellemeye özgü `null`
    // ("alanı temizle"). Kapı yalnız CREATE'e konsaydı riskli desen PATCH ile girebilirdi.
    keyFormat: KeyFormatPattern.nullable().optional(),
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
  // Üst sınır site-mappings.controller ile HİZALI (.max(1000)) — denetim LOW: sınırsız bundleQty
  // sipariş satırını ×N lisansla teslim eder (aşırı-teslim DoS / stok yanması). İki yazar aynı kolonu
  // (site_product_mappings.bundle_qty) beslediğinden doğrulama da tek üst sınırda buluşmalı.
  bundleQty: z.number().int().min(1).max(1000).optional(),
});
type CreateMappingBody = z.infer<typeof CreateMappingBody>;

// Eşleme kısmi güncelleme: aktif/pasif toggle VE/VEYA hedef panel ürününü değiştir (remap) + bundle.
// En az bir alan zorunlu (boş PATCH anlamsız). Eşleme her zaman elle — otomatik değişim yok.
const UpdateMappingBody = z
  .object({
    active: z.boolean().optional(),
    productId: z.string().uuid().optional(),
    // Üst sınır site-mappings.controller ile HİZALI (.max(1000)) — denetim LOW: sınırsız bundleQty
  // sipariş satırını ×N lisansla teslim eder (aşırı-teslim DoS / stok yanması). İki yazar aynı kolonu
  // (site_product_mappings.bundle_qty) beslediğinden doğrulama da tek üst sınırda buluşmalı.
  bundleQty: z.number().int().min(1).max(1000).optional(),
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
  constructor(
    private readonly products: ProductsService,
    private readonly categories: ProductCategoriesService,
    private readonly guides: ProductGuidesService,
  ) {}

  @Post('products')
  async create(@Body(new ZodBody(CreateProductBody)) body: CreateProductBody) {
    await this.assertCategoryExists(body.categoryId);
    await this.assertGuideExists(body.guideId);
    return this.products.create(this.toDbInput(body));
  }

  @Get('products')
  list() {
    return this.products.list();
  }

  // ParseUUIDPipe (denetim): bozuk id ile gelen istek eskiden sorguya kadar gidip PG 22P02
  // (invalid_text_representation) ile ham 500 üretiyordu; artık 400 döner. Aynı desen:
  // notifications.controller / customers.controller / audit.controller.
  @Patch('products/:id')
  async update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateProductBody)) body: UpdateProductBody,
  ) {
    await this.assertCategoryExists(body.categoryId);
    await this.assertGuideExists(body.guideId);
    return this.products.update(id, this.toDbInput(body));
  }

  /**
   * Var olmayan kategori id'si → ham Postgres FK ihlali (23503) → opak 500 olurdu.
   * createMapping deseni: önce varlığı çöz, yoksa anlamlı 404. null/undefined = kategorisiz.
   */
  private async assertCategoryExists(categoryId?: string | null) {
    if (!categoryId) return;
    const all = await this.categories.list();
    if (!all.some((c) => c.id === categoryId)) {
      throw new NotFoundException('Kategori bulunamadı');
    }
  }

  /**
   * Kategori ile AYNI gerekçe: var olmayan rehber id'si opak 500 değil, anlamlı 404 vermeli.
   * `list()` DEĞİL `exists()` — liste tüm rehber gövdelerini (4.000 karakter × N) ve ürün-adı
   * agregasyonunu çeker; burada sorulan tek şey id'nin var olup olmadığıdır.
   */
  private async assertGuideExists(guideId?: string | null) {
    if (!guideId) return;
    if (!(await this.guides.exists(guideId))) {
      throw new NotFoundException('Kurulum rehberi bulunamadı');
    }
  }

  /** Ürün detay panosu (§13): stok kırılımı + parti + PO + satış hızı + düzeltmeler. */
  @Get('products/:id/detail')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
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
