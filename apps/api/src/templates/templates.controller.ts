import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import { DeliveryTemplatesService } from './templates.service';

const CreateTemplateBody = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  productId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
});
type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

const UpdateTemplateBody = z.object({
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  productId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
});
type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

const PreviewBody = z.object({
  sampleVars: z.record(z.string(), z.string()).optional(),
});
type PreviewBody = z.infer<typeof PreviewBody>;

const TestBody = z.object({
  toEmail: z.string().email(),
});
type TestBody = z.infer<typeof TestBody>;

/**
 * Test-mail hız sınırı (denetim D2 — KİMLİK AVI YÜZEYİ).
 *
 * `POST :id/test` içeriğini operatörün yazdığı bir şablonu KEYFİ bir adrese, panelin MAIL_FROM
 * kimliği ve alan adının SPF/DKIM itibarıyla gönderir. Sınırsızken bu uç bir toplu-gönderim
 * (kimlik avı) aracına dönüşebilirdi: önce şablon oluştur, sonra döngüyle gönder.
 *
 * ALICI KISITLANMAZ — operatörün kendi test adresine göndermesi meşrudur; sınırlanan HIZDIR.
 *
 * KOVA ANAHTARI = ADMİN AKTÖRÜ, IP DEĞİL: panel uçlarına istekler Next admin sunucusu üzerinden
 * PROXY'lenir, yani API'nin gördüğü IP tüm operatörler için AYNIDIR — "IP başına" sınır tek
 * global kovaya çöker ve bir operatör diğerlerini kilitler (AI uçlarında düzeltilen aynı hata).
 * Aktör yoksa/varsayılansa ('panel:admin' — auth KAPALI kurulum ya da sistem çağrısı) IP'ye
 * geri düşülür; o kurulumda zaten tek operatör vardır ve panel ADMIN_TOKEN ile korunur.
 */
const TEST_MAIL_RL_WINDOW_SEC = 600; // 10 dk
const TEST_MAIL_RL_MAX = 10; // aktör başına 10 test maili / 10 dk

/** Admin: teslimat mail şablonları CRUD + önizleme + test-mail (§6/§13). */
@Controller('admin/templates')
@UseGuards(AdminGuard)
export class TemplatesController {
  constructor(
    private readonly templates: DeliveryTemplatesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.templates.get(id);
  }

  @Post()
  create(@Body(new ZodBody(CreateTemplateBody)) body: CreateTemplateBody) {
    return this.templates.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateTemplateBody)) body: UpdateTemplateBody,
  ) {
    return this.templates.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.templates.remove(id);
  }

  /** Örnek değişkenlerle render — gönderim YOK (§6). */
  @Post(':id/preview')
  preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(PreviewBody)) body: PreviewBody,
  ) {
    return this.templates.preview(id, body.sampleVars);
  }

  /**
   * Tek-seferlik test maili (örnek değişkenlerle) — gerçek müşteri verisi kullanılmaz.
   * Aktör başına hız sınırlıdır (yukarıdaki gerekçe): aşımda 429 + Retry-After.
   */
  @Post(':id/test')
  async test(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(TestBody)) body: TestBody,
    @Ip() ip: string,
    @AdminActor() actor: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const known = actor && actor !== 'panel:admin' ? actor : null;
    const key = known ? `templates:test:actor:${known}` : `templates:test:ip:${ip}`;
    if (!(await this.rateLimit.hit(key, TEST_MAIL_RL_MAX, TEST_MAIL_RL_WINDOW_SEC))) {
      // Fastify başlığı, istisna filtresi 429'u render etmeden ÖNCE korunur (admin-users deseni).
      reply.header('retry-after', String(TEST_MAIL_RL_WINDOW_SEC));
      throw new HttpException(
        'Çok fazla test maili gönderildi. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return this.templates.sendTest(id, body.toEmail);
  }
}
