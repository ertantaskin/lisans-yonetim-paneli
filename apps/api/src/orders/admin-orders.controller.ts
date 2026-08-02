import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminRole, canRevealPlaintext } from '../auth/admin-role.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import { AdminOrdersService } from './admin-orders.service';
import { FulfillmentService } from './fulfillment.service';

const RevokeBody = z.object({ reason: z.string().min(1) });

/** Askıya al / geri aç: sebep OPSİYONEL (verilirse audit_log.meta.reason'a düşer). */
const SuspendBody = z.object({ reason: z.string().max(500).optional() });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Query süzgeci doğrulayıcısı. BOŞ string ("?status=") "filtre temizlendi" sayılır → 400 yerine
 * yok sayılır (admin UI facet'i sıfırlarken boş parametre gönderir). Girdi/çıktı tipi `string`
 * kalır (ZodBody jeneriği preprocess/transform ile uyumsuz olurdu) — dönüşüm handler'da yapılır.
 */
const blankOr = (check: (s: string) => boolean, message: string) =>
  z
    .string()
    .max(200)
    .refine((s) => s === '' || check(s), message)
    .optional();

/** GET /admin/quarantine süzgeçleri (§13 "listeyi tedarikçiye ilet"). Hepsi opsiyonel. */
const QuarantineQuerySchema = z.object({
  search: z.string().max(200).optional(),
  status: blankOr((s) => s === 'quarantined' || s === 'voided', 'Durum quarantined|voided olmalı'),
  productId: blankOr((s) => UUID_RE.test(s), 'productId geçerli bir kimlik olmalı'),
  supplierId: blankOr((s) => UUID_RE.test(s), 'supplierId geçerli bir kimlik olmalı'),
  from: blankOr((s) => !Number.isNaN(Date.parse(s)), 'from geçerli bir tarih olmalı'),
  to: blankOr((s) => !Number.isNaN(Date.parse(s)), 'to geçerli bir tarih olmalı'),
  // Sayı biçimi burada, aralık kırpması serviste (1..5000) — çift doğrulama yerine tek kaynak.
  limit: blankOr((s) => /^\d{1,5}$/.test(s), 'limit bir sayı olmalı'),
});
type QuarantineQueryInput = z.infer<typeof QuarantineQuerySchema>;

/** '' / boşluk → undefined (süzgeç yok). */
const trimmed = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
};

/** Admin: sipariş operasyonları (§13). ADMIN_TOKEN gerektirir. */
@Controller('admin')
@UseGuards(AdminGuard)
export class AdminOrdersController {
  constructor(
    private readonly adminOrders: AdminOrdersService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  @Get('orders')
  list(@Query('status') status?: string) {
    return this.adminOrders.list(status);
  }

  /** Bekleyen Teslimatlar ana ekranı. */
  @Get('pending')
  pending() {
    return this.adminOrders.pending();
  }

  @Get('orders/:id')
  detail(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    // A1: düz-metin lisans/parola yalnız owner'a; owner-olmayan 'admin' maskeli detay alır.
    return this.adminOrders.detail(id, actor, canRevealPlaintext(role));
  }

  /** "Kalanları Ata" (units yok) / "N Adet Ata" (?units=N) — gövdesiz (§13). */
  @Post('fulfillments/:lineId/complete')
  complete(@Param('lineId', new ParseUUIDPipe()) lineId: string, @Query('units') units?: string) {
    const n = units ? Number.parseInt(units, 10) : undefined;
    return this.fulfillment.completeLine(lineId, n && n > 0 ? n : undefined);
  }

  @Post('assignments/:id/revoke')
  revoke(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(RevokeBody)) body: { reason: string },
    @AdminActor() actor: string,
  ) {
    return this.adminOrders.revokeAssignment(id, body.reason, actor);
  }

  /** Proaktif değişim (§4): kusurlu key'i aynı üründen taze key ile değiştir (reason zorunlu). */
  @Post('assignments/:id/replace')
  replace(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(RevokeBody)) body: { reason: string },
    @AdminActor() actor: string,
  ) {
    return this.adminOrders.replaceAssignment(id, body.reason, actor);
  }

  /** Loglu reveal (§17) — tam lisans payload'ı. OwnerGuard (A1/A3): düz-metin sır yalnız owner'a. */
  @Post('assignments/:id/reveal')
  @UseGuards(OwnerGuard)
  reveal(@Param('id', new ParseUUIDPipe()) id: string, @AdminActor() actor: string) {
    return this.adminOrders.reveal(id, actor);
  }

  /** Askıya al — sebep opsiyonel (gövdesiz çağrı da geçerli, geriye dönük uyumlu). */
  @Post('assignments/:id/suspend')
  suspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(SuspendBody)) body: { reason?: string },
    @AdminActor() actor: string,
  ) {
    return this.adminOrders.suspend(id, true, actor, body.reason);
  }

  @Post('assignments/:id/unsuspend')
  unsuspend(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(SuspendBody)) body: { reason?: string },
    @AdminActor() actor: string,
  ) {
    return this.adminOrders.suspend(id, false, actor, body.reason);
  }

  /** Teslimat mailini tekrar gönder (60sn debounce). Kim tetikledi audit'e düşer. */
  @Post('orders/:id/resend')
  resend(@Param('id', new ParseUUIDPipe()) id: string, @AdminActor() actor: string) {
    return this.adminOrders.resend(id, actor);
  }

  /**
   * Karantina / Değiştirilen Anahtarlar (§2/§3): ölü/geçersiz anahtarlar (salt-okunur).
   * Süzgeçler opsiyonel — parametresiz çağrı ESKİSİ GİBİ çalışır (geriye dönük uyumlu).
   * CSV/Excel API'de üretilmez; yalnız JSON döner (biçimlendirme admin tarafında).
   */
  @Get('quarantine')
  quarantine(
    @Query(new ZodBody(QuarantineQuerySchema)) q: QuarantineQueryInput,
    @AdminActor() actor: string,
  ) {
    const status = trimmed(q.status);
    const limit = trimmed(q.limit);
    return this.adminOrders.listQuarantine({
      actor,
      search: trimmed(q.search),
      status: status === 'quarantined' || status === 'voided' ? status : undefined,
      productId: trimmed(q.productId),
      supplierId: trimmed(q.supplierId),
      from: trimmed(q.from),
      to: trimmed(q.to),
      limit: limit ? Number(limit) : undefined,
    });
  }

  // ─── İnceleme Kuyruğu (§8 dinamik kota held_for_review) ────────────────────────────
  /** İnceleme kuyruğu: dinamik kota eşiğini aşıp beklemeye alınmış siparişler (payload yok). */
  @Get('review')
  reviewQueue() {
    return this.adminOrders.listHeldOrders();
  }

  /** İnceleme ONAYLA: held bayrağını kaldırır + atama makinesini çalıştırır (teslimat başlar). */
  @Post('orders/:id/release')
  release(@Param('id', new ParseUUIDPipe()) id: string, @AdminActor() actor: string) {
    return this.adminOrders.releaseHeld(id, actor);
  }

  /** İnceleme REDDET: siparişi teslim etmeden kapatır (satırlar iptal, key verilmez). reason zorunlu. */
  @Post('orders/:id/reject')
  reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(RevokeBody)) body: { reason: string },
    @AdminActor() actor: string,
  ) {
    return this.adminOrders.rejectHeld(id, body.reason, actor);
  }
}
