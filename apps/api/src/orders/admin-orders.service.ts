import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { recomputeOrderStatus } from './order-status';
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
import { REDIS } from '../redis/redis.module';
import { MailService } from '../mail/mail.service';

const MASK_TAIL = 4;
const MASK_BODY = '••••••';

/**
 * Payload'ı maskeler — SABİT genişlikli gövde + yalnız son 4 hane (reveal ayrı/loglu iş).
 *
 * Sertleştirme (§8): eski maske tireleri koruyarak segment uzunluklarını ve toplam
 * uzunluğu sızdırıyordu (key formatı parmak izi). Yeni maske sabit `••••••` gövde
 * kullanır → uzunluk/yapı sızmaz; yalnız kimlik için son 4 hane açık kalır. Kısa
 * payload'lar (≤4) tümüyle maskelenir.
 */
export function mask(plain: string): string {
  if (plain.length <= MASK_TAIL) return MASK_BODY;
  return MASK_BODY + plain.slice(-MASK_TAIL);
}

@Injectable()
export class AdminOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
  ) {}

  /** Loglu reveal (§17): maskeli lisansın tam payload'ını gösterir, audit'e düşer. */
  async reveal(assignmentId: string, actor: string): Promise<{ payload: string }> {
    const [row] = await this.db
      .select({ payloadEnc: licenseItems.payloadEnc, licenseItemId: licenseItems.id })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Atama bulunamadı');

    await this.db.insert(auditLog).values({
      action: 'reveal',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      meta: { licenseItemId: row.licenseItemId },
    });
    return {
      payload: this.crypto.decrypt(row.payloadEnc, CryptoService.licenseItemAad(row.licenseItemId)),
    };
  }

  /** Geri alınabilir gizleme (§4). Müşteri görünümünde "inceleme altında". */
  async suspend(assignmentId: string, suspend: boolean, actor: string) {
    const [asg] = await this.db
      .select()
      .from(assignments)
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!asg) throw new NotFoundException('Atama bulunamadı');

    await this.db
      .update(assignments)
      .set({ status: suspend ? 'suspended' : 'active' })
      .where(eq(assignments.id, assignmentId));
    await this.db.insert(auditLog).values({
      action: suspend ? 'suspend' : 'unsuspend',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
    });
    return { assignmentId, status: suspend ? 'suspended' : 'active' };
  }

  /** Teslimat mailini tekrar gönder — 60sn debounce (§13). */
  async resend(orderId: string): Promise<{ queued: boolean }> {
    const [order] = await this.db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    const key = `resend:${orderId}`;
    const set = await this.redis.set(key, '1', 'EX', 60, 'NX');
    if (set !== 'OK') {
      throw new BadRequestException('Çok sık — 60 saniye içinde tekrar gönderilemez');
    }
    await this.mail.enqueueDelivery(
      order.id,
      order.customerEmail,
      `Siparişiniz — ${order.remoteOrderId}`,
    );
    return { queued: true };
  }

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
        maskedPayload: mask(
          this.crypto.decrypt(a.payloadEnc, CryptoService.licenseItemAad(a.licenseItemId)),
        ),
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
        .limit(1)
        .for('update');
      if (!asg) throw new NotFoundException('Atama bulunamadı');
      if (asg.status === 'revoked') return { assignmentId, status: 'revoked', already: true };

      await tx
        .update(assignments)
        .set({ status: 'revoked' })
        .where(eq(assignments.id, assignmentId));

      // Lisans geri alımı: tek kullanımlık → karantina (iade edilen key satışa dönmez);
      // çok kullanımlık (MAK) → kapasite geri ver (use_count -= units), tüm key'i imha etme.
      const [li] = await tx
        .select()
        .from(licenseItems)
        .where(eq(licenseItems.id, asg.licenseItemId))
        .limit(1);
      if (li) {
        if (li.maxUses > 1) {
          await tx.execute(sql`
            UPDATE license_items SET
              use_count = GREATEST(0, use_count - ${asg.units}),
              status = CASE WHEN status = 'depleted' THEN 'available' ELSE status END
            WHERE id = ${asg.licenseItemId};
          `);
        } else {
          await tx
            .update(licenseItems)
            .set({ status: 'quarantined' })
            .where(eq(licenseItems.id, asg.licenseItemId));
        }
      }

      // Satır sayacını düş + satır/sipariş durumunu yeniden hesapla (tutarlılık).
      const [line] = await tx
        .select()
        .from(orderLines)
        .where(eq(orderLines.id, asg.lineId))
        .limit(1)
        .for('update');
      if (line) {
        const nf = Math.max(0, line.fulfilledQty - asg.units);
        const lineStatus = nf >= line.qty ? 'fulfilled' : nf > 0 ? 'partial' : 'pending';
        await tx
          .update(orderLines)
          .set({ fulfilledQty: nf, status: lineStatus })
          .where(eq(orderLines.id, line.id));
      }
      await recomputeOrderStatus(tx, asg.orderId);

      await tx.insert(auditLog).values({
        action: 'revoke',
        actor,
        targetType: 'assignment',
        targetId: assignmentId,
        meta: { reason, licenseItemId: asg.licenseItemId, units: asg.units },
      });
      await tx.insert(fulfillmentEvents).values({
        orderId: asg.orderId,
        type: 'revoked',
        message: `Atama iptal edildi: ${reason}`,
      });

      return { assignmentId, status: 'revoked', licenseItemId: asg.licenseItemId };
    });
  }
}
