import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';

/** Genel-bakış son sipariş satırı (özet — sır/payload YOK). */
export interface DashboardRecentOrder {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
  createdAt: string;
}

/**
 * Panel genel-bakış özeti (§13). Tümü mevcut tablolardan salt-okunur agregasyon;
 * yeni tablo/migration yok. KPI'lar tek doğruluk kaynağından (panel) türetilir.
 */
export interface DashboardSummary {
  /** Teslim bekleyen sipariş satırı (order_lines.status IN pending|partial). */
  pendingLines: number;
  /** Bugün (yerel gün başı, sunucu TZ) oluşturulan sipariş sayısı. */
  todayOrders: number;
  /** Düşük stok ürünü sayısı (low_stock_threshold IS NOT NULL AND available<=eşik). */
  lowStockCount: number;
  /** Açık değişim talebi (status IN open|info_requested). */
  openReplacements: number;
  /** Açık güvenlik olayı — son 7 gün penceresi (security_events'te resolved kolonu yok). */
  openSecurityEvents: number;
  /** Toplam anlık atanabilir stok (products.service.list ile aynı mantık). */
  totalAvailableStock: number;
  /** En yeni 5 sipariş (özet). */
  recentOrders: DashboardRecentOrder[];
}

/**
 * Genel-bakış (dashboard) servisi (§13) — salt-okunur agregasyon. Hiçbir yazma/yan
 * etki yapmaz; KPI blokları paralel toplanır. low_stock eşiği W1 ürün detayıyla aynı
 * tanım (products.low_stock_threshold); güvenlik olayları SecurityService ile aynı tablo.
 */
@Injectable()
export class DashboardService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Tüm KPI bloklarını paralel toplayıp tek özet nesnesi döndürür. */
  async summary(): Promise<DashboardSummary> {
    const [
      pendingLines,
      todayOrders,
      lowStockCount,
      openReplacements,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    ] = await Promise.all([
      this.pendingLines(),
      this.todayOrders(),
      this.lowStockCount(),
      this.openReplacements(),
      this.openSecurityEvents(),
      this.totalAvailableStock(),
      this.recentOrders(),
    ]);
    return {
      pendingLines,
      todayOrders,
      lowStockCount,
      openReplacements,
      openSecurityEvents,
      totalAvailableStock,
      recentOrders,
    };
  }

  /** Teslim bekleyen satır sayısı (pending + partial). */
  private async pendingLines(): Promise<number> {
    const rows = await this.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM order_lines
      WHERE status IN ('pending', 'partial');
    `);
    return Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
  }

  /** Bugün (gün başından itibaren) oluşturulan sipariş sayısı. */
  private async todayOrders(): Promise<number> {
    const rows = await this.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM orders
      WHERE created_at >= date_trunc('day', now());
    `);
    return Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
  }

  /**
   * Düşük stok ürünü sayısı. available = status='available' license_item'ların
   * (max_uses - use_count) toplamı (products.service.list ile aynı). Yalnız eşiği
   * TANIMLI ürünler (IS NOT NULL) değerlendirilir; available <= eşik olanlar sayılır.
   */
  private async lowStockCount(): Promise<number> {
    const rows = await this.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM (
        SELECT
          p.id,
          p.low_stock_threshold AS threshold,
          coalesce((
            SELECT sum(li.max_uses - li.use_count)
            FROM license_items li
            WHERE li.product_id = p.id AND li.status = 'available'
          ), 0) AS available
        FROM products p
        WHERE p.low_stock_threshold IS NOT NULL
      ) t
      WHERE t.available <= t.threshold;
    `);
    return Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
  }

  /** Açık değişim/garanti talebi (open + info_requested). RAW SQL (şema import edilmez). */
  private async openReplacements(): Promise<number> {
    const rows = await this.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM replacement_requests
      WHERE status IN ('open', 'info_requested');
    `);
    return Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
  }

  /**
   * Açık güvenlik olayı. security_events'te çözüldü/kapatıldı kolonu YOK (§15: kayıt
   * yüzeye çıkar, aksiyon insanda); bu yüzden "açık" = son 7 gün penceresindeki olaylar.
   */
  private async openSecurityEvents(): Promise<number> {
    const rows = await this.db.execute<{ c: number }>(sql`
      SELECT count(*)::int AS c
      FROM security_events
      WHERE created_at >= now() - interval '7 days';
    `);
    return Number((rows as unknown as Array<{ c: number }>)[0]?.c ?? 0);
  }

  /** Toplam anlık atanabilir stok (available kapasite toplamı). */
  private async totalAvailableStock(): Promise<number> {
    const rows = await this.db.execute<{ total: number }>(sql`
      SELECT coalesce(sum(max_uses - use_count), 0)::int AS total
      FROM license_items
      WHERE status = 'available';
    `);
    return Number((rows as unknown as Array<{ total: number }>)[0]?.total ?? 0);
  }

  /** En yeni 5 sipariş (özet satır — sır/payload dönmez). */
  private async recentOrders(): Promise<DashboardRecentOrder[]> {
    const rows = await this.db.execute<{
      id: string;
      remote_order_id: string;
      customer_email: string;
      status: string;
      created_at: string;
    }>(sql`
      SELECT id, remote_order_id, customer_email, status, created_at
      FROM orders
      ORDER BY created_at DESC
      LIMIT 5;
    `);
    const list = rows as unknown as Array<{
      id: string;
      remote_order_id: string;
      customer_email: string;
      status: string;
      created_at: string;
    }>;
    return list.map((r) => ({
      id: r.id,
      remoteOrderId: r.remote_order_id,
      customerEmail: r.customer_email,
      status: r.status,
      // pg timestamptz → ISO (Date ile normalize; string/Date ikisini de karşılar).
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }
}
