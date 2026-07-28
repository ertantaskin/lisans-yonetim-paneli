import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  AccountPayloadSchema,
  parseAccountPayload,
  serializeAccountPayload,
  type AccountPayloadSchema as AccountPayloadSchemaT,
} from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { CryptoService } from '../crypto/crypto.service';
import {
  auditLog,
  batches,
  licenseItems,
  orderLines,
  orders,
  purchaseOrders,
  stockAdjustments,
  type NewLicenseItem,
  type Product,
} from '../db/schema';
import { ProductsService } from '../products/products.service';
import { FulfillmentService } from '../orders/fulfillment.service';

export interface ImportRejection {
  index: number;
  reason: string;
}

export interface ImportResult {
  requested: number;
  imported: number;
  duplicates: number;
  /** Doğrulamadan geçemeyen satırlar (account şema / keyFormat) — sessizce yutulmaz. */
  rejected: number;
  rejections: ImportRejection[];
  autoCompleted: number;
  /** Kuru çalıştırma (§7): true ise HİÇBİR şey commit edilmedi (yalnız doğrulama). */
  dryRun?: boolean;
  /** Kuru çalıştırma tahmini: doğrulamayı geçip (dedupe sonrası) GİRİLECEK satır sayısı. */
  wouldImport?: number;
}

export type ImportItem = { payload: string | Record<string, unknown>; expiresAt?: string };

/** "Onayla ve Dağıt" önizleme (§13): girilecek stok bekleyen talebi ne kadar karşılar. */
export interface StockPreview {
  /** İstenen giriş adedi (birim). */
  count: number;
  /** Bu ürün için bekleyen (pending/partial) satır sayısı. */
  pendingLines: number;
  /** Bekleyen toplam birim = Σ(qty - fulfilled_qty). */
  pendingUnits: number;
  /** Bu giriş kaç bekleyen birimi tamamlar = min(count, pendingUnits). */
  wouldFill: number;
  /** Bekleyen karşılandıktan sonra artan stok = max(count - pendingUnits, 0). */
  remainingAfter: number;
}

/** Lisans envanteri: sayfa başına izinli adetler (UI "25 / 50 / 100" seçeneği). */
export const LICENSE_PAGE_SIZES = [25, 50, 100] as const;

/** license_items.status enum'unun TAM listesi (UI facet'i genelde ilk 4'ünü kullanır). */
export const LICENSE_ITEM_STATUSES = [
  'available',
  'assigned',
  'suspended',
  'replaced',
  'revoked',
  'quarantined',
  'depleted',
  'expired',
  'voided',
] as const;
export type LicenseItemStatus = (typeof LICENSE_ITEM_STATUSES)[number];

export type LicenseInventorySort = 'created_desc' | 'created_asc' | 'assigned_desc';

/** Hesap (account) ürününde alan-alan çözülmüş payload. */
export interface LicenseInventoryField {
  key: string;
  label: string;
  value: string;
  /** true ise şemada "gizli" işaretli alan (parola vb.) — UI istersen gizli tutabilir. */
  secret: boolean;
}

/** Lisans TESLİM EDİLMİŞSE bağlı sipariş/site bilgisi (yoksa null). */
export interface LicenseInventoryDelivery {
  assignmentId: string;
  assignmentStatus: string;
  units: number;
  assignedAt: Date | null;
  validUntil: Date | null;
  orderId: string;
  remoteOrderId: string;
  customerEmail: string;
  siteId: string;
  siteDomain: string;
  siteType: string;
  /**
   * Mağaza admin panelinde siparişi açan URL — SALT YÖNLENDİRME (§17). Panel mağazaya
   * bağlanmaz/oturum açmaz; yalnız link üretir. Şablon yoksa/desteklenmeyen kanalda null.
   */
  storeAdminUrl: string | null;
}

export interface LicenseInventoryRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  /** products.kind ham değeri: key | account | code | custom. */
  productType: string;
  usageMode: string;
  status: string;
  maxUses: number;
  useCount: number;
  /** Kalan kapasite (multi/MAK): max_uses − use_count (negatif olamaz). */
  remainingUses: number;
  /** Gösterim tipi: account → fields dolu, diğer her şey → value dolu. */
  kind: 'key' | 'account';
  value: string | null;
  fields: LicenseInventoryField[] | null;
  batchId: string | null;
  batchCode: string | null;
  supplierName: string | null;
  unitCostCents: number | null;
  costCurrency: string | null;
  createdAt: Date;
  delivered: LicenseInventoryDelivery | null;
}

export interface LicenseInventoryPage {
  rows: LicenseInventoryRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ListLicenseItemsParams {
  productId?: string;
  status?: string;
  search?: string;
  siteId?: string;
  batchId?: string;
  page?: number;
  pageSize?: number;
  sort?: LicenseInventorySort;
}

/** PATCH gövdesi: key ürününde `value`, account ürününde `fields` verilir. */
export interface UpdateLicenseItemInput {
  value?: string;
  fields?: Record<string, string>;
  reason: string;
}

/** Tek sorguluk envanter satırının HAM (snake_case) şekli. */
interface LicenseItemRawRow {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  product_kind: string;
  usage_mode: string;
  payload_schema: unknown;
  payload_enc: string;
  status: string;
  max_uses: number;
  use_count: number;
  batch_id: string | null;
  batch_code: string | null;
  supplier_name: string | null;
  unit_cost_cents: number | null;
  cost_currency: string | null;
  created_at: Date;
  assignment_id: string | null;
  assignment_status: string | null;
  units: number | null;
  assigned_at: Date | null;
  valid_until: Date | null;
  order_id: string | null;
  remote_order_id: string | null;
  customer_email: string | null;
  site_id: string | null;
  site_domain: string | null;
  site_type: string | null;
  site_webhook_url: string | null;
  admin_order_url_template: string | null;
}

/** Teslim edilmiş lisansı iptal/düzenleme denemesinde dönen TEK mesaj (UI birebir gösterir). */
const DELIVERED_MSG =
  "Bu lisans müşteriye teslim edilmiş. Değiştirmek için sipariş detayındaki 'Değiştir' işlemini kullanın.";

@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly products: ProductsService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Stok import (§12). Her payload şifrelenir (envelope), içerik hash'iyle mükerrer
   * engellenir (UNIQUE payload_hash → onConflictDoNothing). Çok kullanımlıkta (multi)
   * her key ürünün max_uses kapasitesiyle girer.
   */
  async import(
    productId: string,
    items: ImportItem[],
    batchId?: string,
    dryRun = false,
    actor = 'panel:admin',
  ): Promise<ImportResult> {
    const product = await this.products.getById(productId);

    // Çok kullanımlık (MAK) ürün maxUses>1 ZORUNLU — aksi halde her key kapasite=1'e
    // düşer ve MAK anahtarı tek satışta tükenir (sessiz misconfig'i erken yakala).
    if (product.usageMode === 'multi' && (product.maxUses == null || product.maxUses <= 1)) {
      throw new BadRequestException(
        "usageMode='multi' ürün için max_uses > 1 tanımlı olmalı — import reddedildi.",
      );
    }
    const maxUses = product.usageMode === 'multi' ? product.maxUses! : 1;

    // Hesap ürünü için alan şemasını çöz (import doğrulaması + kanonik serialize).
    const accountSchema = this.resolveAccountSchema(product);
    const keyRegex = this.compileKeyFormat(product);

    // COGS maliyet anlık-görüntüsü (§12, D17): parti verilmişse o partinin PO'sundan
    // birim maliyet + para birimini salt-okunur çek. Her yeni satıra snapshot yazılır
    // (import anında sabitlenir, sonradan değişmez). Parti yoksa / PO maliyeti yoksa null.
    const costSnapshot = await this.resolveBatchCost(batchId);

    const rejections: ImportRejection[] = [];
    const values: NewLicenseItem[] = [];

    items.forEach((it, index) => {
      let plaintext: string;
      try {
        plaintext = this.normalizePayload(it.payload, product, accountSchema, keyRegex);
      } catch (err) {
        rejections.push({ index, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      // id'yi uygulamada üretiyoruz ki payload'ı bu satıra AAD ile bağlayabilelim
      // (satır-taşıma engeli, §8). insert bu id ile yapılır.
      const id = randomUUID();
      values.push({
        id,
        productId,
        batchId: batchId ?? null,
        payloadEnc: this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
        payloadHash: this.crypto.payloadHash(plaintext),
        payloadSuffixHash: this.crypto.payloadSuffixHash(plaintext),
        maxUses,
        expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
        status: 'available',
        // COGS snapshot (varsa) — parti PO'sunun import anındaki maliyeti.
        unitCostCents: costSnapshot?.unitCostCents ?? null,
        costCurrency: costSnapshot?.costCurrency ?? null,
      });
    });

    // Kuru çalıştırma (§7): payloadlar DOĞRULANDI + rejected raporu üretildi; buradan
    // ötesi (DB insert, audit, autoCompleteProduct) HİÇ ÇALIŞMAZ — hiçbir şey commit edilmez.
    // Dedupe yalnız salt-okunur TAHMİN edilir: mevcut payload_hash'ler + parti-içi tekrar.
    if (dryRun) {
      let duplicates = 0;
      let wouldImport = 0;
      if (values.length > 0) {
        const hashes = values.map((v) => v.payloadHash);
        const existing = await this.db
          .select({ hash: licenseItems.payloadHash })
          .from(licenseItems)
          .where(inArray(licenseItems.payloadHash, hashes));
        const existingSet = new Set(existing.map((r) => r.hash));
        const seen = new Set<string>();
        for (const v of values) {
          // Zaten DB'de var VEYA bu partide daha önce görüldü → mükerrer (girilmez).
          if (existingSet.has(v.payloadHash) || seen.has(v.payloadHash)) {
            duplicates += 1;
          } else {
            seen.add(v.payloadHash);
            wouldImport += 1;
          }
        }
      }
      return {
        requested: items.length,
        imported: 0,
        duplicates,
        rejected: rejections.length,
        rejections,
        autoCompleted: 0,
        dryRun: true,
        wouldImport,
      };
    }

    if (values.length === 0) {
      return {
        requested: items.length,
        imported: 0,
        duplicates: 0,
        rejected: rejections.length,
        rejections,
        autoCompleted: 0,
      };
    }

    const inserted = await this.db
      .insert(licenseItems)
      .values(values)
      .onConflictDoNothing({ target: licenseItems.payloadHash })
      .returning({ id: licenseItems.id });

    // duplicates = doğrulamayı geçip DB'de mükerrer (payload_hash) çıkanlar.
    const duplicates = values.length - inserted.length;

    // Sebepli stok değişikliği audit'e düşer (§12). Aktör çağırandan gelir (x-admin-actor).
    await this.db.insert(auditLog).values({
      action: 'import',
      actor,
      targetType: 'product',
      targetId: productId,
      meta: { imported: inserted.length, duplicates, rejected: rejections.length },
    });

    // Stok girişinde tamamlama motorunu tetikle (§5 partial-auto FIFO).
    let autoCompleted = 0;
    if (inserted.length > 0) {
      autoCompleted = await this.fulfillment.autoCompleteProduct(productId);
    }

    return {
      requested: items.length,
      imported: inserted.length,
      duplicates,
      rejected: rejections.length,
      rejections,
      autoCompleted,
    };
  }

  /**
   * COGS snapshot kaynağı (§12, D17): verilen partinin PO'sundan birim maliyet +
   * para birimini salt-okunur çeker. Parti yoksa, partinin PO bağı yoksa veya PO'da
   * birim maliyet tanımlı değilse null döner (kayıt snapshot'sız kalır → "uncovered").
   * Import davranışını DEĞİŞTİRMEZ; yalnız iki opsiyonel snapshot alanı besler.
   */
  private async resolveBatchCost(
    batchId?: string,
  ): Promise<{ unitCostCents: number; costCurrency: string } | null> {
    if (!batchId) return null;
    const [row] = await this.db
      .select({
        unitCostCents: purchaseOrders.unitCostCents,
        costCurrency: purchaseOrders.currency,
      })
      .from(batches)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, batches.purchaseOrderId))
      .where(eq(batches.id, batchId))
      .limit(1);
    if (!row || row.unitCostCents == null) return null;
    return { unitCostCents: row.unitCostCents, costCurrency: row.costCurrency };
  }

  /** Ürün account ise payloadSchema'yı doğrulayıp döner; değilse null. */
  private resolveAccountSchema(product: Product): AccountPayloadSchemaT | null {
    if (product.kind !== 'account') return null;
    const parsed = AccountPayloadSchema.safeParse(product.payloadSchema);
    if (!parsed.success) {
      throw new BadRequestException(
        "kind='account' ürünün payload_schema'sı geçersiz — import reddedildi.",
      );
    }
    return parsed.data;
  }

  /** keyFormat regex'ini derler (bozuk regex → import reddedilir, sessiz kabul yok). */
  private compileKeyFormat(product: Product): RegExp | null {
    if (!product.keyFormat) return null;
    try {
      return new RegExp(product.keyFormat);
    } catch {
      throw new BadRequestException(`Ürün key_format regex'i geçersiz: ${product.keyFormat}`);
    }
  }

  /**
   * Import satırını depolanacak KANONİK düz metne çevirir + doğrular.
   * - account: girdi (nesne veya JSON string) şemaya göre doğrulanıp kanonik JSON olur.
   * - key/code/custom: düz string; keyFormat varsa regex'e uyması şart.
   * @throws satır geçersizse (çağıran rejections'a düşürür)
   */
  private normalizePayload(
    payload: string | Record<string, unknown>,
    product: Product,
    accountSchema: AccountPayloadSchemaT | null,
    keyRegex: RegExp | null,
  ): string {
    if (accountSchema) {
      // account: nesne bekle; string gelirse JSON parse et.
      let input: unknown = payload;
      if (typeof payload === 'string') {
        try {
          input = JSON.parse(payload);
        } catch {
          throw new Error('Hesap payload geçerli JSON değil');
        }
      }
      return serializeAccountPayload(accountSchema, input);
    }

    // account olmayan: düz string bekle.
    if (typeof payload !== 'string') {
      throw new Error('Bu ürün tipi için payload düz string olmalı');
    }
    if (keyRegex && !keyRegex.test(payload)) {
      throw new Error('Payload key_format desenine uymuyor');
    }
    return payload;
  }

  /**
   * "Onayla ve Dağıt" önizleme (§13): bu ürüne N birim stok girilirse bekleyen
   * (pending/partial) talebin ne kadarının kapanacağını gösterir. Salt-okunur;
   * import/atama mantığını TETİKLEMEZ — yalnız mevcut açık satırları toplar.
   */
  async preview(productId: string, count: number): Promise<StockPreview> {
    // Ürün gerçekten var mı? (yoksa 404 — sessiz sıfır göstermeyiz)
    await this.products.getById(productId);

    const [row] = await this.db
      .select({
        // Açık satır sayısı.
        lines: sql<number>`count(*)`,
        // Bekleyen birim: qty - fulfilled_qty (negatif olamaz, coalesce güvenliği).
        units: sql<number>`coalesce(sum(greatest(${orderLines.qty} - ${orderLines.fulfilledQty}, 0)), 0)`,
      })
      .from(orderLines)
      // autoCompleteProduct ("Onayla ve Dağıt" import) ile AYNI filtreler: iptal/iade
      // satırları (canceled) ve incelemedeki (held_for_review) siparişleri oto-tamamlamaz →
      // önizleme de bunları 'karşılanacak talep' saymamalı (yanıltıcı wouldFill düzelir).
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      .where(
        and(
          eq(orderLines.productId, productId),
          inArray(orderLines.status, ['pending', 'partial']),
          eq(orderLines.canceled, false),
          eq(orders.heldForReview, false),
        ),
      );

    const pendingLines = Number(row?.lines ?? 0);
    const pendingUnits = Number(row?.units ?? 0);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const wouldFill = Math.min(safeCount, pendingUnits);
    const remainingAfter = Math.max(safeCount - pendingUnits, 0);

    return { count: safeCount, pendingLines, pendingUnits, wouldFill, remainingAfter };
  }

  /** Ürün başına anlık 'available' stok (single: satır sayısı; multi: kalan kapasite). */
  async availableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(and(eq(licenseItems.productId, productId), eq(licenseItems.status, 'available')));
    return Number(row?.count ?? 0);
  }

  // ─── Lisans envanteri (§12/§13): listeleme + tekil iptal + tekil düzenleme ───────────

  /**
   * Lisans envanteri listesi — HEM ürün-bazlı (ürün detayı tablosu) HEM global
   * (/stock "son eklenen lisanslar") aynı fonksiyondan beslenir; fark yalnız `productId`.
   *
   * PERFORMANS: TEK sorgu + join (N+1 YOK). Sayfa VE toplam artık aynı sorgudan gelir
   * (`count(*) OVER ()` — ayrı COUNT taraması yok); süzgeç + sıralama + LIMIT/OFFSET bir
   * alt-sorguda (page_slice) yalnız license_items üzerinde çalışır, sunum join'leri ve
   * `delivered` LATERAL'i bu sayfaya (≤100 satır) uygulanır. LATERAL lisans başına EN İLGİLİ
   * atamayı verir (önce aktif, sonra en yeni) → çok atamalı MAK anahtarında satır çoğalmaz.
   * Payload çözme de YALNIZ dönen sayfa için yapılır. Sıralama kolonları bilerek
   * license_items'a sınırlıdır ki index'lerden karşılansın (created / status+created / assigned).
   *
   * GÜVENLİK: admin ucudur (AdminGuard) ve sipariş detayıyla aynı politikayı izler — panel
   * kimlik-doğrulamalı olduğu için lisans TAM görünür, bu yüzden her LİSTE görüntülemesi
   * TEK 'reveal' audit kaydına düşer (per-satır değil). Audit yazımı best-effort'tur:
   * hata okuma yolunu düşürmez (sipariş detayı deseni).
   */
  async listLicenseItems(
    params: ListLicenseItemsParams = {},
    actor = 'panel:admin',
  ): Promise<LicenseInventoryPage> {
    const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
    const pageSize = clampPageSize(params.pageSize);
    const offset = (page - 1) * pageSize;
    const { productId, batchId, siteId, status } = params;

    // ── Filtreler ──
    // Fragman TEK yerde kurulur; hem sayfa alt-sorgusu (page_slice) hem de yedek COUNT
    // BİREBİR aynısını kullanır → toplam ile liste asla ayrışamaz.
    const conds: SQL[] = [sql`true`];
    // Bu iki süzgeç doğrudan index'e oturur (li.product_id / li.batch_id → license_items_batch_idx).
    if (productId) conds.push(sql`li.product_id = ${productId}`);
    if (batchId) conds.push(sql`li.batch_id = ${batchId}`);
    // PERF: eski `li.status::text = $1` yazımı KOLONU fonksiyona sokuyordu → sargable değildi,
    // yani `license_items_status_created_idx (status, created_at DESC)` hiç kullanılamazdı.
    // Cast artık PARAMETREdedir: karşılaştırma kolonun kendi tipinde yapılır (index kullanılabilir)
    // ve tip çıkarımı yine sürücüden bağımsız/deterministik kalır.
    // Bilinmeyen değerde Postgres 22P02 (→500) atmasın diye enum listesi önce uygulamada
    // doğrulanır; geçersiz statü ESKİSİYLE AYNI sonucu verir: boş liste (`false` → 0 satır).
    if (status) {
      conds.push(
        (LICENSE_ITEM_STATUSES as readonly string[]).includes(status)
          ? sql`li.status = ${status}::license_item_status`
          : sql`false`,
      );
    }
    // Site süzgeci: lisansın HERHANGİ bir ataması bu siteye aitse listede kalır (lateral
    // gösterimi de aynı siteye daraltılır → "site X'e teslim edilenler" tutarlı okunur).
    if (siteId) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM assignments a2
        JOIN orders o2 ON o2.id = a2.order_id
        WHERE a2.license_item_id = li.id AND o2.site_id = ${siteId}
      )`);
    }

    // ── Arama (§13) ──
    // ŞİFRELİ payload üzerinde LIKE YAPILAMAZ → anahtar araması global aramadaki
    // (search.service) ANAHTARLI son-hane hash'i üzerinden yapılır: payload_suffix_hash
    // `suffix:<son 5 karakter>` HMAC'idir. Bu yüzden anahtar araması ancak girilen metnin
    // SON 5 karakteri anahtarın son 5 karakteriyle eşleşirse çalışır (5+ karakter girdi;
    // 4 hane TEK BAŞINA eşleşmez — kısıt bilinçli, sır sızdırmayan tek yol budur).
    // Diğer eksenler düz metin: müşteri e-postası, mağaza sipariş no, parti kodu.
    const term = (params.search ?? '').trim();
    if (term.length >= 2) {
      const pattern = `%${escapeLike(term)}%`;
      const suffixCond =
        term.length >= 5
          ? sql`li.payload_suffix_hash = ${this.crypto.payloadSuffixHash(term)}`
          : sql`false`;
      conds.push(sql`(
        ${suffixCond}
        OR b.label ILIKE ${pattern} ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM assignments a3
          JOIN orders o3 ON o3.id = a3.order_id
          WHERE a3.license_item_id = li.id
            AND (o3.customer_email ILIKE ${pattern} ESCAPE '\\'
                 OR o3.remote_order_id ILIKE ${pattern} ESCAPE '\\')
        )
      )`);
    }

    const where = sql.join(conds, sql` AND `);
    // Lateral'i site süzgecine bağla (yukarıdaki EXISTS ile tutarlı gösterim).
    const lateralSite = siteId ? sql`AND o.site_id = ${siteId}` : sql`AND true`;
    // ── Sıralama ──
    // KURAL: sıralama YALNIZ license_items kolonlarından kurulur. Böylece sayfa alt-sorgusu
    // (aşağıda) index'ten karşılanır ve pahalı LATERAL yalnız DÖNEN sayfa için koşar.
    //
    // `assigned_desc` eskiden LATERAL'in `d.assigned_at`ine (atamanın delivered/created zamanı)
    // göre sıralıyordu → sıralayabilmek için LATERAL'in EŞLEŞEN HER satır için çalışması
    // gerekiyordu (satır başına 3-join'li alt-sorgu). Artık `li.assigned_at` kolonu kullanılır
    // (atama anında yazılır) → `license_items_assigned_idx (assigned_at DESC NULLS LAST)`.
    //
    // BİLİNEN SAPMA (tek-kullanımda pratikte aynı, iki kenar durumda değil):
    //  · atama geri alınıp kalem 'available'a DÖNDÜYSE (all-or-nothing rollback / adet düşürme)
    //    li.assigned_at NULL'lanır → kalem artık sona düşer. Doğrusu da budur: kalem teslim
    //    edilmiş değildir. ('quarantined' olan iade/değişim kalemlerinde assigned_at KORUNUR.)
    //  · MULTI/MAK kalemlerde kapasite düşümü (consumeMultiUseCapacity) assigned_at YAZMAZ →
    //    bu kalemler teslim edilmiş olsalar bile NULLS LAST ile sona düşer. Merkezî not:
    //    kalıcı çözüm assign.ts'te kapasite düşümüne `assigned_at = now()` eklemektir (bu
    //    işçinin dosyası değil); o eklendiği anda sıralama MAK için de kendiliğinden düzelir.
    const orderBy =
      params.sort === 'created_asc'
        ? sql`li.created_at ASC, li.id ASC`
        : params.sort === 'assigned_desc'
          ? sql`li.assigned_at DESC NULLS LAST, li.created_at DESC, li.id DESC`
          : sql`li.created_at DESC, li.id DESC`;

    // ── Sayfa + toplam: TEK sorgu ──
    // Eskiden rows ve count(*) AYRI iki sorguydu; ikisi de aynı süzgeçle license_items'ı
    // baştan tarıyordu (iki tam geçiş + iki tur ağ). Artık `count(*) OVER ()` penceresi
    // sayfa alt-sorgusunda hesaplanır: pencere fonksiyonu WHERE'den SONRA ama ORDER BY/LIMIT'ten
    // ÖNCE çalıştığı için değer "süzgece uyan TOPLAM kayıt"tır (sayfanınki değil) → semantik
    // eski COUNT ile birebir.
    //
    // Alt sorgu ayrıca N+1'in tersini de çözer: LIMIT/OFFSET, JOIN'lerden ve LATERAL'den ÖNCE
    // uygulanır → ürün/parti/tedarikçi join'leri ve teslimat LATERAL'i yalnız ≤100 satır için
    // koşar (eskiden LATERAL, sıralamadan önce eşleşen HER satır için çalışabiliyordu).
    const rows = await rawRows<LicenseItemRawRow & { total_count: number }>(this.db, sql`
        WITH page_slice AS (
          SELECT li.id AS id, (count(*) OVER ())::int AS total_count
          FROM license_items li
          -- b: yalnız arama süzgeci (b.label) için — LEFT JOIN, satır çoğaltmaz (b.id PK).
          LEFT JOIN batches b ON b.id = li.batch_id
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${pageSize} OFFSET ${offset}
        )
        SELECT
          li.id                       AS id,
          li.product_id               AS product_id,
          p.name                      AS product_name,
          p.sku                       AS product_sku,
          p.kind::text                AS product_kind,
          p.usage_mode::text          AS usage_mode,
          p.payload_schema            AS payload_schema,
          li.payload_enc              AS payload_enc,
          li.status::text             AS status,
          li.max_uses                 AS max_uses,
          li.use_count                AS use_count,
          li.batch_id                 AS batch_id,
          b.label                     AS batch_code,
          s.name                      AS supplier_name,
          li.unit_cost_cents          AS unit_cost_cents,
          li.cost_currency            AS cost_currency,
          li.created_at               AS created_at,
          d.assignment_id             AS assignment_id,
          d.assignment_status         AS assignment_status,
          d.units                     AS units,
          d.assigned_at               AS assigned_at,
          d.valid_until               AS valid_until,
          d.order_id                  AS order_id,
          d.remote_order_id           AS remote_order_id,
          d.customer_email            AS customer_email,
          d.site_id                   AS site_id,
          d.site_domain               AS site_domain,
          d.site_type                 AS site_type,
          d.site_webhook_url          AS site_webhook_url,
          d.admin_order_url_template  AS admin_order_url_template,
          ps.total_count              AS total_count
        FROM page_slice ps
        JOIN license_items li ON li.id = ps.id
        JOIN products p ON p.id = li.product_id
        LEFT JOIN batches b ON b.id = li.batch_id
        LEFT JOIN suppliers s ON s.id = b.supplier_id
        LEFT JOIN LATERAL (
          SELECT
            a.id AS assignment_id,
            a.status::text AS assignment_status,
            a.units AS units,
            COALESCE(a.delivered_at, a.created_at) AS assigned_at,
            a.valid_until AS valid_until,
            o.id AS order_id,
            o.remote_order_id AS remote_order_id,
            o.customer_email AS customer_email,
            st.id AS site_id,
            st.domain AS site_domain,
            st.type::text AS site_type,
            st.webhook_url AS site_webhook_url,
            st.admin_order_url_template AS admin_order_url_template
          FROM assignments a
          JOIN orders o ON o.id = a.order_id
          JOIN sites st ON st.id = o.site_id
          WHERE a.license_item_id = li.id ${lateralSite}
          ORDER BY (a.status = 'active') DESC, a.created_at DESC
          LIMIT 1
        ) d ON TRUE
        -- Süzgeç/limit page_slice'ta uygulandı; burada yalnız sıra yeniden kurulur
        -- (join sonrası satır sırası GARANTİ DEĞİLDİR).
        ORDER BY ${orderBy};
      `);

    const mapped = rows.map((r) => this.mapInventoryRow(r));

    // Toplam: normalde pencere fonksiyonundan (ek sorgu YOK). Tek istisna, OFFSET'in sonuç
    // kümesini AŞMASIDIR: hiç satır dönmez → pencere değeri de gelmez. Bu durumda kontratı
    // korumak için (total = süzgece uyan kayıt sayısı, sayfa boş olsa bile) yedek COUNT
    // koşulur — yalnız page>1 iken, yani "3. sayfadayken filtre daraldı" senaryosunda.
    // 1. sayfa boşsa toplam zaten 0'dır, gereksiz sorgu açılmaz.
    const total =
      rows.length > 0
        ? Number(rows[0]?.total_count ?? 0)
        : page > 1
          ? await this.countLicenseItems(where)
          : 0;

    // Görüntüleme audit'i (§8 "reveal audit'e düşer"): liste TAM lisans döndürdüğü için
    // her görüntüleme TEK kayda düşer (kim / ne zaman / kaç lisans gördü). best-effort.
    if (mapped.length > 0) {
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor,
          targetType: 'license_item_list',
          targetId: productId ?? 'all',
          meta: {
            auto: true,
            view: 'license_inventory',
            count: mapped.length,
            page,
            pageSize,
            productId: productId ?? null,
            siteId: siteId ?? null,
            batchId: batchId ?? null,
            status: status ?? null,
            // Arama metni BİLEREK yazılmaz: kısmi anahtar olabilir (§8 audit meta'ya
            // payload düz metni ASLA girmez).
            hasSearch: term.length >= 2,
          },
        });
      } catch {
        /* audit yazımı başarısız → liste yine de döner */
      }
    }

    return { rows: mapped, total, page, pageSize };
  }

  /**
   * Toplam kayıt sayısının YEDEK sorgusu — yalnız "sayfa boş ama page>1" kenar durumunda
   * çalışır (bkz. listLicenseItems). Süzgeç fragmanı ana sorguyla BİREBİR aynıdır; `b`
   * join'i arama koşulundaki `b.label` içindir.
   */
  private async countLicenseItems(where: SQL): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM license_items li
      LEFT JOIN batches b ON b.id = li.batch_id
      WHERE ${where};
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /** HAM satır → API sözleşmesi (payload çözme + mağaza admin linki burada üretilir). */
  private mapInventoryRow(r: LicenseItemRawRow): LicenseInventoryRow {
    const decoded = this.decodeInventoryPayload(r);
    const maxUses = Number(r.max_uses ?? 1);
    const useCount = Number(r.use_count ?? 0);
    return {
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      productType: r.product_kind,
      usageMode: r.usage_mode,
      status: r.status,
      maxUses,
      useCount,
      remainingUses: Math.max(maxUses - useCount, 0),
      kind: decoded.kind,
      value: decoded.value,
      fields: decoded.fields,
      batchId: r.batch_id,
      batchCode: r.batch_code,
      supplierName: r.supplier_name,
      unitCostCents: r.unit_cost_cents == null ? null : Number(r.unit_cost_cents),
      costCurrency: r.cost_currency,
      createdAt: r.created_at,
      delivered:
        r.assignment_id && r.order_id && r.site_id
          ? {
              assignmentId: r.assignment_id,
              assignmentStatus: r.assignment_status ?? 'active',
              units: Number(r.units ?? 1),
              assignedAt: r.assigned_at,
              validUntil: r.valid_until,
              orderId: r.order_id,
              remoteOrderId: r.remote_order_id ?? '',
              customerEmail: r.customer_email ?? '',
              siteId: r.site_id,
              siteDomain: r.site_domain ?? '',
              siteType: r.site_type ?? '',
              storeAdminUrl: buildStoreAdminUrl(
                {
                  type: r.site_type,
                  domain: r.site_domain,
                  webhookUrl: r.site_webhook_url,
                  template: r.admin_order_url_template,
                },
                r.remote_order_id,
              ),
            }
          : null,
    };
  }

  /**
   * Şifreli payload'ı çözer. account ürününde şemaya göre alan-alan; diğer tiplerde düz
   * değer. Çözme hatası (bozuk kayıt / AAD uyuşmazlığı) listeyi DÜŞÜRMEZ — value/fields
   * null döner (UI "okunamadı" gösterir).
   */
  private decodeInventoryPayload(r: LicenseItemRawRow): {
    kind: 'key' | 'account';
    value: string | null;
    fields: LicenseInventoryField[] | null;
  } {
    const isAccount = r.product_kind === 'account';
    let plain: string;
    try {
      plain = this.crypto.decrypt(r.payload_enc, CryptoService.licenseItemAad(r.id));
    } catch {
      return { kind: isAccount ? 'account' : 'key', value: null, fields: null };
    }
    if (!isAccount) return { kind: 'key', value: plain, fields: null };

    const parsed = AccountPayloadSchema.safeParse(r.payload_schema);
    if (!parsed.success) {
      // Şema bozuk/eksik → ham JSON'u kolonlara DÖKMEK yerine tek alan olarak göster.
      return {
        kind: 'account',
        value: null,
        fields: [{ key: 'payload', label: 'Lisans (ham)', value: plain, secret: false }],
      };
    }
    return {
      kind: 'account',
      value: null,
      fields: parseAccountPayload(parsed.data, plain).map((f) => ({
        key: f.key,
        label: f.label,
        value: f.value,
        secret: f.secret,
      })),
    };
  }

  /**
   * Tekil lisans İPTALİ (§12). Kayıt SİLİNMEZ — `status='voided'` olur (izlenebilirlik:
   * hangi anahtar neden düştü, karantina ekranından okunur). Yalnız TESLİM EDİLMEMİŞ ve
   * hâlâ satılabilir (available) kalem iptal edilebilir.
   *
   * TOCTOU: advisory-lock (kalem id'si) + `FOR UPDATE` + koşullu UPDATE — iptal ile
   * eşzamanlı atama (SKIP LOCKED) yarışında ikisinden yalnız biri kazanır; atama kazanırsa
   * iptal 409 verir (asla teslim edilmiş anahtar void'lenmez).
   *
   * STOK SAYIMI: availableCount/products.list Σ(max_uses − use_count) WHERE status='available'
   * hesapladığı için 'voided' kalem otomatik düşer; MULTI'de KALAN kapasite düşer (fire
   * miktarı stock_adjustments.qty'ye de aynı şekilde yazılır → maliyet/zayi raporu doğru).
   */
  async voidLicenseItem(id: string, reason: string, actor: string) {
    const trimmed = (reason ?? '').trim();
    if (!trimmed) throw new BadRequestException('İptal sebebi zorunludur.');

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'license_item:' + id}))`);

      const [item] = await rawRows<{
        id: string;
        product_id: string;
        status: string;
        max_uses: number;
        use_count: number;
      }>(tx, sql`
        SELECT id, product_id, status::text AS status, max_uses, use_count
        FROM license_items WHERE id = ${id} LIMIT 1 FOR UPDATE;
      `);
      if (!item) throw new NotFoundException('Lisans bulunamadı.');

      // Teslim edilmiş mi? (aktif VEYA askıya alınmış atama = müşteride canlı lisans)
      const live = await rawRows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM assignments
        WHERE license_item_id = ${id} AND status IN ('active', 'suspended');
      `);
      if (Number(live[0]?.n ?? 0) > 0) throw new ConflictException(DELIVERED_MSG);

      if (item.status !== 'available') {
        throw new ConflictException(
          item.status === 'voided'
            ? 'Bu lisans zaten iptal edilmiş.'
            : `Yalnız satılabilir (available) durumdaki lisans iptal edilebilir. Mevcut durum: ${item.status}.`,
        );
      }

      const [updated] = await rawRows<{ id: string; max_uses: number; use_count: number }>(tx, sql`
        UPDATE license_items SET status = 'voided'
        WHERE id = ${id} AND status = 'available'
        RETURNING id, max_uses, use_count;
      `);
      if (!updated) throw new ConflictException(DELIVERED_MSG);

      // Fire miktarı: tek-kullanım → 1, multi/MAK → KALAN kapasite (supply-ops deseni).
      const remaining = Number(updated.max_uses) - Number(updated.use_count);
      const qty = remaining > 0 ? remaining : 1;

      await tx.insert(stockAdjustments).values({
        productId: item.product_id,
        licenseItemId: id,
        action: 'void',
        qty,
        reason: trimmed,
        actor,
      });
      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: 'license_item',
        targetId: id,
        meta: { action: 'void', qty, reason: trimmed, source: 'license_inventory' },
      });

      return { id, status: 'voided' as const, productId: item.product_id, qty };
    });
  }

  /**
   * Tekil lisans DEĞİŞTİRME (payload düzeltme, §12). Yanlış/bozuk girilmiş bir anahtarı
   * ya da hesap alanlarını yeniden yazar: yeni düz metin envelope ile ŞİFRELENİR (AES-256-GCM,
   * AAD `license_item:<id>` KORUNUR → ciphertext satır-taşıma hâlâ imkânsız) ve dedupe
   * alanları (payload_hash / payload_suffix_hash) birlikte güncellenir.
   *
   * SINIR: yalnız TESLİM EDİLMEMİŞ + available kalem. Teslim edilmiş anahtarın değişimi
   * envanterin işi DEĞİLDİR — o akış assignment replace'tir (eski anahtar karantinaya
   * gider, müşteriye TAZE anahtar atanır). Aksi halde müşterideki anahtar sessizce
   * geçersizleşirdi.
   */
  async updateLicenseItemPayload(id: string, input: UpdateLicenseItemInput, actor: string) {
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Değişiklik sebebi zorunludur.');

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'license_item:' + id}))`);

      const [row] = await rawRows<{
        id: string;
        product_id: string;
        status: string;
        payload_hash: string;
        kind: string;
        payload_schema: unknown;
        key_format: string | null;
      }>(tx, sql`
        SELECT li.id, li.product_id, li.status::text AS status, li.payload_hash,
               p.kind::text AS kind, p.payload_schema, p.key_format
        FROM license_items li
        JOIN products p ON p.id = li.product_id
        WHERE li.id = ${id} LIMIT 1 FOR UPDATE OF li;
      `);
      if (!row) throw new NotFoundException('Lisans bulunamadı.');

      const live = await rawRows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM assignments
        WHERE license_item_id = ${id} AND status IN ('active', 'suspended');
      `);
      if (Number(live[0]?.n ?? 0) > 0) throw new ConflictException(DELIVERED_MSG);

      if (row.status !== 'available') {
        throw new ConflictException(
          `Yalnız satılabilir (available) durumdaki lisans düzenlenebilir. Mevcut durum: ${row.status}.`,
        );
      }

      // ── Yeni düz metni üret + doğrula (import yoluyla BİREBİR aynı kurallar) ──
      let plaintext: string;
      let fields: LicenseInventoryField[] | null = null;
      if (row.kind === 'account') {
        const parsed = AccountPayloadSchema.safeParse(row.payload_schema);
        if (!parsed.success) {
          throw new BadRequestException(
            'Ürünün hesap alan şeması (payload_schema) geçersiz — düzenleme yapılamaz.',
          );
        }
        if (!input.fields || typeof input.fields !== 'object') {
          throw new BadRequestException('Hesap ürününde `fields` (alan → değer) zorunludur.');
        }
        try {
          plaintext = serializeAccountPayload(parsed.data, input.fields);
        } catch (err) {
          throw new BadRequestException(err instanceof Error ? err.message : String(err));
        }
        fields = parseAccountPayload(parsed.data, plaintext).map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          secret: f.secret,
        }));
      } else {
        const value = (input.value ?? '').trim();
        if (!value) throw new BadRequestException('Yeni lisans değeri (`value`) zorunludur.');
        if (row.key_format) {
          let re: RegExp;
          try {
            re = new RegExp(row.key_format);
          } catch {
            throw new BadRequestException(`Ürün key_format regex'i geçersiz: ${row.key_format}`);
          }
          if (!re.test(value)) {
            throw new BadRequestException('Yeni değer ürünün anahtar biçimine (key_format) uymuyor.');
          }
        }
        plaintext = value;
      }

      const newHash = this.crypto.payloadHash(plaintext);
      // Dedupe: aynı payload başka bir kayıtta varsa reddet (UNIQUE ihlali 500 olmadan 409).
      const dupe = await rawRows<{ id: string }>(tx, sql`
        SELECT id FROM license_items WHERE payload_hash = ${newHash} AND id <> ${id} LIMIT 1;
      `);
      if (dupe.length > 0) {
        throw new ConflictException('Bu lisans değeri sistemde zaten kayıtlı (mükerrer).');
      }

      const changed = newHash !== row.payload_hash;
      const payloadEnc = this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id));
      const suffixHash = this.crypto.payloadSuffixHash(plaintext);
      const [updated] = await rawRows<{ id: string }>(tx, sql`
        UPDATE license_items
        SET payload_enc = ${payloadEnc},
            payload_hash = ${newHash},
            payload_suffix_hash = ${suffixHash}
        WHERE id = ${id} AND status = 'available'
        RETURNING id;
      `);
      if (!updated) throw new ConflictException(DELIVERED_MSG);

      // Audit: sebep + aktör. Düz metin (eski/yeni değer) meta'ya ASLA yazılmaz (§8).
      await tx.insert(auditLog).values({
        action: 'replace',
        actor,
        targetType: 'license_item',
        targetId: id,
        meta: { op: 'edit_payload', reason, kind: row.kind, changed, source: 'license_inventory' },
      });

      return {
        id,
        productId: row.product_id,
        status: 'available' as const,
        kind: (row.kind === 'account' ? 'account' : 'key') as 'key' | 'account',
        value: row.kind === 'account' ? null : plaintext,
        fields,
        changed,
      };
    });
  }
}

/** Sayfa boyutunu izinli değerlere (25/50/100) kırpar — en yakın olana. */
function clampPageSize(n?: number): number {
  if (n == null || !Number.isFinite(n)) return LICENSE_PAGE_SIZES[0];
  return LICENSE_PAGE_SIZES.reduce<number>(
    (best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best),
    LICENSE_PAGE_SIZES[0],
  );
}

/** ILIKE joker karakterlerini (\, %, _) kaçırır — ESCAPE '\' ile birlikte kullanılır. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Yalnız http/https şemasına izin verir; aksi halde null (javascript:/data: engellenir). */
function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Mağaza origin'i: webhook URL'inden (en güvenilir), yoksa domain'den türetilir. */
function storeOrigin(webhookUrl: string | null, domain: string | null): string | null {
  if (webhookUrl) {
    try {
      const u = new URL(webhookUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.origin;
    } catch {
      /* bozuk webhook URL → domain'e düş */
    }
  }
  if (domain) {
    const host = domain.trim().replace(/^https?:\/\//i, '').split('/')[0];
    if (host) {
      try {
        return new URL(`https://${host}`).origin;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Mağaza admin panelinde siparişi açan URL (§17) — SALT YÖNLENDİRME. Panel mağazaya
 * BAĞLANMAZ/oturum açmaz, otomatik bir bağlantı kurmaz; yalnız operatörün tıklayacağı
 * linki üretir (kullanıcı isteği: "sadece URL yönlendirme, güvenlikten dolayı").
 *
 * Öncelik: sites.admin_order_url_template ({orderId} yer tutucusu) → yoksa woocommerce
 * varsayılanı. Diğer kanal tiplerinde (marketplace/reseller) şablon yoksa null.
 * remoteOrderId encodeURIComponent ile kaçırılır; sonuç yalnız http/https ise döner.
 *
 * NOT: W2'nin admin-orders içindeki aynı işlevli yardımcısını BİLEREK import etmiyoruz
 * (döngüsel bağımlılık + paralel çalışma riski) — kopya küçük ve yereldir.
 */
function buildStoreAdminUrl(
  site: {
    type: string | null;
    domain: string | null;
    webhookUrl: string | null;
    template: string | null;
  },
  remoteOrderId: string | null,
): string | null {
  if (!remoteOrderId) return null;
  const encoded = encodeURIComponent(remoteOrderId);
  const origin = storeOrigin(site.webhookUrl, site.domain);

  const template = site.template?.trim();
  if (template) {
    const filled = template.split('{orderId}').join(encoded);
    const abs = safeHttpUrl(filled);
    if (abs) return abs;
    // Şablon göreli yol olabilir ("/wp-admin/...") → mağaza origin'iyle çöz.
    if (!origin) return null;
    try {
      return safeHttpUrl(new URL(filled, origin).toString());
    } catch {
      return null;
    }
  }

  // Şablon yoksa yalnız WooCommerce için güvenli varsayılan üretilir.
  if (site.type !== 'woocommerce' || !origin) return null;
  return safeHttpUrl(`${origin}/wp-admin/admin.php?page=wc-orders&action=edit&id=${encoded}`);
}
