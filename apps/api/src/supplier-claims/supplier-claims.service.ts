import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { auditLog } from '../db/schema/audit';
import { supplierClaimItems, supplierClaims } from '../db/schema/supplierClaims';
import { AdminOrdersService } from '../orders/admin-orders.service';

/** Fiş özeti (liste satırı). */
export interface ClaimRow {
  id: string;
  code: string;
  status: string;
  supplierId: string | null;
  supplierName: string | null;
  periodFrom: Date | null;
  periodTo: Date | null;
  itemCount: number;
  note: string | null;
  reference: string | null;
  createdBy: string;
  createdAt: Date;
  sentAt: Date | null;
  closedAt: Date | null;
  /** Kalem sonuç kırılımı — liste ekranı "9 yenilendi · 3 reddedildi" diyebilsin. */
  pendingCount: number;
  replacedCount: number;
  creditedCount: number;
  rejectedCount: number;
}

export interface ClaimItemRow {
  id: string;
  licenseItemId: string;
  productId: string | null;
  batchId: string | null;
  batchLabel: string | null;
  productName: string | null;
  sku: string | null;
  /** 'key' | 'account' | 'code' | 'custom' — fiş anındaki ürün tipi (eski fişlerde null). */
  productKind: string | null;
  keySnapshot: string | null;
  reason: string | null;
  defectKind: string | null;
  quarantinedAt: Date | null;
  outcome: string;
  outcomeNote: string | null;
  resolvedAt: Date | null;
}

/** Fiş kesme isteği (Z raporu). */
export interface CreateClaimInput {
  supplierId: string;
  /** ISO tarih — karantina penceresi (dahil). */
  from?: string;
  to?: string;
  /** Operatörün listeden ÇIKARDIĞI kalemler. */
  excludeLicenseItemIds?: string[];
  note?: string;
}

/** Fiş kesilirken tek seferde alınabilecek en fazla kalem. */
const MAX_CLAIM_ITEMS = 2000;
const MAX_NOTE_CHARS = 2000;

/**
 * Tedarikçi değişim fişleri (§12) — "kusurlu anahtarları tedarikçiye bildir, cevabını takip et".
 *
 * NEDEN VAR: panel "bu kusurlu anahtarı tedarikçiye bildirdim mi?" sorusuna cevap veremiyordu.
 * Tek bildirim yolu izi olmayan bir tarayıcı indirmesiydi → aynı anahtar defalarca
 * bildirilebiliyor, tedarikçinin yanıtı hiçbir yere yazılmıyordu.
 *
 * MODEL: fiş bir "Z raporu"dur. Seçilen tarih penceresinde biriken, HENÜZ BİLDİRİLMEMİŞ
 * kusurlular tek seferde DONAR (snapshot) ve bir daha havuzda görünmez. Tedarikçi bir kalemi
 * reddederse o kalem havuza GERİ DÖNER (`outcome='rejected'` kısmi unique index'in dışındadır).
 *
 * ADAY SORGUSU YENİDEN YAZILMAZ: `AdminOrdersService.listQuarantine` zaten parti/tedarikçi/sebep/
 * tarih birleştirmesini yapan, denetimden geçmiş tek kaynaktır (üç ayrı sebep kaynağını coalesce
 * eder, tarih ön-filtresi + kesin süzgeç uygular). İkinci bir sorgu yazmak iki tanım demektir ve
 * bu projede tam olarak o hata "satılmış 6 birim" yanılgısını üretmişti.
 */
@Injectable()
export class SupplierClaimsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly adminOrders: AdminOrdersService,
  ) {}

  /**
   * Z raporu ADAYLARI: pencere içinde biriken, henüz bildirilmemiş kusurlu kalemler.
   * `claimed: 'none'` süzgeci ile açık fişte olanlar dışarıda kalır (reddedilenler DAHİL —
   * onlar havuza geri döndü).
   */
  async candidates(params: {
    supplierId: string;
    from?: string;
    to?: string;
    reveal: boolean;
    actor: string;
  }) {
    const res = await this.adminOrders.listQuarantine({
      supplierId: params.supplierId,
      from: params.from,
      to: params.to,
      claimed: 'none',
      limit: MAX_CLAIM_ITEMS,
      reveal: params.reveal,
      actor: params.actor,
    });
    return res;
  }

  /**
   * FİŞ KES. Tek transaction; başında GLOBAL advisory-lock.
   *
   * Kilit neden global (tedarikçi başına değil): (a) fiş NUMARASI gün bazında sıralı üretiliyor —
   * iki farklı tedarikçi için eşzamanlı iki fiş aynı numarayı alabilirdi; (b) fiş kesme nadir,
   * elle tetiklenen bir işlem, serileştirmenin maliyeti yok. Kalem yarışını zaten kısmi unique
   * index kesin olarak kapatıyor; kilit onu 23505 yerine anlaşılır bir sonuca çeviriyor.
   */
  async create(input: CreateClaimInput, actor: string, reveal: boolean) {
    const exclude = new Set((input.excludeLicenseItemIds ?? []).map((v) => String(v)));

    // Adaylar KİLİDİN ALTINDA yeniden okunur: operatör önizlemeyi açtıktan sonra başka biri
    // fiş kesmiş ya da yeni kusur düşmüş olabilir. Önizlemedeki listeye güvenmek, aynı kalemi
    // iki fişe sokmayı denemek (ve 23505 almak) demektir.
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('supplier_claim:create'))`);

      const [supplier] = await rawRows<{ id: string; name: string }>(tx, sql`
        SELECT id, name FROM suppliers WHERE id = ${input.supplierId} LIMIT 1;
      `);
      if (!supplier) throw new NotFoundException('Tedarikçi bulunamadı');

      // NOT (bilinçli): `listQuarantine` kendi bağlantısından (this.db) okur, `tx`'ten DEĞİL.
      // Doğruluğu bozmaz — advisory-lock eşzamanlı diğer fiş kesmeyi BLOKLADIĞI için o
      // transaction'ın satırları henüz commit EDİLMEMİŞTİR ve zaten görünmez; biz de kendi
      // insert'lerimizden ÖNCE okuyoruz. Kilit ayrıca bağlantı açlığını da sınırlar (aynı anda
      // en fazla bir fiş kesme). Sorguyu tx'e taşımak `listQuarantine`'i (üç sebep kaynağını
      // coalesce eden, denetimden geçmiş tek kaynak) parametreleştirmeyi gerektirirdi.
      const pool = await this.adminOrders.listQuarantine({
        supplierId: input.supplierId,
        from: input.from,
        to: input.to,
        claimed: 'none',
        limit: MAX_CLAIM_ITEMS,
        // Fişin İÇİNE yazılan anahtar snapshot'ı çağıranın yetkisiyle sınırlıdır: owner-olmayan
        // admin fiş kesebilir ama dosyaya düz anahtar YAZILMAZ (maskeli snapshot kalıcıdır).
        reveal,
        actor,
      });

      const picked = pool.rows.filter((r) => !exclude.has(r.licenseItemId));
      if (picked.length === 0) {
        throw new BadRequestException(
          'Fişe girecek kalem yok — seçilen aralıkta bildirilmemiş kusurlu anahtar bulunamadı.',
        );
      }

      const code = await this.nextCode(tx);
      const [claim] = await tx
        .insert(supplierClaims)
        .values({
          code,
          supplierId: input.supplierId,
          status: 'draft',
          periodFrom: input.from ? new Date(input.from) : null,
          periodTo: input.to ? new Date(input.to) : null,
          note: input.note ? input.note.slice(0, MAX_NOTE_CHARS) : null,
          itemCount: picked.length,
          createdBy: actor,
        })
        .returning({ id: supplierClaims.id, code: supplierClaims.code });

      await tx.insert(supplierClaimItems).values(
        picked.map((r) => ({
          claimId: claim!.id,
          licenseItemId: r.licenseItemId,
          productId: r.productId ?? null,
          batchId: r.batchId ?? null,
          // ── SNAPSHOT: rapor sonradan kaymasın ──
          batchLabel: r.batchCode ?? null,
          productName: r.productName ?? null,
          sku: r.sku ?? null,
          productKind: r.productKind ?? null,
          keySnapshot: r.keyPreview ?? null,
          reason: r.reason ?? null,
          defectKind: r.defectKind ?? null,
          quarantinedAt: r.quarantinedAt ?? null,
        })),
      );

      await tx.insert(auditLog).values({
        // `audit_action` bir PG enum'dur; yeni değer migration gerektirir → mevcut 'adjust' +
        // meta.op deseni (stock.service ile aynı) kullanılır.
        action: 'adjust',
        actor,
        targetType: 'supplier_claim',
        targetId: claim!.id,
        meta: {
          op: 'claim_create',
          code: claim!.code,
          supplierId: input.supplierId,
          items: picked.length,
          from: input.from ?? null,
          to: input.to ?? null,
        },
      });

      return { id: claim!.id, code: claim!.code, itemCount: picked.length };
    });
  }

  /**
   * Fiş numarası: `DEG-YYYYMMDD-NN`. Aynı gün içindeki sıra numarası kilit altında sayılır.
   * `LIKE` üzerinden saymak yerine `code` UNIQUE index'i son güvencedir (çakışırsa insert patlar,
   * sessizce yanlış numara üretilmez).
   */
  private async nextCode(tx: Database): Promise<string> {
    const day = new Date();
    const stamp = `${day.getFullYear()}${String(day.getMonth() + 1).padStart(2, '0')}${String(
      day.getDate(),
    ).padStart(2, '0')}`;
    const prefix = `DEG-${stamp}-`;
    const [row] = await rawRows<{ c: number }>(tx, sql`
      SELECT count(*)::int AS c FROM supplier_claims WHERE code LIKE ${prefix + '%'};
    `);
    return `${prefix}${String(Number(row?.c ?? 0) + 1).padStart(2, '0')}`;
  }

  /**
   * Fiş listesi (en yeni önce). `onlyId` verilirse TEK fiş döner — detay ekranı ayrı bir sorgu
   * kullanmaz (`listBatches(onlyId)` deseni: iki tanım zamanla ayrışır, sayaçlar çelişir).
   */
  async list(
    params: { status?: string; supplierId?: string; onlyId?: string } = {},
  ): Promise<ClaimRow[]> {
    const conds = [sql`true`];
    if (params.onlyId) conds.push(sql`sc.id = ${params.onlyId}`);
    if (params.status) conds.push(sql`sc.status = ${params.status}::supplier_claim_status`);
    if (params.supplierId) conds.push(sql`sc.supplier_id = ${params.supplierId}`);

    const rows = await rawRows<{
      id: string;
      code: string;
      status: string;
      supplier_id: string | null;
      supplier_name: string | null;
      period_from: string | null;
      period_to: string | null;
      item_count: number;
      note: string | null;
      reference: string | null;
      created_by: string;
      created_at: string;
      sent_at: string | null;
      closed_at: string | null;
      pending_c: number;
      replaced_c: number;
      credited_c: number;
      rejected_c: number;
    }>(this.db, sql`
      SELECT sc.id, sc.code, sc.status::text AS status, sc.supplier_id, s.name AS supplier_name,
             sc.period_from, sc.period_to, sc.item_count, sc.note, sc.reference,
             sc.created_by, sc.created_at, sc.sent_at, sc.closed_at,
             coalesce(i.pending_c, 0)::int  AS pending_c,
             coalesce(i.replaced_c, 0)::int AS replaced_c,
             coalesce(i.credited_c, 0)::int AS credited_c,
             coalesce(i.rejected_c, 0)::int AS rejected_c
      FROM supplier_claims sc
      LEFT JOIN suppliers s ON s.id = sc.supplier_id
      LEFT JOIN (
        SELECT claim_id,
          count(*) FILTER (WHERE outcome = 'pending')  AS pending_c,
          count(*) FILTER (WHERE outcome = 'replaced') AS replaced_c,
          count(*) FILTER (WHERE outcome = 'credited') AS credited_c,
          count(*) FILTER (WHERE outcome = 'rejected') AS rejected_c
        FROM supplier_claim_items GROUP BY claim_id
      ) i ON i.claim_id = sc.id
      WHERE ${sql.join(conds, sql` AND `)}
      ORDER BY sc.created_at DESC, sc.id DESC
      LIMIT 500;
    `);

    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      supplierId: r.supplier_id,
      supplierName: r.supplier_name,
      periodFrom: r.period_from ? new Date(r.period_from) : null,
      periodTo: r.period_to ? new Date(r.period_to) : null,
      itemCount: Number(r.item_count),
      note: r.note,
      reference: r.reference,
      createdBy: r.created_by,
      createdAt: new Date(r.created_at),
      sentAt: r.sent_at ? new Date(r.sent_at) : null,
      closedAt: r.closed_at ? new Date(r.closed_at) : null,
      pendingCount: Number(r.pending_c),
      replacedCount: Number(r.replaced_c),
      creditedCount: Number(r.credited_c),
      rejectedCount: Number(r.rejected_c),
    }));
  }

  /** Fiş + kalemleri. Kalem anahtarları SNAPSHOT'tan okunur (canlı veriden DEĞİL). */
  async detail(id: string): Promise<{ claim: ClaimRow; items: ClaimItemRow[] }> {
    const [claim] = await this.list({ onlyId: id });
    if (!claim) throw new NotFoundException('Fiş bulunamadı');

    const items = await this.db
      .select()
      .from(supplierClaimItems)
      .where(eq(supplierClaimItems.claimId, id))
      .orderBy(desc(supplierClaimItems.quarantinedAt), supplierClaimItems.id);

    return {
      claim,
      items: items.map((i) => ({
        id: i.id,
        licenseItemId: i.licenseItemId,
        productId: i.productId,
        batchId: i.batchId,
        batchLabel: i.batchLabel,
        productName: i.productName,
        sku: i.sku,
        productKind: i.productKind,
        keySnapshot: i.keySnapshot,
        reason: i.reason,
        defectKind: i.defectKind,
        quarantinedAt: i.quarantinedAt,
        outcome: i.outcome,
        outcomeNote: i.outcomeNote,
        resolvedAt: i.resolvedAt,
      })),
    };
  }

  /**
   * Durum geçişi. İzinli yollar:
   *   draft → sent | canceled        (iptal YALNIZ draft iken — gönderilmiş fiş "olmamış" sayılamaz)
   *   sent  → closed
   * `canceled` fişin kalemleri SİLİNİR → anahtarlar havuza döner (fiş yanlış kesilmişti).
   */
  async updateStatus(
    id: string,
    input: { status?: 'sent' | 'closed' | 'canceled'; reference?: string; note?: string },
    actor: string,
  ) {
    return this.db.transaction(async (tx) => {
      const [cur] = await rawRows<{ id: string; status: string; code: string }>(tx, sql`
        SELECT id, status::text AS status, code FROM supplier_claims WHERE id = ${id} LIMIT 1
        FOR UPDATE;
      `);
      if (!cur) throw new NotFoundException('Fiş bulunamadı');

      const next = input.status;
      if (next) {
        const ok =
          (cur.status === 'draft' && (next === 'sent' || next === 'canceled')) ||
          (cur.status === 'sent' && next === 'closed');
        if (!ok) {
          throw new BadRequestException(
            `Bu geçiş yapılamaz: ${cur.status} → ${next}. (İptal yalnız taslak fişte; kapatma yalnız gönderilmiş fişte.)`,
          );
        }
      }

      await tx
        .update(supplierClaims)
        .set({
          ...(next ? { status: next } : {}),
          ...(next === 'sent' ? { sentAt: new Date() } : {}),
          ...(next === 'closed' ? { closedAt: new Date() } : {}),
          ...(input.reference !== undefined ? { reference: input.reference.slice(0, 200) || null } : {}),
          ...(input.note !== undefined ? { note: input.note.slice(0, MAX_NOTE_CHARS) || null } : {}),
        })
        .where(eq(supplierClaims.id, id));

      if (next === 'canceled') {
        // Kalemler SİLİNİR: fiş yanlış kesildiyse anahtarlar havuza dönmeli. (Kısmi unique index
        // yalnız 'rejected' olmayanı engelliyor; satırı bırakıp durumu değiştirmek "reddedildi"
        // demek olurdu ve tedarikçi karnesinde sahte ret sayısı üretirdi.)
        await tx.delete(supplierClaimItems).where(eq(supplierClaimItems.claimId, id));
        await tx.update(supplierClaims).set({ itemCount: 0 }).where(eq(supplierClaims.id, id));
      }

      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: 'supplier_claim',
        targetId: id,
        meta: { op: 'claim_status', code: cur.code, from: cur.status, to: next ?? cur.status },
      });

      return { ok: true, status: next ?? cur.status };
    });
  }

  /**
   * Kalem sonucu işaretle (tedarikçinin yanıtı).
   * `rejected` → anahtar HAVUZA GERİ DÖNER (kısmi unique index onu dışarıda bırakır).
   */
  async updateItems(
    claimId: string,
    input: {
      itemIds: string[];
      outcome: 'pending' | 'replaced' | 'credited' | 'rejected';
      note?: string;
    },
    actor: string,
  ) {
    const ids = Array.from(new Set(input.itemIds.map((v) => String(v))));
    if (ids.length === 0) throw new BadRequestException('Hiç kalem seçilmedi.');

    return this.db.transaction(async (tx) => {
      const [claim] = await rawRows<{ id: string; status: string; code: string }>(tx, sql`
        SELECT id, status::text AS status, code FROM supplier_claims WHERE id = ${claimId} LIMIT 1
        FOR UPDATE;
      `);
      if (!claim) throw new NotFoundException('Fiş bulunamadı');
      if (claim.status === 'draft') {
        throw new BadRequestException(
          'Taslak fişte sonuç işaretlenemez — önce "Gönderildi" olarak işaretleyin.',
        );
      }
      if (claim.status === 'canceled') {
        throw new BadRequestException('İptal edilmiş fişte sonuç işaretlenemez.');
      }

      const updated = await tx
        .update(supplierClaimItems)
        .set({
          outcome: input.outcome,
          outcomeNote: input.note ? input.note.slice(0, 500) : null,
          resolvedAt: input.outcome === 'pending' ? null : new Date(),
        })
        .where(and(eq(supplierClaimItems.claimId, claimId), inArray(supplierClaimItems.id, ids)))
        .returning({ id: supplierClaimItems.id });

      if (updated.length === 0) {
        throw new BadRequestException('Seçilen kalemler bu fişte bulunamadı.');
      }

      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: 'supplier_claim',
        targetId: claimId,
        meta: {
          op: 'claim_item_outcome',
          code: claim.code,
          outcome: input.outcome,
          requested: ids.length,
          affected: updated.length,
        },
      });

      return { requested: ids.length, affected: updated.length };
    });
  }
}
