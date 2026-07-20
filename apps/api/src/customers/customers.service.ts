import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { customers } from '../db/schema/customers';

/** Liste satırı — sipariş/atama/değişim sayıları anlık türetilir (§13). */
export interface CustomerListRow {
  email: string;
  orderCount: number;
  assignmentCount: number;
  replacementCount: number;
  replacementRate: number;
  tags: string[];
  firstOrderAt: string | null;
  lastOrderAt: string | null;
}

/** Müşteri detayı — kalıcı meta (tags/notes) + türetilmiş istatistik + geçmiş. */
export interface CustomerDetail {
  email: string;
  tags: string[];
  notes: string | null;
  stats: {
    orderCount: number;
    assignmentCount: number;
    replacementCount: number;
    replacementRate: number;
  };
  orders: Array<{ id: string; remoteOrderId: string; status: string; createdAt: string }>;
  replacements: Array<{ id: string; status: string; reason: string; createdAt: string }>;
}

/**
 * replacementRate = onaylı değişim / GREATEST(atama, 1) — sıfıra bölme yok.
 * 4 haneye yuvarlanır (yüzde gösterimi tüketicide yapılır).
 */
function rate(replacementCount: number, assignmentCount: number): number {
  return Math.round((replacementCount / Math.max(assignmentCount, 1)) * 10000) / 10000;
}

/**
 * Müşteri servisi (§13). Sipariş/atama sayıları orders/assignments üzerinden anlık
 * hesaplanır; replacement sayıları RAW SQL ile replacement_requests'ten okunur
 * (drizzle şema bağımlılığı YOK — tablo migration sonrası var). e-posta lowercase kanonik.
 */
@Injectable()
export class CustomersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Müşteri listesi — e-posta bazlı toplulaştırma; search → e-posta ILIKE. */
  async list(search?: string): Promise<{ items: CustomerListRow[] }> {
    const term = search?.trim();
    const filter = term ? sql`WHERE o.customer_email ILIKE ${'%' + term + '%'}` : sql``;
    const rows = (await this.db.execute(sql`
      SELECT
        lower(o.customer_email) AS email,
        COUNT(DISTINCT o.id)::int AS order_count,
        MIN(o.created_at) AS first_order_at,
        MAX(o.created_at) AS last_order_at,
        COALESCE(a.assignment_count, 0)::int AS assignment_count,
        COALESCE(r.replacement_count, 0)::int AS replacement_count,
        COALESCE(c.tags, '{}')::text[] AS tags
      FROM orders o
      LEFT JOIN (
        SELECT lower(ord.customer_email) AS email, COUNT(asg.id) AS assignment_count
        FROM assignments asg
        JOIN orders ord ON ord.id = asg.order_id
        GROUP BY lower(ord.customer_email)
      ) a ON a.email = lower(o.customer_email)
      LEFT JOIN (
        SELECT lower(customer_email) AS email, COUNT(*) AS replacement_count
        FROM replacement_requests
        WHERE status = 'approved'
        GROUP BY lower(customer_email)
      ) r ON r.email = lower(o.customer_email)
      LEFT JOIN customers c ON c.email = lower(o.customer_email)
      ${filter}
      GROUP BY lower(o.customer_email), a.assignment_count, r.replacement_count, c.tags
      ORDER BY MAX(o.created_at) DESC
    `)) as unknown as Array<{
      email: string;
      order_count: number;
      first_order_at: Date | string | null;
      last_order_at: Date | string | null;
      assignment_count: number;
      replacement_count: number;
      tags: string[] | null;
    }>;

    const items = rows.map((row) => {
      const assignmentCount = Number(row.assignment_count);
      const replacementCount = Number(row.replacement_count);
      return {
        email: row.email,
        orderCount: Number(row.order_count),
        assignmentCount,
        replacementCount,
        replacementRate: rate(replacementCount, assignmentCount),
        tags: row.tags ?? [],
        firstOrderAt: row.first_order_at ? new Date(row.first_order_at).toISOString() : null,
        lastOrderAt: row.last_order_at ? new Date(row.last_order_at).toISOString() : null,
      };
    });
    return { items };
  }

  /** Tek müşteri detayı — kalıcı meta + istatistik + sipariş/değişim geçmişi. */
  async detail(email: string): Promise<CustomerDetail> {
    const key = email.trim().toLowerCase();

    // Kalıcı meta (varsa) — tags/notes.
    const [meta] = await this.db
      .select({ tags: customers.tags, notes: customers.notes })
      .from(customers)
      .where(eq(customers.email, key))
      .limit(1);

    // Türetilmiş istatistik (orders/assignments + RAW replacement_requests).
    const statRows = (await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM orders o WHERE lower(o.customer_email) = ${key}) AS order_count,
        (SELECT COUNT(*)::int FROM assignments asg
           JOIN orders o ON o.id = asg.order_id
           WHERE lower(o.customer_email) = ${key}) AS assignment_count,
        (SELECT COUNT(*)::int FROM replacement_requests
           WHERE lower(customer_email) = ${key} AND status = 'approved') AS replacement_count
    `)) as unknown as Array<{
      order_count: number;
      assignment_count: number;
      replacement_count: number;
    }>;
    const s = statRows[0] ?? { order_count: 0, assignment_count: 0, replacement_count: 0 };
    const assignmentCount = Number(s.assignment_count);
    const replacementCount = Number(s.replacement_count);

    // Sipariş geçmişi.
    const orderRows = (await this.db.execute(sql`
      SELECT id, remote_order_id, status, created_at
      FROM orders
      WHERE lower(customer_email) = ${key}
      ORDER BY created_at DESC
    `)) as unknown as Array<{
      id: string;
      remote_order_id: string;
      status: string;
      created_at: Date | string;
    }>;

    // Değişim geçmişi — RAW SQL (drizzle import YOK).
    const replacementRows = (await this.db.execute(sql`
      SELECT id, status, reason, created_at
      FROM replacement_requests
      WHERE lower(customer_email) = ${key}
      ORDER BY created_at DESC
    `)) as unknown as Array<{
      id: string;
      status: string;
      reason: string;
      created_at: Date | string;
    }>;

    return {
      email: key,
      tags: meta?.tags ?? [],
      notes: meta?.notes ?? null,
      stats: {
        orderCount: Number(s.order_count),
        assignmentCount,
        replacementCount,
        replacementRate: rate(replacementCount, assignmentCount),
      },
      orders: orderRows.map((o) => ({
        id: o.id,
        remoteOrderId: o.remote_order_id,
        status: o.status,
        createdAt: new Date(o.created_at).toISOString(),
      })),
      replacements: replacementRows.map((r) => ({
        id: r.id,
        status: r.status,
        reason: r.reason,
        createdAt: new Date(r.created_at).toISOString(),
      })),
    };
  }

  /**
   * Müşteri meta güncelle (upsert) — yalnız verilen alanlar değişir. e-posta lowercase.
   * Kayıt yoksa oluşturulur (varsayılan tags=[], notes=null).
   */
  async update(
    email: string,
    input: { tags?: string[]; notes?: string | null },
  ): Promise<{ email: string; tags: string[]; notes: string | null }> {
    const key = email.trim().toLowerCase();

    // onConflictDoUpdate set'i yalnız verilen alanları içerir; updatedAt daima tazelenir.
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (input.tags !== undefined) set.tags = input.tags;
    if (input.notes !== undefined) set.notes = input.notes;

    const [row] = await this.db
      .insert(customers)
      .values({
        email: key,
        tags: input.tags ?? [],
        notes: input.notes ?? null,
      })
      .onConflictDoUpdate({ target: customers.email, set })
      .returning({ email: customers.email, tags: customers.tags, notes: customers.notes });

    return { email: row.email, tags: row.tags, notes: row.notes };
  }
}
