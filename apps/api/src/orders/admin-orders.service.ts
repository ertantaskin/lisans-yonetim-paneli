import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import {
  assignments,
  auditLog,
  emailLog,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
} from '../db/schema';
import { CryptoService } from '../crypto/crypto.service';

/** Payload'ı maskeler — son 5 hane görünür, gerisi • (reveal ayrı/loglu iş). */
function mask(plain: string): string {
  if (plain.length <= 5) return '•'.repeat(plain.length);
  return plain.slice(0, -5).replace(/[^-]/g, '•') + plain.slice(-5);
}

@Injectable()
export class AdminOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  async list(status?: string) {
    const base = this.db.select().from(orders).orderBy(desc(orders.createdAt)).limit(200);
    const rows = status
      ? await this.db
          .select()
          .from(orders)
          .where(eq(orders.status, status as never))
          .orderBy(desc(orders.createdAt))
          .limit(200)
      : await base;
    return rows;
  }

  /** Bekleyen Teslimatlar ana ekranı (§13): pending/partial siparişler. */
  async pending() {
    return this.db
      .select()
      .from(orders)
      .where(inArray(orders.status, ['pending', 'partial']))
      .orderBy(desc(orders.createdAt))
      .limit(200);
  }

  /** Admin sipariş detayı: satırlar + atamalar (maskeli) + timeline (§7 meta box). */
  async detail(orderId: string) {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const lines = await this.db.select().from(orderLines).where(eq(orderLines.orderId, orderId));

    const asgRows = await this.db
      .select({
        id: assignments.id,
        lineId: assignments.lineId,
        status: assignments.status,
        units: assignments.units,
        validUntil: assignments.validUntil,
        deliveredAt: assignments.deliveredAt,
        payloadEnc: licenseItems.payloadEnc,
        licenseItemId: licenseItems.id,
      })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .where(eq(assignments.orderId, orderId));

    const events = await this.db
      .select()
      .from(fulfillmentEvents)
      .where(eq(fulfillmentEvents.orderId, orderId))
      .orderBy(fulfillmentEvents.createdAt);

    const emails = await this.db
      .select()
      .from(emailLog)
      .where(eq(emailLog.orderId, orderId))
      .orderBy(emailLog.createdAt);

    return {
      order,
      lines,
      emails,
      assignments: asgRows.map((a) => ({
        id: a.id,
        lineId: a.lineId,
        status: a.status,
        units: a.units,
        validUntil: a.validUntil,
        deliveredAt: a.deliveredAt,
        licenseItemId: a.licenseItemId,
        maskedPayload: mask(this.crypto.decrypt(a.payloadEnc)),
      })),
      events,
    };
  }

  /**
   * İade/iptal → atama revoke, key karantinaya (§2: iade edilen key otomatik
   * satışa dönmez). audit_log'a düşer. Müşteri deliveries'te artık görünmez.
   */
  async revokeAssignment(assignmentId: string, reason: string, actor: string) {
    return this.db.transaction(async (tx) => {
      const [asg] = await tx
        .select()
        .from(assignments)
        .where(eq(assignments.id, assignmentId))
        .limit(1);
      if (!asg) throw new NotFoundException('Atama bulunamadı');

      await tx
        .update(assignments)
        .set({ status: 'revoked' })
        .where(eq(assignments.id, assignmentId));

      await tx
        .update(licenseItems)
        .set({ status: 'quarantined' })
        .where(eq(licenseItems.id, asg.licenseItemId));

      await tx.insert(auditLog).values({
        action: 'revoke',
        actor,
        targetType: 'assignment',
        targetId: assignmentId,
        meta: { reason, licenseItemId: asg.licenseItemId },
      });

      await tx.insert(fulfillmentEvents).values({
        orderId: asg.orderId,
        type: 'revoked',
        message: `Atama iptal edildi: ${reason}`,
      });

      return { assignmentId, status: 'revoked', quarantined: asg.licenseItemId };
    });
  }
}
