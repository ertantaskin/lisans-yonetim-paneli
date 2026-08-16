import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { SitesService } from './sites.service';

/**
 * Günlük satış kotası üst sınırı (§5). Gerekçe purchase-orders.controller:16 ile aynı: PG
 * kolonu `integer` (int4) → sınırsız girdi 2.147.483.647 üstünde 22003 ile ham 500 üretirdi,
 * artık kullanıcı 400 alır. 1.000.000 sipariş/gün, panelin başka yerlerindeki adet tavanıyla
 * (stok girişi count max 1.000.000) hizalıdır ve gerçek bir mağazanın günlük hacminin çok
 * üstündedir — "limitsiz" isteniyorsa alan zaten `null` bırakılır.
 */
const MAX_DAILY_QUOTA = 1_000_000;

const CreateSiteBody = z.object({
  domain: z.string().min(1),
  type: z.enum(['woocommerce', 'marketplace', 'reseller']).optional(),
  senderEmail: z.string().email().optional(),
  webhookUrl: z.string().url().optional(),
  // Operasyon ayarları (§5/§14) — opsiyonel. null = limitsiz kota.
  salesDailyQuota: z.number().int().positive().max(MAX_DAILY_QUOTA).nullable().optional(),
  sandbox: z.boolean().optional(),
});
type CreateSiteBody = z.infer<typeof CreateSiteBody>;

const UpdateSiteBody = z.object({
  // Sınır CREATE ile BİREBİR aynı (bkz. MAX_DAILY_QUOTA) — yalnız birine konsaydı aynı
  // kolon PATCH yolundan sınırsız beslenmeye devam ederdi.
  salesDailyQuota: z.number().int().positive().max(MAX_DAILY_QUOTA).nullable().optional(),
  // Dinamik satış kotası (§8): açıksa eşik aşımında sipariş held_for_review'e alınır (429 değil).
  dynamicQuotaEnabled: z.boolean().optional(),
  reviewMultiplier: z.number().int().min(1).max(100).optional(),
  sandbox: z.boolean().optional(),
  // Gönderen e-posta (§14) — null = varsayılan gönderene dön.
  senderEmail: z.string().email().nullable().optional(),
  // Geri kanal webhook hedefi (§2) — null = temizle (webhook devre dışı).
  webhookUrl: z.string().url().nullable().optional(),
  /**
   * Mağaza yönetim paneli sipariş bağlantısı şablonu — `{orderId}` yer tutucusuyla.
   * SALT YÖNLENDİRME: panel bu adrese OTOMATİK BAĞLANMAZ, veri çekmez; yalnız operatörün
   * tıklayacağı bağlantıyı üretir (kullanıcı isteği: "sadece url yönlendirme, otomatik
   * bağlantı olmayacak — güvenlikten dolayı"). Boş/null → bağlantı HİÇ gösterilmez
   * (site tipinden TAHMİN üretilmez). http/https ZORUNLU (javascript:/data: reddedilir);
   * `{orderId}` içermeli.
   *
   * NOT: şablonun KAYNAK işareti (`adminOrderUrlTemplateManual`, 0026) İSTEMCİDEN KABUL
   * EDİLMEZ — bu şemada alanı YOK, z.object varsayılan olarak bilinmeyen anahtarları atar
   * (strip) → gövdeye eklense bile servise ulaşmaz. Değer her zaman sunucuda bu şablon
   * alanından türetilir (SitesService.update).
   */
  adminOrderUrlTemplate: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^https?:\/\//i.test(v), 'http:// veya https:// ile başlamalı')
    .refine((v) => v.includes('{orderId}'), '{orderId} yer tutucusu içermeli')
    .nullable()
    .optional(),
  // Yaşam döngüsü (§8): 'suspended' → HMAC auth reddedilir (findForAuth active şartı).
  status: z.enum(['active', 'suspended']).optional(),
});
type UpdateSiteBody = z.infer<typeof UpdateSiteBody>;

/** Admin: site (tenant) yönetimi. ADMIN_TOKEN gerektirir. */
@Controller('admin/sites')
@UseGuards(AdminGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  /**
   * OWNER-ONLY — `rotate-secret` ile AYNI gerekçe (aşağıdaki nota bak): bu uç TAZE
   * `apiKey` + `hmacSecret` üretip ÇAĞIRANA döndürür. O kimlikle site-facing uçlar
   * imzalanabilir; `GET /v1/orders/:id/deliveries` ise payload'ı ÇÖZÜLMÜŞ (maskesiz)
   * döndürür. Yani kapısız bırakıldığında owner-olmayan bir admin kendine site açıp,
   * panelin kataloğundan istediği ürüne eşleme kurup, sipariş oluşturup gerçek bir
   * lisansı düz metin okuyabiliyordu — A1/A3 kararını ("düz metin YALNIZ owner",
   * reveal audit'li) tamamen atlayarak ve stoktan gerçek anahtar yakarak.
   * Üçlünün diğer ikisi (`rotate-secret`, `connect-code`) zaten owner-only idi;
   * `create` tek açık kapıydı. Meşru çağıran sihirbaz (`createSiteAndIssueCode`)
   * Next tarafında ZATEN owner-gated → bu guard onu kırmaz.
   */
  @UseGuards(OwnerGuard)
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
   *
   * OwnerGuard (denetim D2 — savunma-derinliği): panel bu işlemi ZATEN owner-only sayıyor
   * (`apps/admin/app/sites/actions.ts` → `rotateSecretAction` başında `isOwner()`), ama
   * OwnerGuard'ın var olma sebebi tam olarak "Next katmanındaki TEK bir eksik isOwner()
   * kontrolü owner-only uçlara yükselemesin"dir. Kapı admin CRUD / deployments / reveal /
   * anonymize / eklenti-yayınla uçlarına konmuş, bu uç atlanmıştı. ÖNEM: bu uç TAZE
   * `apiKey` + `hmacSecret`'ı ÇAĞIRANA döndürür → o kimlikle site-facing uçlar (reveal
   * dahil) imzalanabilir; yani sır rotasyonu güven kökünü değiştiren bir işlemdir.
   *
   * DİKKAT — `PATCH /sites/:id`'ye AYNISI EKLENMEZ: o ucu İKİ Next eylemi kullanıyor
   * (`updateSiteAction` owner-DEĞİL, `setSiteStatusAction` owner). Guard oraya eklenirse
   * meşru operasyon-ayarı düzenlemesi owner-olmayan admin için kırılır.
   */
  @UseGuards(OwnerGuard)
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
