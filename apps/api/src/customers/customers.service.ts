import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { customers } from '../db/schema/customers';

/** Liste satırı — sipariş/atama/değişim sayıları anlık türetilir (§13). */
export interface CustomerListRow {
  email: string;
  orderCount: number;
  assignmentCount: number;
  replacementCount: number;
  replacementRate: number;
  tags: string[];
  /** Müşterinin sipariş verdiği site alan adları (site süzgeci uygulandıysa tek eleman). */
  sites: string[];
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

  /**
   * Müşteri listesi — e-posta bazlı toplulaştırma; search → e-posta ILIKE.
   * `siteId` verilirse SADECE o siteden sipariş vermiş müşteriler döner ve sipariş/atama/
   * değişim sayıları O SİTEYE göre kapsanır (site → müşteri hiyerarşisi, §13). Her satıra
   * müşterinin sipariş verdiği site alan adları (`sites`) eklenir → global görünümde
   * hangi site(ler) olduğu bir bakışta görünür.
   */
  async list(opts?: { search?: string; siteId?: string }): Promise<{ items: CustomerListRow[] }> {
    const term = opts?.search?.trim();
    const siteId = opts?.siteId?.trim();

    // Ana WHERE (orders alias o) — search + opsiyonel site süzgeci.
    // PERF: aramayı SARGABLE yap — önek yolu lower(customer_email) LIKE lower(term)||'%'
    // (orders_email_lower_idx fonksiyonel indeksi kullanılabilir) + contains ILIKE fallback ile OR.
    // Önek ⊆ contains olduğundan birleşim = ESKİ contains davranışıyla AYNEN aynı eşleşme kümesi;
    // yalnız planlayıcıya indeks yolu açılır (dönüş/eşleşme davranışı korunur).
    const searchCond = term
      ? sql`(lower(o.customer_email) LIKE lower(${term}) || '%' OR o.customer_email ILIKE ${'%' + term + '%'})`
      : null;
    const siteCond = siteId ? sql`o.site_id = ${siteId}` : null;
    let whereClause = sql``;
    if (searchCond && siteCond) whereClause = sql`WHERE ${searchCond} AND ${siteCond}`;
    else if (searchCond) whereClause = sql`WHERE ${searchCond}`;
    else if (siteCond) whereClause = sql`WHERE ${siteCond}`;

    // Alt-sorgu site kapsamı — atama/değişim sayıları da site süzgecine uymalı. Artık ana WHERE
    // değil, aşağıdaki `emails` kümesi filtresine EK koşul (AND) olarak bağlanır.
    const asgSiteFilter = siteId ? sql`AND ord.site_id = ${siteId}` : sql``;
    const repSiteFilter = siteId ? sql`AND site_id = ${siteId}` : sql``;

    // PERF: filtrelenmiş (search+siteId) e-posta kümesini önce CTE'ye (scoped_orders → emails) çıkar.
    // Atama/değişim agregatları ARTIK TÜM tabloyu email bazında toplamıyor; yalnız bu kümeyi tarar
    // (IN (SELECT email FROM emails)) — tek müşteri arandığında bile tam-tablo group-by yapılmıyordu.
    // NOT (denetim): dış sorguya LIMIT KOYULMAZ. /customers arama İSTEMCİ-TARAFLI (customers-table.tsx
    // filterFn); bir LIMIT, dönen ilk N dışındaki eski müşterileri aramada "yok" gösterirdi (sessiz
    // veri kaybı). CTE optimizasyonu maliyeti zaten sınırlar; sıralamaya stabil ikincil anahtar (email)
    // eklenir (eşit zaman damgasında deterministik). Sunucu-taraflı sayfalama gerekirse ayrı iş.
    const rows = await rawRows<{
      email: string;
      order_count: number;
      first_order_at: Date | string | null;
      last_order_at: Date | string | null;
      assignment_count: number;
      replacement_count: number;
      sites: string[] | null;
      tags: string[] | null;
    }>(this.db, sql`
      WITH scoped_orders AS (
        SELECT o.id, o.site_id, o.created_at, lower(o.customer_email) AS email
        FROM orders o
        ${whereClause}
      ),
      emails AS (
        SELECT DISTINCT email FROM scoped_orders
      )
      SELECT
        so.email AS email,
        COUNT(DISTINCT so.id)::int AS order_count,
        MIN(so.created_at) AS first_order_at,
        MAX(so.created_at) AS last_order_at,
        COALESCE(
          array_agg(DISTINCT st.domain) FILTER (WHERE st.domain IS NOT NULL),
          '{}'
        )::text[] AS sites,
        COALESCE(a.assignment_count, 0)::int AS assignment_count,
        COALESCE(r.replacement_count, 0)::int AS replacement_count,
        COALESCE(c.tags, '{}')::text[] AS tags
      FROM scoped_orders so
      LEFT JOIN sites st ON st.id = so.site_id
      LEFT JOIN (
        SELECT lower(ord.customer_email) AS email, COUNT(asg.id) AS assignment_count
        FROM assignments asg
        JOIN orders ord ON ord.id = asg.order_id
        WHERE lower(ord.customer_email) IN (SELECT email FROM emails) ${asgSiteFilter}
        GROUP BY lower(ord.customer_email)
      ) a ON a.email = so.email
      LEFT JOIN (
        SELECT lower(customer_email) AS email, COUNT(*) AS replacement_count
        FROM replacement_requests
        WHERE status = 'approved' AND lower(customer_email) IN (SELECT email FROM emails) ${repSiteFilter}
        GROUP BY lower(customer_email)
      ) r ON r.email = so.email
      LEFT JOIN customers c ON c.email = so.email
      GROUP BY so.email, a.assignment_count, r.replacement_count, c.tags
      ORDER BY MAX(so.created_at) DESC, so.email ASC
    `);

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
        sites: row.sites ?? [],
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
    const statRows = await rawRows<{
      order_count: number;
      assignment_count: number;
      replacement_count: number;
    }>(this.db, sql`
      SELECT
        (SELECT COUNT(*)::int FROM orders o WHERE lower(o.customer_email) = ${key}) AS order_count,
        (SELECT COUNT(*)::int FROM assignments asg
           JOIN orders o ON o.id = asg.order_id
           WHERE lower(o.customer_email) = ${key}) AS assignment_count,
        (SELECT COUNT(*)::int FROM replacement_requests
           WHERE lower(customer_email) = ${key} AND status = 'approved') AS replacement_count
    `);
    const s = statRows[0] ?? { order_count: 0, assignment_count: 0, replacement_count: 0 };
    const assignmentCount = Number(s.assignment_count);
    const replacementCount = Number(s.replacement_count);

    // Sipariş geçmişi.
    const orderRows = await rawRows<{
      id: string;
      remote_order_id: string;
      status: string;
      created_at: Date | string;
    }>(this.db, sql`
      SELECT id, remote_order_id, status, created_at
      FROM orders
      WHERE lower(customer_email) = ${key}
      ORDER BY created_at DESC
    `);

    // Değişim geçmişi — RAW SQL (drizzle import YOK).
    const replacementRows = await rawRows<{
      id: string;
      status: string;
      reason: string;
      created_at: Date | string;
    }>(this.db, sql`
      SELECT id, status, reason, created_at
      FROM replacement_requests
      WHERE lower(customer_email) = ${key}
      ORDER BY created_at DESC
    `);

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
