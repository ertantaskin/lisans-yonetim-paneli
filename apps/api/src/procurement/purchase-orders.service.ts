import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { auditLog } from '../db/schema';
import { batches } from '../db/schema/batches';
import { purchaseOrders, type PurchaseOrder } from '../db/schema/purchaseOrders';
import { suppliers } from '../db/schema/suppliers';
// products: yalnız FK/JOIN için okunur (o dosya düzenlenmez).
import { products } from '../db/schema/products';

export type PoStatus = PurchaseOrder['status'];

export interface PurchaseOrderRow extends PurchaseOrder {
  supplierName: string;
  productSku: string;
  productName: string;
}

/**
 * Emir listesi zarfı (denetim bulgusu R3 — sessiz kırpma yasak).
 *
 * `list()` eskiden DÜZ DİZİ döndürüyordu ve LIMIT'i YOKTU. Bu tablo artık HER STOK GİRİŞİNDE
 * satır kazanıyor (otomatik teslim-alma emri) → ekran zamanla tüm geçmişi çekip tam sıralama
 * yapacaktı. Tavan koyarken kırpmayı GİZLEMEK bu projede yasak (sessiz LIMIT daha önce
 * "o kayıt yok" dedirtmişti) → `truncated` ile yüzeye taşınır.
 */
export interface PurchaseOrderList {
  items: PurchaseOrderRow[];
  /** true ise EKRANDAKİ liste EKSİKTİR (daha eski emirler var). */
  truncated: boolean;
}

/**
 * PurchaseOrdersService — satın alma emri (§12). Teslim alma (receive) emri
 * qtyReceived'i artırır, partial/received'a çeker ve YENİ bir parti (batch) kaydı
 * açar. Gerçek key'lerin stok girişi ayrıdır (stock.import; batchId ile bağlanır).
 */
@Injectable()
export class PurchaseOrdersService {
  /**
   * Liste tavanı. Otomatik teslim-alma emirleri yüzünden tablo her stok girişinde büyür;
   * TAVAN+1 çekilir ("tavan+1 çek, JS'te kırp" — supply-ops.listBatches / suppliers karnesi
   * deseni) ki tam TAVAN kadar emir varken YANLIŞ kırpma alarmı basılmasın.
   */
  static readonly LIST_LIMIT = 500;

  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Tedarikçi adı + ürün sku/name JOIN'li liste (en yeni önce).
   *
   * TIE-BREAK (`id DESC`) ZORUNLU: aynı transaction'da açılan emirler (Stok Girişi'nin
   * otomatik emri) BİREBİR aynı `created_at` damgasını taşır — tie-break olmadan LIMIT
   * penceresinin sınırı keyfi olurdu (aynı veri, iki farklı çağrıda farklı satır seti).
   */
  async list(): Promise<PurchaseOrderList> {
    const rows = await this.db
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
        productSku: products.sku,
        productName: products.name,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(products, eq(purchaseOrders.productId, products.id))
      .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
      .limit(PurchaseOrdersService.LIST_LIMIT + 1);

    // Sinyal HAM satır sayısından türer; tespit için çekilen fazladan satır YANITA GİRMEZ.
    const truncated = rows.length > PurchaseOrdersService.LIST_LIMIT;
    return {
      items: rows.slice(0, PurchaseOrdersService.LIST_LIMIT).map((r) => ({
        ...r.po,
        supplierName: r.supplierName,
        productSku: r.productSku,
        productName: r.productName,
      })),
      truncated,
    };
  }

  async getById(id: string): Promise<PurchaseOrderRow> {
    const [row] = await this.db
      .select({
        po: purchaseOrders,
        supplierName: suppliers.name,
        productSku: products.sku,
        productName: products.name,
      })
      .from(purchaseOrders)
      .innerJoin(suppliers, eq(purchaseOrders.supplierId, suppliers.id))
      .innerJoin(products, eq(purchaseOrders.productId, products.id))
      .where(eq(purchaseOrders.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Satın alma emri bulunamadı');
    return {
      ...row.po,
      supplierName: row.supplierName,
      productSku: row.productSku,
      productName: row.productName,
    };
  }

  async create(input: {
    supplierId: string;
    productId: string;
    status?: 'draft' | 'ordered';
    qtyOrdered: number;
    unitCostCents?: number;
    currency?: string;
    eta?: string;
    notes?: string;
  }): Promise<PurchaseOrder> {
    const status = input.status ?? 'draft';
    await this.assertRefsExist(input.supplierId, input.productId);
    const [row] = await this.db
      .insert(purchaseOrders)
      .values({
        supplierId: input.supplierId,
        productId: input.productId,
        status,
        qtyOrdered: input.qtyOrdered,
        unitCostCents: input.unitCostCents ?? null,
        currency: input.currency ?? 'TRY',
        eta: input.eta ? new Date(input.eta) : null,
        // Sipariş verildiyse zaman damgası düş (draft'ta null).
        orderedAt: status === 'ordered' ? new Date() : null,
        notes: input.notes ?? null,
      })
      .returning();
    return row!;
  }

  /**
   * FK ön-kontrolü: `supplier_id` / `product_id` gerçekten var mı?
   *
   * NEDEN VAR: DTO yalnız BİÇİMİ (`z.string().uuid()`) doğrular. Silinmiş bir tedarikçinin ya
   * da ürünün id'siyle emir açmak PG 23503 (foreign_key_violation) ile ham 500 üretiyordu —
   * operatör "Internal server error" görüp hangi alanın geçersiz olduğunu anlayamıyordu.
   * Desen `products.controller.assertCategoryExists` ile aynı: önce varlığı çöz, yoksa
   * HANGİSİNİN eksik olduğunu SÖYLEYEN 404.
   *
   * YARIŞ (kontrol ile INSERT arası silme) burada kapatılmaz — kapatılması gereksiz: o dar
   * pencerede oluşan 23503'ü global `PgExceptionFilter` yine anlamlı bir 404'e çevirir.
   * Bu ön-kontrolün katkısı, YAYGIN durumda hangi kaydın eksik olduğunu adıyla söylemesidir.
   */
  private async assertRefsExist(supplierId: string, productId: string): Promise<void> {
    const [supplier, product] = await Promise.all([
      this.db.select({ id: suppliers.id }).from(suppliers).where(eq(suppliers.id, supplierId)).limit(1),
      this.db.select({ id: products.id }).from(products).where(eq(products.id, productId)).limit(1),
    ]);
    if (supplier.length === 0) throw new NotFoundException('Tedarikçi bulunamadı');
    if (product.length === 0) throw new NotFoundException('Ürün bulunamadı');
  }

  /**
   * Kısmi güncelleme: status/eta/notes. draft→ordered geçişinde orderedAt işaretlenir.
   *
   * TRANSACTION + FOR UPDATE (denetim bulgusu): eskiden `getById` → `UPDATE` iki AYRI
   * ifadeydi ve satır kilitlenmiyordu. İki eşzamanlı `draft→ordered` çağrısında ikisi de
   * `orderedAt == null` okuyup ikisi de damga yazıyordu → emrin "sipariş verildi" anı SONRAKİ
   * çağrının zamanına kayıyordu. Tek tüketicisi tedarikçi karnesindeki
   * `avgLeadDays = avg(received_at − ordered_at)`, yani sessizce YANLIŞ bir KPI üretiliyordu.
   * Kardeş metot `receive()` bu kilidi ZATEN alıyor — sertlik farkı kapatıldı.
   */
  async update(
    id: string,
    patch: { status?: PoStatus; eta?: string | null; notes?: string | null },
  ): Promise<PurchaseOrder> {
    return this.db.transaction(async (tx) => {
      // JOIN'li `getById` yerine ham satır: burada yalnız `orderedAt` okunuyor ve kilit
      // (FOR UPDATE) yalnız tek tabloda anlamlı — JOIN'li select kilidi diğer tablolara da
      // yayardı (`receive()` ile aynı desen: yalnız purchase_orders satırı kilitlenir).
      const [current] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, id))
        .for('update')
        .limit(1);
      if (!current) throw new NotFoundException('Satın alma emri bulunamadı');

      const set: Partial<typeof purchaseOrders.$inferInsert> = { updatedAt: new Date() };
      if (patch.status !== undefined) {
        set.status = patch.status;
        if (patch.status === 'ordered' && current.orderedAt == null) set.orderedAt = new Date();
      }
      if (patch.eta !== undefined) set.eta = patch.eta ? new Date(patch.eta) : null;
      if (patch.notes !== undefined) set.notes = patch.notes;

      const [row] = await tx
        .update(purchaseOrders)
        .set(set)
        .where(eq(purchaseOrders.id, id))
        .returning();
      return row!;
    });
  }

  /**
   * Teslim alma (§12). Kabul edilen adet = min(qty, kalan). qtyReceived artar,
   * status kalan==0 ise 'received', değilse 'partial'. YENİ parti (batch) kaydı açılır.
   * Sebep/aktör audit_log'a düşer. Tümü tek transaction + satır kilidi (FOR UPDATE) ile
   * — eşzamanlı teslim almalar over-receive yapamaz.
   */
  async receive(
    id: string,
    input: { qty: number; batchLabel: string; notes?: string },
    // Denetim izine YAZILAN aktör. Varsayılan yalnız servisin doğrudan çağrıldığı yollar
    // (test/iç servis) içindir; HTTP yolu @AdminActor ile gerçek admini geçirir.
    actor = 'panel:admin',
  ): Promise<{ purchaseOrder: PurchaseOrder; batchId: string; accepted: number }> {
    // SAVUNMA DERİNLİĞİ: controller (`ReceiveBody`) zaten `int().positive().max(1_000_000)`
    // uyguluyor; burası servisin DOĞRUDAN çağrıldığı yolları (test/iç servis) kapsar.
    // `qty <= 0` tek başına YETMEZ: NaN ile karşılaştırma hep false döner → NaN guard'ı
    // geçer, `Math.min(NaN, remaining)` NaN olur ve `qty_received` (integer) kolonuna
    // NaN yazılmaya çalışılır. Ondalık qty ise PG tarafında YUVARLANARAK sessizce
    // kalandan fazla teslim alınmış gösterebilir. İkisi de tam sayı defterini bozar.
    if (!Number.isInteger(input.qty) || input.qty <= 0)
      throw new BadRequestException('qty pozitif tam sayı olmalı');

    return this.db.transaction(async (tx) => {
      const [po] = await tx
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, id))
        .for('update')
        .limit(1);
      if (!po) throw new NotFoundException('Satın alma emri bulunamadı');
      if (po.status === 'cancelled')
        throw new BadRequestException('İptal edilmiş emre teslim alınamaz');

      const remaining = po.qtyOrdered - po.qtyReceived;
      if (remaining <= 0) throw new BadRequestException('Emir zaten tamamen teslim alınmış');

      const accepted = Math.min(input.qty, remaining);
      const newReceived = po.qtyReceived + accepted;
      const newStatus: PoStatus = newReceived >= po.qtyOrdered ? 'received' : 'partial';
      const now = new Date();

      /*
       * `received_at` YALNIZ emir TAMAMEN teslim alındığında yazılır (denetim bulgusu).
       *
       * ÖNCEDEN her kısmi teslim almada üzerine yazılıyordu → alanın anlamı "SON sevkiyatın
       * tarihi" oluyordu ve `status='partial'` iken de doluyordu. Bunun TEK tüketicisi
       * tedarikçi karnesindeki `avgLeadDays = avg(received_at - ordered_at)`; yani hâlâ AÇIK
       * olan emirler tedarik süresi ortalamasına giriyor ve KPI'yı olduğundan kısa gösteriyordu
       * (ilk parça gelir gelmez "teslim edildi" sayılıyordu).
       *
       * Sevkiyat başına tarih KAYBOLMAZ: her teslim alma kendi `batches.received_at` kaydını
       * açar (maliyet raporu zaten ayı ORADAN bucketlar — bu değişiklik maliyet raporunu
       * etkilemez). PO seviyesindeki alan artık tek bir şeyi ifade eder: emrin KAPANDIĞI an.
       */
      const [updated] = await tx
        .update(purchaseOrders)
        .set({
          qtyReceived: newReceived,
          status: newStatus,
          ...(newStatus === 'received' ? { receivedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(purchaseOrders.id, id))
        .returning();

      // Teslim alınan partiyi kaydet (gerçek key'lerin stok girişi ayrı: stock.import).
      const [batch] = await tx
        .insert(batches)
        .values({
          supplierId: po.supplierId,
          purchaseOrderId: po.id,
          productId: po.productId,
          label: input.batchLabel,
          qtyReceived: accepted,
          notes: input.notes ?? null,
        })
        .returning({ id: batches.id });

      // Sebepli/aktörlü denetim izi (§12): PO teslim-alma.
      await tx.insert(auditLog).values({
        action: 'receive',
        actor,
        targetType: 'purchase_order',
        targetId: po.id,
        meta: {
          kind: 'po_receive',
          accepted,
          qtyReceived: newReceived,
          qtyOrdered: po.qtyOrdered,
          status: newStatus,
          batchId: batch!.id,
          batchLabel: input.batchLabel,
        },
      });

      return { purchaseOrder: updated!, batchId: batch!.id, accepted };
    });
  }
}
