import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { recomputeOrderStatus } from './order-status';
import { recordReplacementLineage } from './assignment-history';
import { FulfillmentService } from './fulfillment.service';
import { DB, type Database } from '../db/db.module';
import {
  assignmentHistory,
  assignments,
  auditLog,
  emailLog,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  products,
  type Site,
} from '../db/schema';
import {
  AccountPayloadSchema,
  maskAccountFields,
  maskSecret,
  parseAccountPayload,
  type PayloadField,
} from '@jetlisans/shared';
import { CryptoService } from '../crypto/crypto.service';
import { REDIS } from '../redis/redis.module';
import { MailService } from '../mail/mail.service';

/**
 * Payload'ı maskeler — SABİT genişlikli gövde + yalnız son 4 hane (reveal ayrı/loglu iş).
 * Uzunluk/segment yapısı sızmaz (§8). Tek kaynak: shared `maskSecret`.
 */
export function mask(plain: string): string {
  return maskSecret(plain);
}

/**
 * Bir atamanın maskeli gösterimini üretir. Hesap ürününde alan-alan maskeler (secret
 * alanlar maskeli, kullanıcı adı gibi alanlar açık) → JSON yapısı/parola kuyruğu sızmaz.
 * key/code/custom'da tek maskeli string döner.
 */
function maskPayload(
  plain: string,
  kind: string,
  payloadSchema: unknown,
): { maskedPayload: string; maskedFields: PayloadField[] | null } {
  if (kind === 'account') {
    const parsed = AccountPayloadSchema.safeParse(payloadSchema);
    if (parsed.success) {
      const masked = maskAccountFields(parseAccountPayload(parsed.data, plain));
      return {
        maskedPayload: masked.map((f) => `${f.label}: ${f.value}`).join(' · '),
        maskedFields: masked,
      };
    }
  }
  return { maskedPayload: mask(plain), maskedFields: null };
}

@Injectable()
export class AdminOrdersService {
  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
    private readonly mail: MailService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Loglu reveal (§17): maskeli lisansın tam payload'ını gösterir, audit'e düşer.
   * Hesap ürününde alanları (fields) da çözülmüş değerlerle döner.
   */
  async reveal(
    assignmentId: string,
    actor: string,
  ): Promise<{ payload: string; fields: PayloadField[] | null }> {
    const [row] = await this.db
      .select({
        payloadEnc: licenseItems.payloadEnc,
        licenseItemId: licenseItems.id,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
      })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Atama bulunamadı');

    await this.db.insert(auditLog).values({
      action: 'reveal',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      meta: { licenseItemId: row.licenseItemId, kind: row.productKind },
    });

    const plain = this.crypto.decrypt(
      row.payloadEnc,
      CryptoService.licenseItemAad(row.licenseItemId),
    );
    const schema =
      row.productKind === 'account' ? AccountPayloadSchema.safeParse(row.payloadSchema) : null;
    const fields = schema?.success ? parseAccountPayload(schema.data, plain) : null;
    return { payload: plain, fields };
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

  /**
   * Admin PROAKTİF değişim (§4 /assignments/:id/replace): kusurlu bir key'i müşteri "Sorun
   * Bildir" açmadan aynı üründen TAZE key ile değiştirir. Değişim makinesi (revoke false +
   * completeLine) — iade DEĞİL, satır 'canceled' işaretlenmez → yeniden-atama meşru. Eski key
   * karantinaya gider (satışa dönmez, §2); eski→yeni soyağacı assignment_history'ye yazılır.
   *
   * MAK/çok-kullanımlı ürün otomatik değişimi desteklenmez (paylaşımlı anahtar — elle);
   * stok yoksa eski atama KORUNUR (revoke edilmeden 409) — müşteri boşta kalmaz. replacements.approve
   * ile aynı güvence.
   */
  async replaceAssignment(assignmentId: string, reason: string, actor: string) {
    const [row] = await this.db
      .select({
        status: assignments.status,
        lineId: assignments.lineId,
        licenseItemId: assignments.licenseItemId,
        productId: orderLines.productId,
        usageMode: products.usageMode,
      })
      .from(assignments)
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(eq(assignments.id, assignmentId))
      .limit(1);
    if (!row) throw new NotFoundException('Atama bulunamadı');
    if (row.status !== 'active') {
      throw new BadRequestException('Yalnız aktif atama değiştirilebilir');
    }
    if (row.usageMode === 'multi') {
      throw new BadRequestException(
        'Çok-kullanımlı (MAK) üründe otomatik değişim desteklenmez — elle işleyin.',
      );
    }

    // Stok ön-kontrolü: eskiyi REVOKE ETMEDEN önce uygun available stok var mı? (replacements deseni)
    const [avail] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(licenseItems)
      .where(
        and(
          eq(licenseItems.productId, row.productId!),
          eq(licenseItems.status, 'available'),
          sql`${licenseItems.useCount} < ${licenseItems.maxUses}`,
        ),
      );
    if (!avail || Number(avail.n) <= 0) {
      throw new ConflictException('Değişim için stok yok');
    }

    // 1) Eskiyi geri al — markLineCanceled=false (iade DEĞİL; satır yeniden atanabilir kalır).
    await this.revokeAssignment(assignmentId, reason, actor, false);
    // 2) Taze key ata (atomik atama makinesi).
    const res = await this.fulfillment.completeLine(row.lineId, 1);
    if (res.added <= 0) {
      throw new ConflictException('Değişim için stok yok');
    }
    // 3) Soyağacı: eski→yeni assignment_history + newAssignmentId (§3 "eski anahtarlar").
    const newAssignmentId = await recordReplacementLineage(this.db, {
      lineId: row.lineId,
      oldLicenseItemId: row.licenseItemId,
      reason,
      actor,
    });
    await this.db.insert(auditLog).values({
      action: 'replace',
      actor,
      targetType: 'assignment',
      targetId: assignmentId,
      meta: { op: 'admin_replace', oldLicenseItemId: row.licenseItemId, newAssignmentId, reason },
    });
    return { oldAssignmentId: assignmentId, newAssignmentId, status: 'replaced' as const };
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
        // multi kapasite görünürlüğü + hesap alan-maskesi için.
        itemMaxUses: licenseItems.maxUses,
        itemUseCount: licenseItems.useCount,
        productKind: products.kind,
        payloadSchema: products.payloadSchema,
      })
      .from(assignments)
      .innerJoin(licenseItems, eq(assignments.licenseItemId, licenseItems.id))
      .innerJoin(orderLines, eq(assignments.lineId, orderLines.id))
      .innerJoin(products, eq(orderLines.productId, products.id))
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

    // Değişim soyağacı (§3/§7 "eski anahtar geçmişi"): bu siparişin atamalarına bağlı
    // assignment_history satırları. Eski key MASKELİ gösterilir (son-4) → admin hangi key'in
    // değiştiğini görür; düz payload sızmaz (leftJoin: eski kayıt silinmişse '—').
    const historyRows = await this.db
      .select({
        id: assignmentHistory.id,
        assignmentId: assignmentHistory.assignmentId,
        reason: assignmentHistory.reason,
        actor: assignmentHistory.actor,
        createdAt: assignmentHistory.createdAt,
        oldPayloadEnc: licenseItems.payloadEnc,
        oldLicenseItemId: licenseItems.id,
      })
      .from(assignmentHistory)
      .innerJoin(assignments, eq(assignmentHistory.assignmentId, assignments.id))
      .leftJoin(licenseItems, eq(assignmentHistory.oldLicenseItemId, licenseItems.id))
      .where(eq(assignments.orderId, orderId))
      .orderBy(desc(assignmentHistory.createdAt));

    return {
      order,
      lines,
      emails,
      history: historyRows.map((h) => ({
        id: h.id,
        assignmentId: h.assignmentId,
        reason: h.reason,
        actor: h.actor,
        createdAt: h.createdAt,
        oldMasked:
          h.oldPayloadEnc && h.oldLicenseItemId
            ? mask(this.crypto.decrypt(h.oldPayloadEnc, CryptoService.licenseItemAad(h.oldLicenseItemId)))
            : '—',
      })),
      assignments: asgRows.map((a) => {
        const plain = this.crypto.decrypt(
          a.payloadEnc,
          CryptoService.licenseItemAad(a.licenseItemId),
        );
        const masked = maskPayload(plain, a.productKind, a.payloadSchema);
        return {
          id: a.id,
          lineId: a.lineId,
          status: a.status,
          units: a.units,
          validUntil: a.validUntil,
          deliveredAt: a.deliveredAt,
          licenseItemId: a.licenseItemId,
          kind: a.productKind,
          maskedPayload: masked.maskedPayload,
          maskedFields: masked.maskedFields,
          // multi (MAK) kalan kapasite görünürlüğü.
          maxUses: a.itemMaxUses,
          useCount: a.itemUseCount,
        };
      }),
      events,
    };
  }

  /**
   * İade/iptal → atama revoke, key karantinaya (§2: iade edilen key otomatik
   * satışa dönmez). audit_log'a düşer. Müşteri deliveries'te artık görünmez.
   */
  async revokeAssignment(
    assignmentId: string,
    reason: string,
    actor: string,
    markLineCanceled = true,
  ) {
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
        // markLineCanceled (varsayılan true): GERÇEK iade/iptal (refund / admin-revoke) → satır
        // 'canceled' terminal işaretiyle partial-auto yeniden-atama havuzundan KALICI çıkarılır
        // (iade edilen müşteriye taze key ile bedava lisans gitmez, §2). AMA değişim / recall-
        // bulkReplace / sipariş-adedi-düşür gibi "revoke sonrası MEŞRU yeniden-atama" akışları
        // false geçer → satır completeLine ile yeniden atanabilir kalır (aksi halde "stok yok" hatası).
        await tx
          .update(orderLines)
          .set({
            fulfilledQty: nf,
            status: lineStatus,
            ...(markLineCanceled ? { canceled: true } : {}),
          })
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

  /**
   * Site-facing sipariş revoke sarmalayıcısı (§2): WooCommerce'te sipariş iade/iptal
   * edilince WP eklentisi tetikler → panelde CANLI key kalmaz. Siparişin bu siteye ait
   * olduğunu DOĞRULAR (başka sitenin siparişi geri alınamaz), aktif atamalarını MEVCUT
   * idempotent revoke akışıyla (revokeAssignment) geri alır. Payload/key DÖNMEZ.
   *
   * İdempotent: revokeAssignment zaten revoked ise no-op; ikinci çağrıda aktif atama
   * kalmadığından tüm istek no-op olur (revoked=0). İade edilen key otomatik satışa
   * DÖNMEZ (tek-kullanım → karantina; multi/MAK → kapasite geri, §2).
   */
  async revokeOrderForSite(
    site: Site,
    remoteOrderId: string,
    reason: string,
  ): Promise<{ orderId: string; revoked: number; assignments: number }> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(and(eq(orders.siteId, site.id), eq(orders.remoteOrderId, remoteOrderId)))
      .limit(1);
    if (!order) throw new NotFoundException('Sipariş bulunamadı');

    // Yalnız AKTİF atamalar geri alınır (revoked/expired/replaced zaten teslim edilmiyor).
    // Site scope order üzerinden zaten doğrulandı; atamalar bu siparişe bağlı.
    const active = await this.db
      .select({ id: assignments.id })
      .from(assignments)
      .where(and(eq(assignments.orderId, order.id), eq(assignments.status, 'active')));

    const actor = `site:${site.domain}`;
    let revoked = 0;
    for (const a of active) {
      const res = await this.revokeAssignment(a.id, reason, actor);
      // already=true → yarışta başka yol revoke etmiş; revoked sayacına katma.
      if (!('already' in res)) revoked++;
    }

    return { orderId: order.id, revoked, assignments: active.length };
  }
}
