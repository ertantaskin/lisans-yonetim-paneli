import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { assignments, licenseItems, orderLines, orders, products, type Site } from '../db/schema';
// Bu modül henüz index.ts barrel'ına eklenmedi (orkestratör ekler) → doğrudan dosyadan al.
import {
  replacementRequests,
  type ReplacementRequest,
} from '../db/schema/replacementRequests';
import { AdminOrdersService } from '../orders/admin-orders.service';
import { FulfillmentService } from '../orders/fulfillment.service';

const DAY_MS = 86_400_000;

export interface CreateReplacementInput {
  remoteOrderId: string;
  reason: string;
  assignmentId?: string;
}

/** Admin listesi/detayı için talep + siparişin remote_order_id'si. */
export interface AdminReplacementRow {
  id: string;
  siteId: string;
  orderId: string;
  remoteOrderId: string | null;
  lineId: string | null;
  assignmentId: string | null;
  customerEmail: string;
  reason: string;
  status: ReplacementRequest['status'];
  withinWarranty: boolean;
  resolutionNote: string | null;
  createdAt: Date;
}

/**
 * Değişim/garanti talepleri (§13). Site-facing oluşturma + admin çözüm akışı.
 * Onayda MEVCUT atama makinesini kullanır (revoke + completeLine) — atomik atama
 * mantığı yeniden yazılmaz.
 */
@Injectable()
export class ReplacementsService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly adminOrders: AdminOrdersService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Site-facing talep oluşturma. Site imzadan çözülür (HmacGuard). Sipariş
   * (siteId, remoteOrderId) ile bulunur; yoksa 404. assignmentId verildiyse
   * garanti penceresi hesaplanır ve lineId atamadan türetilir.
   */
  async create(
    site: Site,
    dto: CreateReplacementInput,
  ): Promise<{ id: string; status: ReplacementRequest['status']; withinWarranty: boolean }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, dto.remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    let lineId: string | null = null;
    let withinWarranty = false;

    if (dto.assignmentId) {
      // Atamayı sipariş kapsamında çöz → garanti (delivered_at + warranty_days) + satır.
      const [asg] = await this.db
        .select({
          orderId: assignments.orderId,
          lineId: assignments.lineId,
          deliveredAt: assignments.deliveredAt,
          warrantyDays: products.warrantyDays,
        })
        .from(assignments)
        .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
        .innerJoin(products, eq(orderLines.productId, products.id))
        .where(eq(assignments.id, dto.assignmentId))
        .limit(1);

      // Yalnız bu siparişe ait atamayı bağla (siteler arası referans sızmaz).
      if (asg && asg.orderId === order.id) {
        lineId = asg.lineId;
        if (asg.deliveredAt && asg.warrantyDays && asg.warrantyDays > 0) {
          withinWarranty = asg.deliveredAt.getTime() + asg.warrantyDays * DAY_MS >= Date.now();
        }
      }
    }

    const [row] = await this.db
      .insert(replacementRequests)
      .values({
        siteId: site.id,
        orderId: order.id,
        lineId,
        assignmentId: dto.assignmentId ?? null,
        customerEmail: order.customerEmail,
        reason: dto.reason,
        status: 'open',
        withinWarranty,
      })
      .returning();

    return { id: row!.id, status: row!.status, withinWarranty: row!.withinWarranty };
  }

  /** Admin liste: siparişin remote_order_id'si JOIN ile; status opsiyonel filtre. */
  async list(status?: string): Promise<{ items: AdminReplacementRow[] }> {
    const rows = await this.db
      .select({
        id: replacementRequests.id,
        siteId: replacementRequests.siteId,
        orderId: replacementRequests.orderId,
        remoteOrderId: orders.remoteOrderId,
        lineId: replacementRequests.lineId,
        assignmentId: replacementRequests.assignmentId,
        customerEmail: replacementRequests.customerEmail,
        reason: replacementRequests.reason,
        status: replacementRequests.status,
        withinWarranty: replacementRequests.withinWarranty,
        resolutionNote: replacementRequests.resolutionNote,
        createdAt: replacementRequests.createdAt,
      })
      .from(replacementRequests)
      .leftJoin(orders, eq(replacementRequests.orderId, orders.id))
      .where(status ? eq(replacementRequests.status, status as never) : undefined)
      .orderBy(desc(replacementRequests.createdAt))
      .limit(200);

    return { items: rows };
  }

  /**
   * Değişimi onayla: eski atamayı geri al + yenisini ata (§13). MEVCUT makine:
   * revokeAssignment (eskiyi karantina/kapasite iadesi) + completeLine(lineId, 1).
   * Stok yoksa (added=0) 409 döner ve talep 'approved' YAPILMAZ.
   */
  async approve(id: string, actor: string): Promise<ReplacementRequest> {
    const req = await this.getOrThrow(id);
    if (!req.assignmentId || !req.lineId) {
      throw new BadRequestException('Talep bir atama/satıra bağlı değil');
    }

    // Çok-kullanımlı (MAK) ürünlerde otomatik değişim ANLAMLI DEĞİL: revoke kapasiteyi aynı
    // paylaşımlı anahtara iade eder → completeLine onu tekrar seçer (no-op, aynı kusurlu key).
    // Sessizce "onaylandı" demek yerine açıkça reddet; MAK sorunları elle işlenir (audit bulgusu).
    const [prod] = await this.db
      .select({ usageMode: products.usageMode })
      .from(orderLines)
      .innerJoin(products, eq(products.id, orderLines.productId))
      .where(eq(orderLines.id, req.lineId))
      .limit(1);
    if (prod?.usageMode === 'multi') {
      throw new BadRequestException(
        'Çok-kullanımlı (MAK) üründe otomatik değişim desteklenmez — elle işleyin.',
      );
    }

    // 0) Stok ön-kontrolü: satırın ürününde uygun stok YOKSA eskiyi REVOKE ETMEDEN 409 dön.
    // (revoke→completeLine sırası zorunlu; ama stok baştan yoksa müşteriyi boşta bırakmayalım —
    // bu kontrol tamamen izin-verici; completeLine daha katı olsa bile mevcut revoke-sonrası-409
    // davranışına düşeriz, asla daha kötü değil.)
    const [avail] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(licenseItems)
      .innerJoin(orderLines, eq(orderLines.id, req.lineId))
      .where(
        and(
          eq(licenseItems.productId, orderLines.productId),
          eq(licenseItems.status, 'available'),
          sql`${licenseItems.useCount} < ${licenseItems.maxUses}`,
        ),
      );
    if (!avail || Number(avail.n) <= 0) {
      throw new ConflictException('Değişim için stok yok');
    }

    // 1) Eskiyi geri al (single → karantina, multi → kapasite iadesi; audit'e düşer).
    await this.adminOrders.revokeAssignment(req.assignmentId, 'replacement', actor);

    // 2) Yenisini ata — satırın açılan yerine 1 birim (atomik atama makinesi).
    const res = await this.fulfillment.completeLine(req.lineId, 1);
    if (res.added <= 0) {
      // Stok yok: talep açık kalır (approved yapılmaz), 409.
      throw new ConflictException('Değişim için stok yok');
    }

    // Yeni atamanın id'sini bul — bu satırın en yeni ataması.
    const [fresh] = await this.db
      .select({ id: assignments.id })
      .from(assignments)
      .where(eq(assignments.lineId, req.lineId))
      .orderBy(desc(assignments.createdAt))
      .limit(1);

    const [updated] = await this.db
      .update(replacementRequests)
      .set({
        status: 'approved',
        newAssignmentId: fresh?.id ?? null,
        resolvedBy: actor,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replacementRequests.id, id))
      .returning();

    return updated!;
  }

  /** Reddet — çözüm notuyla kapat. */
  async reject(id: string, note: string, actor: string): Promise<ReplacementRequest> {
    await this.getOrThrow(id);
    const [updated] = await this.db
      .update(replacementRequests)
      .set({
        status: 'rejected',
        resolutionNote: note,
        resolvedBy: actor,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(replacementRequests.id, id))
      .returning();
    return updated!;
  }

  /** Ek bilgi iste — müşteriye dönülür, talep açık kalır. */
  async requestInfo(id: string, note: string): Promise<ReplacementRequest> {
    await this.getOrThrow(id);
    const [updated] = await this.db
      .update(replacementRequests)
      .set({ status: 'info_requested', resolutionNote: note, updatedAt: new Date() })
      .where(eq(replacementRequests.id, id))
      .returning();
    return updated!;
  }

  private async getOrThrow(id: string): Promise<ReplacementRequest> {
    const [row] = await this.db
      .select()
      .from(replacementRequests)
      .where(eq(replacementRequests.id, id))
      .limit(1);
    if (!row) throw new NotFoundException('Değişim talebi bulunamadı');
    return row;
  }
}
