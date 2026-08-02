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
import { AdminGuard } from '../auth/admin.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminRole, canRevealPlaintext } from '../auth/admin-role.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { LICENSE_ITEM_STATUSES, StockService } from './stock.service';

const ImportBody = z.object({
  productId: z.string().uuid(),
  /** Opsiyonel parti bağlama (§12): verilirse tüm satırlar bu batch'e yazılır (recall/toplu-değiştir). */
  batchId: z.string().uuid().optional(),
  /** Kuru çalıştırma (§7): true ise yalnız DOĞRULA + önizleme raporu — hiçbir şey commit edilmez. */
  dryRun: z.boolean().optional(),
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

/**
 * Query string'de boş değer ("?siteId=") = "filtre yok" demektir → literal '' AÇIKÇA kabul
 * edilir (uuid/enum doğrulamasına düşüp 400 üretmesin) ve aşağıda undefined'a çevrilir.
 * NOT: z.preprocess/z.coerce BİLEREK kullanılmıyor — ikisi de şemanın girdi tipini `unknown`
 * yapar ve `ZodBody<T>` (ZodSchema<T>, girdi=çıktı) ile tip uyuşmazlığı üretir.
 */
const optionalUuid = z.union([z.literal(''), z.string().uuid()]).optional();
const optionalDigits = z.union([z.literal(''), z.string().regex(/^\d{1,7}$/)]).optional();

/** Lisans envanteri listesi (§13) — hepsi opsiyonel; hiçbiri verilmezse GLOBAL son eklenenler. */
const ListLicenseItemsQuery = z.object({
  productId: optionalUuid,
  siteId: optionalUuid,
  batchId: optionalUuid,
  status: z.union([z.literal(''), z.enum(LICENSE_ITEM_STATUSES)]).optional(),
  search: z.string().max(120).optional(),
  page: optionalDigits,
  // Servis 25/50/100'e KIRPAR (en yakın izinli) — burada yalnız rakam olduğu doğrulanır.
  pageSize: optionalDigits,
  sort: z
    .union([z.literal(''), z.enum(['created_desc', 'created_asc', 'assigned_desc'])])
    .optional(),
});
type ListLicenseItemsQuery = z.infer<typeof ListLicenseItemsQuery>;

/** Tekil iptal: sebep ZORUNLU (§12 "sebepsiz stok değişikliği yok"). */
const VoidLicenseItemBody = z.object({ reason: z.string().trim().min(1).max(500) });
type VoidLicenseItemBody = z.infer<typeof VoidLicenseItemBody>;

/** Tekil düzenleme: key ürününde `value`, account ürününde `fields`; sebep her hâlükârda zorunlu. */
const UpdateLicenseItemBody = z
  .object({
    value: z.string().min(1).max(4_000).optional(),
    fields: z.record(z.string(), z.string()).optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .refine((b) => b.value != null || b.fields != null, {
    message: 'Yeni lisans değeri (`value`) veya hesap alanları (`fields`) verilmelidir.',
  });
type UpdateLicenseItemBody = z.infer<typeof UpdateLicenseItemBody>;

/**
 * Admin: şifreli stok import + lisans envanteri (§12/§13).
 * Prefix bilerek 'admin': stok yolları 'admin/stock/*' olarak KORUNUR (mevcut sözleşme
 * değişmez), lisans envanteri ise kaynak-adına uygun 'admin/license-items' altında durur.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class StockController {
  constructor(private readonly stock: StockService) {}

  @Post('stock/import')
  import(
    @Body(new ZodBody(ImportBody)) body: ImportBody,
    @AdminActor() actor: string,
    @Query('dryRun') dryRunQuery?: string,
  ) {
    // Kuru çalıştırma (§7): body.dryRun VEYA ?dryRun=true|1 → yalnız doğrula, commit etme.
    const dryRun = body.dryRun === true || dryRunQuery === 'true' || dryRunQuery === '1';
    // Eylemi yapan admin (x-admin-actor) audit'e düşürülür — 'panel:admin' sabiti yerine gerçek aktör.
    return this.stock.import(body.productId, body.items, body.batchId, dryRun, actor);
  }

  /** "Onayla ve Dağıt" önizleme (§13): bu giriş bekleyen talebi ne kadar karşılar. */
  @Post('stock/preview')
  preview(@Body(new ZodBody(PreviewBody)) body: PreviewBody) {
    return this.stock.preview(body.productId, body.count);
  }

  @Get('stock/:productId/available')
  async available(@Param('productId') productId: string) {
    return { productId, available: await this.stock.availableCount(productId) };
  }

  // ─── Lisans envanteri (§13) ─────────────────────────────────────────────────────────
  /**
   * Lisans/anahtar listesi: ürün-bazlı (?productId=) veya GLOBAL (parametresiz).
   * Arama + durum/site/parti süzgeci + sayfalama. TAM lisans döner (admin) → her
   * görüntüleme TEK 'reveal' audit kaydına düşer.
   */
  @Get('license-items')
  listLicenseItems(
    @Query(new ZodBody(ListLicenseItemsQuery)) query: ListLicenseItemsQuery,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    // Boş string ('' = filtre yok) → undefined; sayısal alanlar burada Number'a çevrilir.
    return this.stock.listLicenseItems(
      {
        productId: query.productId || undefined,
        siteId: query.siteId || undefined,
        batchId: query.batchId || undefined,
        status: query.status || undefined,
        search: query.search || undefined,
        page: query.page ? Number(query.page) : undefined,
        pageSize: query.pageSize ? Number(query.pageSize) : undefined,
        sort: query.sort || undefined,
      },
      actor,
      canRevealPlaintext(role),
    );
  }

  /**
   * Tekil lisans iptali. Kayıt SİLİNMEZ → status='voided' (izlenebilirlik) + sebepli
   * stock_adjustments + audit. Teslim edilmiş lisans 409 döner.
   */
  @Delete('license-items/:id')
  voidLicenseItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(VoidLicenseItemBody)) body: VoidLicenseItemBody,
    @AdminActor() actor: string,
  ) {
    return this.stock.voidLicenseItem(id, body.reason, actor);
  }

  /** Tekil lisans değiştirme (payload düzeltme). Teslim edilmiş lisans 409 döner. */
  @Patch('license-items/:id')
  updateLicenseItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateLicenseItemBody)) body: UpdateLicenseItemBody,
    @AdminActor() actor: string,
  ) {
    return this.stock.updateLicenseItemPayload(id, body, actor);
  }
}
