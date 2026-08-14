import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { ReplacementRateLimitException, ReplacementsService } from './replacements.service';

/**
 * Değişim/garanti talebi — MÜŞTERİ kaynaklı serbest metin taşır (mağaza formundan gelir).
 *
 * ÜST SINIRLAR (denetim bulgusu): `reason` sınırsızdı → güvenilmez girdi doğrudan DB'ye
 * yazılıyordu (gövde şişirme + destek kuyruğunda okunamaz kayıt). Aynı dosyadaki müşteri
 * mesajı zaten bilinçli olarak 2000'e kapalı; `reason` da AYNI sınıf girdi olduğu için
 * AYNI tavana bağlandı (tutarlı sözleşme, tek gerekçe).
 * `remoteOrderId` bir mağaza sipariş KİMLİĞİdir (kısa sayı/kod) — 64 karakter her platform
 * için fazlasıyla yeterli; serbest metin uzunluğunda olması hiçbir meşru durumda gerekmez.
 */
const CreateReplacementBody = z.object({
  remoteOrderId: z.string().min(1).max(64),
  reason: z.string().min(3).max(2000),
  assignmentId: z.string().uuid().optional(),
});
type CreateReplacementBody = z.infer<typeof CreateReplacementBody>;

/**
 * Müşteri mesajı — mağaza tarafından iletilir. Üst sınır admin tarafından (4000) DAHA DAR:
 * müşteri girdisi güvenilmez, gövde şişirme yüzeyi küçük tutulur.
 */
const CustomerMessageBody = z.object({ body: z.string().min(1).max(2000) });
type CustomerMessageBody = z.infer<typeof CustomerMessageBody>;

/**
 * Site-facing değişim/garanti talebi + YAZIŞMA uçları (§13). HMAC imzalı.
 *
 * Kapsam: her uç talebin ÇAĞIRAN SİTEYE ait olduğunu servis katmanında doğrular (çapraz-site
 * erişim 404). İç notlar (internal=true) bu yoldan ASLA dönmez — süzme servis katmanında.
 */
@Controller('replacements')
@UseGuards(HmacGuard)
export class ReplacementsController {
  constructor(private readonly replacements: ReplacementsService) {}

  @Post()
  async create(
    @CurrentSite() site: Site,
    @Body(new ZodBody(CreateReplacementBody)) body: CreateReplacementBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withRetryAfter(reply, () => this.replacements.create(site, body));
  }

  /** Yazışmayı getirir — YALNIZ müşteriye görünen mesajlar (iç notlar süzülür). */
  @Get(':id/messages')
  messages(@CurrentSite() site: Site, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.replacements.listMessages(id, { includeInternal: false, siteId: site.id });
  }

  /** Müşteri yanıtı ekler. Yazar tipi daima 'customer' (gövdeden kimlik alınmaz). */
  @Post(':id/messages')
  async addMessage(
    @CurrentSite() site: Site,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(CustomerMessageBody)) body: CustomerMessageBody,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.withRetryAfter(reply, () =>
      this.replacements.addCustomerMessage(site, id, body.body),
    );
  }

  /**
   * Hız sınırı aşımında (429) `Retry-After` başlığını set eder — orders.controller'daki sert
   * kota deseniyle aynı: Fastify reply başlığı, istisna filtresi yanıtı render etmeden ÖNCE
   * yazıldığı için 429 gövdesiyle birlikte istemciye ulaşır.
   */
  private async withRetryAfter<T>(reply: FastifyReply, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReplacementRateLimitException) {
        reply.header('retry-after', String(e.retryAfterSec));
      }
      throw e;
    }
  }
}
