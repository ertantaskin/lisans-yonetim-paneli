import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
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
  /** Teslim alınan miktarın toplam maliyeti (kuruş); unit_cost_cents × qty_received. */
  totalCostCents: number;
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

    // PO agregaları: adet, teslim alınan, açık PO, ort. lead süresi (gün), toplam maliyet.
    // avgLeadDays: yalnız hem ordered_at hem received_at dolu PO'lardan (teslim alınanlar).
    // totalCostCents: teslim alınan miktar × birim maliyet (gerçekleşen harcama).
    const poAgg = await this.db.execute<{
      po_count: number;
      total_ordered: number;
      total_received: number;
      open_po_count: number;
      avg_lead_days: number | null;
      total_cost_cents: number;
    }>(sql`
      SELECT
        count(*)::int AS po_count,
        coalesce(sum(qty_ordered), 0)::int AS total_ordered,
        coalesce(sum(qty_received), 0)::int AS total_received,
        count(*) FILTER (WHERE status IN ('draft', 'ordered', 'partial'))::int AS open_po_count,
        avg(extract(epoch FROM (received_at - ordered_at)) / 86400.0)
          FILTER (WHERE received_at IS NOT NULL AND ordered_at IS NOT NULL) AS avg_lead_days,
        coalesce(sum(qty_received * coalesce(unit_cost_cents, 0)), 0)::bigint AS total_cost_cents
      FROM purchase_orders
      WHERE supplier_id = ${id};
    `);
    const agg = (poAgg as unknown as Array<Record<string, unknown>>)[0] ?? {};

    // Parti agregası: geri-çekilme oranı (recalled / toplam).
    const batchAgg = await this.db.execute<{ total: number; recalled: number }>(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE status = 'recalled')::int AS recalled
      FROM batches
      WHERE supplier_id = ${id};
    `);
    const bAgg = (batchAgg as unknown as Array<{ total: number; recalled: number }>)[0] ?? {
      total: 0,
      recalled: 0,
    };
    const batchTotal = Number(bAgg.total ?? 0);
    const recalled = Number(bAgg.recalled ?? 0);

    // Parti listesi (en yeni önce).
    const batchRows = await this.db.execute(sql`
      SELECT id, label, status, qty_received, created_at
      FROM batches
      WHERE supplier_id = ${id}
      ORDER BY created_at DESC;
    `);
    const batches: ScorecardBatchRow[] = (
      batchRows as unknown as Array<{
        id: string;
        label: string;
        status: string;
        qty_received: number;
        created_at: unknown;
      }>
    ).map((b) => {
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

    return {
      supplier,
      poCount: Number(agg['po_count'] ?? 0),
      totalOrdered: Number(agg['total_ordered'] ?? 0),
      totalReceived: Number(agg['total_received'] ?? 0),
      avgLeadDays,
      openPoCount: Number(agg['open_po_count'] ?? 0),
      batches,
      recallRate: batchTotal > 0 ? recalled / batchTotal : 0,
      totalCostCents: Number(agg['total_cost_cents'] ?? 0),
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
