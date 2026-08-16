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
import { OwnerGuard } from '../auth/owner.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminRole, canRevealPlaintext } from '../auth/admin-role.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { MAX_USES_CAP } from '../products/limits';
import { LICENSE_ITEM_STATUSES, StockService } from './stock.service';

/**
 * Stok girişiyle AYNI istekte "teslim alınmış" parti + satın alma emri açma (§12).
 *
 * Operatör "12 Ağustos'ta Acme'den aldım, birim 10,00 ₺" bilgisini stok girerken verir;
 * panel arka planda tedarikçi (varsa yeniden kullanılır), `status='received'` bir satın
 * alma emri ve partiyi oluşturur. Böylece maliyet/karne raporları için ÖNCE PO açıp sonra
 * teslim alma zorunluluğu kalkar.
 *
 * `qtyReceived` alanı BİLEREK YOKTUR: adet operatörün beyanından değil, GERÇEKTEN girilen
 * (mükerrer/reddedilen düşülmüş) kayıt sayısından türetilir — aksi halde harcama şişerdi.
 */
const NewBatchBody = z.object({
  /** Mevcut tedarikçi (listeden seçim). `supplierName` ile birlikte gönderilemez. */
  supplierId: z.string().uuid().optional(),
  /** Yeni/serbest tedarikçi adı — aynı ad varsa YENİDEN KULLANILIR (mükerrer 'Acme' birikmez). */
  supplierName: z.string().trim().min(1).max(200).optional(),
  /** Parti etiketi (ör. "2026-08 Acme #1") — operatörün partiyi tanıdığı ad. */
  label: z.string().trim().min(1).max(120),
  /** Teslim alma tarihi (ISO). Verilmezse "şimdi". Aralık kontrolü serviste. */
  receivedAt: z.string().datetime().optional(),
  /** Birim maliyet (kuruş). Maliyet satın alma emrinde tutulur → tedarikçi ZORUNLU olur. */
  unitCostCents: z.number().int().min(0).max(2_000_000_000).optional(),
  /** Para birimi (ör. TRY/USD). Serviste büyük harfe çevrilir (rapor 'try' vs 'TRY' bölünmesin). */
  currency: z.string().trim().min(1).max(8).optional(),
  /** Operatör notu — otomatik oluşturma önekinin ARDINA eklenir. */
  notes: z.string().max(2_000).optional(),
});

const ImportBody = z
  .object({
    productId: z.string().uuid(),
    /** Opsiyonel parti bağlama (§12): verilirse tüm satırlar bu batch'e yazılır (recall/toplu-değiştir). */
    batchId: z.string().uuid().optional(),
    /** Kuru çalıştırma (§7): true ise yalnız DOĞRULA + önizleme raporu — hiçbir şey commit edilmez. */
    dryRun: z.boolean().optional(),
    /** Stok girişiyle AYNI istekte yeni parti (+ otomatik satın alma emri) oluştur. */
    newBatch: NewBatchBody.optional(),
    items: z
      .array(
        z.object({
          // key/code/custom: düz string. account: alan→değer nesnesi (veya JSON string).
          // Üst sınır: kardeş yazma yolu (UpdateLicenseItemBody.value) .max(4000) uyguluyordu, import
          // yolunda HİÇ sınır yoktu → tek istekle ~1 MB payload şifrelenip saklanabiliyordu.
          payload: z.union([z.string().min(1).max(4000), z.record(z.string(), z.unknown())]),
          expiresAt: z.string().datetime().optional(),
        }),
      )
      .min(1)
      .max(10_000),
  })
  // NOT: z.preprocess/z.coerce KULLANILMAZ (aşağıdaki `optionalUuid` notu: ikisi de girdi
  // tipini `unknown` yapıp `ZodBody<T>` ile çakışır). superRefine girdi/çıktı tipini
  // DEĞİŞTİRMEZ → güvenlidir (UpdateLicenseItemBody'deki `.refine` ile aynı desen).
  .superRefine((body, ctx) => {
    const nb = body.newBatch;
    if (!nb) return;
    if (body.batchId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newBatch'],
        message: 'Mevcut parti ile yeni parti bilgisi birlikte gönderilemez — birini seçin.',
      });
    }
    if (nb.supplierId && nb.supplierName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newBatch', 'supplierName'],
        message:
          'Tedarikçi ya listeden seçilir ya da yeni ad girilir — ikisi birlikte gönderilemez.',
      });
    }
    if (nb.unitCostCents != null && !nb.supplierId && !nb.supplierName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['newBatch', 'unitCostCents'],
        message:
          'Birim maliyet girildi ama tedarikçi seçilmedi. Maliyet satın alma emrinde tutulur; ' +
          'tedarikçi seçin ya da maliyeti boş bırakın.',
      });
    }
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
  /**
   * Kalemi KİM tutuyor? `status` kalemin envanter durumudur; bu ise ATAMA tarafıdır.
   * İkisi ayrı olmak zorunda: MAK/çok-kullanımlı bir anahtar 500 hakkının 3'ü satılmışken
   * hâlâ `status='available'`dır — "müşterilerde mi?" sorusu durumdan okunamaz.
   */
  holder: z.union([z.literal(''), z.enum(['customer'])]).optional(),
  search: z.string().max(120).optional(),
  page: optionalDigits,
  // Servis 25/50/100'e KIRPAR (en yakın izinli) — burada yalnız rakam olduğu doğrulanır.
  pageSize: optionalDigits,
  sort: z
    .union([z.literal(''), z.enum(['created_desc', 'created_asc', 'assigned_desc'])])
    .optional(),
});
type ListLicenseItemsQuery = z.infer<typeof ListLicenseItemsQuery>;

/**
 * Dışa aktarma süzgeçleri — listeyle BİREBİR aynı, yalnız sayfalama alanları YOK: tavan
 * sunucudadır (`LICENSE_EXPORT_LIMIT`) ve istemci "kaç satır istediğini" seçemez.
 */
const ExportLicenseItemsQuery = ListLicenseItemsQuery.omit({ page: true, pageSize: true });
type ExportLicenseItemsQuery = z.infer<typeof ExportLicenseItemsQuery>;

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
 * TESLİM EDİLMİŞ hesabın kimlik bilgisi güncellemesi (sağlayıcıda parola değişti / operatör
 * döndürdü). Yalnız hesap ürünü; sebep zorunlu. `value` YOK — anahtar ürününde değişen bir
 * anahtar AYRI bir lisanstır ve replace akışıyla yönetilir.
 */
const RotateCredentialsBody = z.object({
  fields: z.record(z.string(), z.string()),
  reason: z.string().trim().min(3).max(500),
});
type RotateCredentialsBody = z.infer<typeof RotateCredentialsBody>;

/**
 * Çok kullanımlık (MAK) kalemin KAPASİTE düzeltmesi.
 *
 * `remainingUses` = düzeltmeden SONRA kalması istenen kullanım hakkı; servis `max_uses`ı
 * `use_count + remainingUses` diye türetir (operatör "kalan"ı bilir, tavanı değil).
 * Üst sınır ürün formundakiyle AYNI sabittir (`MAX_USES_CAP`) — iki ayrı tavan tutmak, bu
 * ucun ürün formunun reddedeceği bir kapasiteyi kabul etmesi demekti.
 */
const AdjustCapacityBody = z.object({
  remainingUses: z.number().int().min(0).max(MAX_USES_CAP),
  reason: z.string().trim().min(3).max(500),
});
type AdjustCapacityBody = z.infer<typeof AdjustCapacityBody>;

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
    // `newBatch` SON (6.) argümandır: pozisyonel sıra korunur → mevcut çağıranlar/testler kırılmaz.
    return this.stock.import(body.productId, body.items, body.batchId, dryRun, actor, body.newBatch);
  }

  /** "Onayla ve Dağıt" önizleme (§13): bu giriş bekleyen talebi ne kadar karşılar. */
  @Post('stock/preview')
  preview(@Body(new ZodBody(PreviewBody)) body: PreviewBody) {
    return this.stock.preview(body.productId, body.count);
  }

  // ParseUUIDPipe: bu dosyadaki diğer üç uç (void/update/rotate-credentials) zaten kullanıyor;
  // yalnız bu okuma ucu atlanmıştı → bozuk productId sorguya gidip PG 22P02 ile ham 500
  // üretiyordu, artık 400 döner.
  @Get('stock/:productId/available')
  async available(@Param('productId', new ParseUUIDPipe()) productId: string) {
    return { productId, available: await this.stock.availableCount(productId) };
  }

  // ─── Lisans envanteri (§13) ─────────────────────────────────────────────────────────
  /**
   * Lisans/anahtar listesi: ürün-bazlı (?productId=) veya GLOBAL (parametresiz).
   * Arama + durum/site/parti süzgeci + sayfalama. TAM lisans döner (admin) → her
   * görüntüleme TEK 'reveal' audit kaydına düşer.
   */
  /**
   * Envanter DIŞA AKTARMA (mutabakat/muhasebe) — tek istekte tavan kadar satır.
   *
   * ROTA SIRASI: statik 'license-items/export' bilerek listeden ÖNCE tanımlıdır. Bugün bir
   * `@Get('license-items/:id')` YOK; eklenirse bu satır altta kalsaydı 'export' kelimesi
   * id sanılıp sessizce 400/404'e düşerdi (Nest rotaları tanım sırasına göre eşler).
   *
   * ROL (A1/M1): düz metin YALNIZ owner'a — owner-olmayan 'admin' maskeli dosya indirir.
   * Düz-metin dosyası TEK 'reveal' audit kaydı üretir (serviste; anahtar değeri yazılmaz).
   */
  @Get('license-items/export')
  exportLicenseItems(
    @Query(new ZodBody(ExportLicenseItemsQuery)) query: ExportLicenseItemsQuery,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.stock.exportLicenseItems(
      {
        productId: query.productId || undefined,
        siteId: query.siteId || undefined,
        batchId: query.batchId || undefined,
        status: query.status || undefined,
        holder: query.holder || undefined,
        search: query.search || undefined,
        sort: query.sort || undefined,
      },
      actor,
      canRevealPlaintext(role),
    );
  }

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
        holder: query.holder || undefined,
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

  /**
   * TESLİM EDİLMİŞ hesabın kimlik bilgilerini YERİNDE günceller (sağlayıcıda parola değişti).
   *
   * OWNER-ONLY: uç düz metin kimlik bilgisi KABUL eder ve doğrulanmış hâlini geri döndürür;
   * projenin A1/A3 kararı gereği (düz metin yalnız owner) `reveal` uçlarıyla aynı kapıda durur.
   * Ayrıca müşteride ÇALIŞAN bir lisansı değiştirir — geri alınamaz bir işlemdir.
   */
  @UseGuards(OwnerGuard)
  @Post('license-items/:id/rotate-credentials')
  rotateCredentials(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(RotateCredentialsBody)) body: RotateCredentialsBody,
    @AdminActor() actor: string,
  ) {
    return this.stock.rotateAccountCredentials(id, body, actor);
  }

  /**
   * Çok kullanımlık (MAK) kalemin kalan kullanım hakkını YENİDEN AYARLAR.
   *
   * OWNER-ONLY: satılabilir stok miktarını (Σ max_uses − use_count) doğrudan değiştirir —
   * yani `rotate-credentials` ile aynı sınıf, "rakama müdahale" eden bir işlemdir.
   * `use_count` ASLA değişmez (bkz. servis jsdoc'u: §2 sessiz aşırı-satış).
   */
  @UseGuards(OwnerGuard)
  @Post('license-items/:id/capacity')
  adjustCapacity(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(AdjustCapacityBody)) body: AdjustCapacityBody,
    @AdminActor() actor: string,
  ) {
    return this.stock.adjustMultiUseCapacity(id, body, actor);
  }
}
