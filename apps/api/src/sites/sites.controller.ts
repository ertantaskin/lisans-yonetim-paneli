import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { SitesService } from './sites.service';

const CreateSiteBody = z.object({
  domain: z.string().min(1),
  type: z.enum(['woocommerce', 'marketplace', 'reseller']).optional(),
  senderEmail: z.string().email().optional(),
  webhookUrl: z.string().url().optional(),
  // Operasyon ayarları (§5/§14) — opsiyonel. null = limitsiz kota.
  salesDailyQuota: z.number().int().positive().nullable().optional(),
  sandbox: z.boolean().optional(),
});
type CreateSiteBody = z.infer<typeof CreateSiteBody>;

const UpdateSiteBody = z.object({
  salesDailyQuota: z.number().int().positive().nullable().optional(),
  // Dinamik satış kotası (§8): açıksa eşik aşımında sipariş held_for_review'e alınır (429 değil).
  dynamicQuotaEnabled: z.boolean().optional(),
  reviewMultiplier: z.number().int().min(1).max(100).optional(),
  sandbox: z.boolean().optional(),
  // Gönderen e-posta (§14) — null = varsayılan gönderene dön.
  senderEmail: z.string().email().nullable().optional(),
  // Geri kanal webhook hedefi (§2) — null = temizle (webhook devre dışı).
  webhookUrl: z.string().url().nullable().optional(),
  // Yaşam döngüsü (§8): 'suspended' → HMAC auth reddedilir (findForAuth active şartı).
  status: z.enum(['active', 'suspended']).optional(),
});
type UpdateSiteBody = z.infer<typeof UpdateSiteBody>;

/** Admin: site (tenant) yönetimi. ADMIN_TOKEN gerektirir. */
@Controller('admin/sites')
@UseGuards(AdminGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Post()
  create(@Body(new ZodBody(CreateSiteBody)) body: CreateSiteBody) {
    // apiKey + hmacSecret YALNIZ burada bir kez döner — güvenli sakla.
    return this.sites.create(body);
  }

  @Get()
  list() {
    return this.sites.list();
  }

  /** Site 360 detayı (§8/§14): config + kota kullanımı + son siparişler. SIR dönmez. */
  @Get(':id/detail')
  detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sites.detail(id);
  }

  /** Operasyon ayarları güncelle (§5/§14): günlük satış kotası + sandbox. Audit'e düşer. */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateSiteBody)) body: UpdateSiteBody,
  ) {
    return this.sites.update(id, body);
  }

  /**
   * HMAC secret rotasyonu (§4). Yeni secret döner (bir kez); eski secret 24s daha
   * geçerli kalır → WP eklentisi kesintisiz yeni secret'a geçer.
   */
  @Post(':id/rotate-secret')
  rotate(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sites.rotateSecret(id);
  }

  /**
   * Bağlantı sağlık testi (onboarding): site kaydı + durum + HMAC secret geçerliliği +
   * (varsa) webhook erişilebilirliği için yapısal teşhis döndürür ({ ok, checks }).
   * SIR DÖNMEZ — yalnız ok/detay. Salt-okunur teşhis (mutation değil, audit'e düşmez).
   */
  @Post(':id/test-connection')
  testConnection(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.sites.testConnection(id);
  }
}
