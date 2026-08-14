import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { suppliers, type Supplier } from '../db/schema/suppliers';

/** Tedarikçi karnesi parti satırı (§12). */
export interface ScorecardBatchRow {
  id: string;
  label: string;
  status: string;
  qtyReceived: number;
  createdAt: string;
}

/**
 * Tedarikçi karnesi (§12) — salt-okunur agregasyon. purchase_orders + batches
 * tablolarından tedarikçi performans metrikleri. Yan etki yok.
 */
export interface SupplierScorecard {
  supplier: Supplier;
  poCount: number;
  totalOrdered: number;
  totalReceived: number;
  /** Teslim alınan PO'larda ort. tedarik süresi (gün); veri yoksa null. */
  avgLeadDays: number | null;
  /** Henüz tamamlanmamış PO sayısı (draft/ordered/partial). */
  openPoCount: number;
  batches: ScorecardBatchRow[];
  /** Geri çekilen parti / toplam parti (0..1); parti yoksa 0. */
  recallRate: number;
  /**
   * Teslim alınan miktarın maliyeti (kuruş) — PARA BİRİMİ BAŞINA AYRI satır
   * (purchase_orders.currency PO başına değişebilir; karışım tek toplama BİRLEŞTİRİLMEZ,
   * sibling CostsService.bySupplier deseni).
   *
   * Satırlar tedarikçinin PO'larının para birimlerinden gelir: hiç PO yoksa boş dizi;
   * PO var ama `unit_cost_cents` NULL ise o para birimi `cents: 0` ile YİNE listelenir
   * (maliyeti girilmemiş alım "yok" gibi gizlenmez).
   */
  totalCostCents: SupplierCostByCurrency[];
  /**
   * KUSUR KARNESİ (§12) — bu tedarikçiden gelip ÖLEN anahtarlar.
   *
   * `recallRate` PARTİ düzeyindedir ("kaç parti geri çekildi") ve anahtar düzeyinde bir kusur
   * oranı panelde HİÇ hesaplanmıyordu. Bu blok o boşluğu kapatır: zayi raporundaki
   * (`CostsService.wastage`) `stock_adjustments → license_items → batches → purchase_orders`
   * zincirinin aynısı, `supplier_id` kırılımıyla.
   */
  defects: SupplierDefects;
}

/** Tedarikçi kusur/iade karnesi. */
export interface SupplierDefects {
  /** Bu tedarikçiden gelen TOPLAM lisans kalemi (parti üzerinden). */
  totalItems: number;
  /** Ölü (quarantined|voided) kalem sayısı. */
  deadItems: number;
  /** deadItems / totalItems (0..1); kalem yoksa 0. */
  defectRate: number;
  /** Henüz hiçbir fişe girmemiş kusurlu kalem — "bildirilmeyi bekliyor". */
  unclaimedItems: number;
  /** Açık (draft|sent) fiş sayısı. */
  openClaims: number;
  /** Kapanmış fişlerde ort. çözülme süresi (gün, sent_at → closed_at); veri yoksa null. */
  avgResolutionDays: number | null;
  /** Fiş kalemlerinin sonuç kırılımı. */
  replacedItems: number;
  rejectedItems: number;
}

/** Tedarikçi teslim-maliyeti (para birimi başına AYRI; panel invaryantı: karışım birleştirilmez). */
export interface SupplierCostByCurrency {
  currency: string;
  cents: number;
}

/**
 * SuppliersService — tedarikçi CRUD (§12). Silme yok; pasifleştirme active=false ile
 * (geçmiş PO/parti referansları korunur).
 */
@Injectable()
export class SuppliersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: { name: string; contact?: string; notes?: string }): Promise<Supplier> {
    const [row] = await this.db
      .insert(suppliers)
      .values({
        name: input.name,
        contact: input.contact ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    return row!;
  }

  async list(): Promise<Supplier[]> {
    return this.db.select().from(suppliers).orderBy(desc(suppliers.createdAt));
  }

  async getById(id: string): Promise<Supplier> {
    const [row] = await this.db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    if (!row) throw new NotFoundException('Tedarikçi bulunamadı');
    return row;
  }

  /**
   * Tedarikçi karnesi (§12) — salt-okunur. PO agregaları (adet/maliyet/lead-time),
   * açık PO sayısı ve parti listesi + geri-çekilme oranı. Tüm sayımlar mevcut
   * tablolardan RAW SQL ile; hiçbir yazma yapılmaz.
   */
  async scorecard(id: string): Promise<SupplierScorecard> {
    const supplier = await this.getById(id);

    // PO agregaları: adet, teslim alınan, açık PO, ort. lead süresi (gün).
    // avgLeadDays: yalnız hem ordered_at hem received_at dolu VE gerçekten KAPANMIŞ
    // (status='received') PO'lardan. Durum koşulu ESKİ VERİ için gerekli: `received_at`
    // eskiden her kısmi teslim almada yazılıyordu (düzeltildi — artık yalnız emir tamamen
    // teslim alınınca yazılır), yani veritabanında hâlâ AÇIK ama tarihi dolu satırlar
    // olabilir. Onlar sayılırsa tedarik süresi olduğundan KISA görünür.
    // Para birimi-bağımsız (adet/lead) tek satır; MALİYET para birimine göre AYRI sorguda
    // (aşağıdaki costRows) — currency GROUP BY bunları çok satıra bölerdi.
    const poAgg = await this.db.execute<{
      po_count: number;
      total_ordered: number;
      total_received: number;
      open_po_count: number;
      avg_lead_days: number | null;
    }>(sql`
      SELECT
        count(*)::int AS po_count,
        coalesce(sum(qty_ordered), 0)::int AS total_ordered,
        coalesce(sum(qty_received), 0)::int AS total_received,
        count(*) FILTER (WHERE status IN ('draft', 'ordered', 'partial'))::int AS open_po_count,
        avg(extract(epoch FROM (received_at - ordered_at)) / 86400.0)
          FILTER (WHERE received_at IS NOT NULL AND ordered_at IS NOT NULL AND status = 'received')
          AS avg_lead_days
      FROM purchase_orders
      WHERE supplier_id = ${id};
    `);
    const agg = (poAgg as unknown as Array<Record<string, unknown>>)[0] ?? {};

    // Teslim-maliyeti PARA BİRİMİ BAŞINA (purchase_orders.currency PO başına değişebilir).
    // totalCostCents = teslim alınan miktar × birim maliyet; karışım tek toplama BİRLEŞTİRİLMEZ.
    //
    // `::bigint` ÇARPANLARDA (sonuçta DEĞİL) — GEREKÇE: `qty_received` ve `unit_cost_cents`
    // kolonları PG `integer`; `int4 * int4` yine int4 döner ve TOPLAMA GİRMEDEN taşar
    // (SQLSTATE 22003 → karne ekranı ham 500). Denetim sınırları buna izin veriyor:
    // controller `unitCostCents` ≤ 2.000.000.000 ve `qtyOrdered` ≤ 1.000.000 kabul ediyor,
    // yani 500 adet × 43.000 ₺ gibi GERÇEKÇİ bir alım bile 2^31-1'i aşıyor. Sondaki
    // `::bigint` cast'i yalnız sum SONUCUNA uygulandığı için çok geç kalıyordu.
    const costRows = await rawRows<{ currency: string; cents: number }>(this.db, sql`
      SELECT
        currency AS currency,
        coalesce(sum(qty_received::bigint * coalesce(unit_cost_cents, 0)::bigint), 0)::bigint AS cents
      FROM purchase_orders
      WHERE supplier_id = ${id}
      GROUP BY currency
      ORDER BY cents DESC, currency ASC;
    `);

    // Parti agregası: geri-çekilme oranı (recalled / toplam).
    const batchAgg = await rawRows<{ total: number; recalled: number }>(this.db, sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'recalled')::int AS recalled
      FROM batches
      WHERE supplier_id = ${id};
    `);
    const bAgg = batchAgg[0] ?? {
      total: 0,
      recalled: 0,
    };
    const batchTotal = Number(bAgg.total ?? 0);
    const recalled = Number(bAgg.recalled ?? 0);

    // Parti listesi (en yeni önce).
    const batchRows = await rawRows<{
      id: string;
      label: string;
      status: string;
      qty_received: number;
      created_at: unknown;
    }>(this.db, sql`
      SELECT id, label, status, qty_received, created_at
      FROM batches
      WHERE supplier_id = ${id}
      ORDER BY created_at DESC;
    `);
    const batches: ScorecardBatchRow[] = batchRows.map((b) => {
      // created_at pg sürücüde Date olarak gelebilir; ISO string'e normalize et.
      const created = b.created_at;
      const createdAt =
        created instanceof Date ? created.toISOString() : String(created);
      return {
        id: b.id,
        label: b.label,
        status: b.status,
        qtyReceived: Number(b.qty_received),
        createdAt,
      };
    });

    const avgLeadRaw = agg['avg_lead_days'];
    const avgLeadDays =
      avgLeadRaw == null ? null : Math.round(Number(avgLeadRaw) * 10) / 10;

    // ── Kusur karnesi ──
    // Tedarikçi zinciri `CostsService.wastage` ile AYNI: parti doğrudan tedarikçi taşımıyorsa
    // satın alma emrinden gelir. İki farklı zincir kullanmak, aynı tedarikçi için iki farklı
    // kusur oranı demektir.
    const defectAgg = await rawRows<{
      total_items: number;
      dead_items: number;
      unclaimed_items: number;
    }>(this.db, sql`
      SELECT
        count(*)::int AS total_items,
        count(*) FILTER (WHERE li.status IN ('quarantined', 'voided'))::int AS dead_items,
        count(*) FILTER (
          WHERE li.status IN ('quarantined', 'voided')
            AND NOT EXISTS (
              SELECT 1 FROM supplier_claim_items sci
              WHERE sci.license_item_id = li.id AND sci.outcome <> 'rejected'
            )
        )::int AS unclaimed_items
      FROM license_items li
      JOIN batches b ON b.id = li.batch_id
      LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id
      WHERE coalesce(b.supplier_id, po.supplier_id) = ${id};
    `);
    const dAgg = defectAgg[0] ?? { total_items: 0, dead_items: 0, unclaimed_items: 0 };
    const totalItems = Number(dAgg.total_items ?? 0);
    const deadItems = Number(dAgg.dead_items ?? 0);

    const claimAgg = await rawRows<{
      open_claims: number;
      avg_days: number | null;
      replaced_items: number;
      rejected_items: number;
    }>(this.db, sql`
      SELECT
        count(*) FILTER (WHERE sc.status IN ('draft', 'sent'))::int AS open_claims,
        avg(extract(epoch FROM (sc.closed_at - sc.sent_at)) / 86400.0)
          FILTER (WHERE sc.closed_at IS NOT NULL AND sc.sent_at IS NOT NULL) AS avg_days,
        coalesce(sum(i.replaced_c), 0)::int AS replaced_items,
        coalesce(sum(i.rejected_c), 0)::int AS rejected_items
      FROM supplier_claims sc
      LEFT JOIN (
        SELECT claim_id,
          count(*) FILTER (WHERE outcome = 'replaced') AS replaced_c,
          count(*) FILTER (WHERE outcome = 'rejected') AS rejected_c
        FROM supplier_claim_items GROUP BY claim_id
      ) i ON i.claim_id = sc.id
      WHERE sc.supplier_id = ${id};
    `);
    const cAgg = claimAgg[0] ?? {
      open_claims: 0,
      avg_days: null,
      replaced_items: 0,
      rejected_items: 0,
    };
    const avgResolutionDays =
      cAgg.avg_days == null ? null : Math.round(Number(cAgg.avg_days) * 10) / 10;

    return {
      supplier,
      poCount: Number(agg['po_count'] ?? 0),
      totalOrdered: Number(agg['total_ordered'] ?? 0),
      totalReceived: Number(agg['total_received'] ?? 0),
      avgLeadDays,
      openPoCount: Number(agg['open_po_count'] ?? 0),
      batches,
      recallRate: batchTotal > 0 ? recalled / batchTotal : 0,
      totalCostCents: costRows.map((r) => ({
        currency: r.currency,
        cents: Number(r.cents),
      })),
      defects: {
        totalItems,
        deadItems,
        defectRate: totalItems > 0 ? deadItems / totalItems : 0,
        unclaimedItems: Number(dAgg.unclaimed_items ?? 0),
        openClaims: Number(cAgg.open_claims ?? 0),
        avgResolutionDays,
        replacedItems: Number(cAgg.replaced_items ?? 0),
        rejectedItems: Number(cAgg.rejected_items ?? 0),
      },
    };
  }

  /** Kısmi güncelleme (ör. active=false ile pasifleştirme). */
  async update(
    id: string,
    patch: { name?: string; contact?: string | null; notes?: string | null; active?: boolean },
  ): Promise<Supplier> {
    await this.getById(id);
    const [row] = await this.db
      .update(suppliers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    return row!;
  }
}
