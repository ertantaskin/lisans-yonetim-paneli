import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import { UpdatesService, type PluginReleaseMeta } from './updates.service';

/**
 * Redis sabit-pencere hız sınırı (IP başına) — PUBLIC güncelleme uçları için hafif
 * DoS/kötüye-kullanım savunması. RateLimitService dağıtık + restart-dayanıklı sayaç tutar;
 * info ve download AYRI kovadır (ad-alanlı anahtar) → biri diğerinin kotasını yemez.
 */
const RL_WINDOW_SEC = 60;
const RL_MAX_INFO = 60; // dakikada 60 info/IP
const RL_MAX_DOWNLOAD = 20; // dakikada 20 indirme/IP

/** Yeni eklenti sürümü yayınlama gövdesi (§16). zipB64 = .zip paketinin base64'ü. */
const PublishSchema = z.object({
  version: z.string().min(1).max(40),
  changelog: z.string().max(20000).optional(),
  zipB64: z.string().min(1),
});
type PublishInput = z.infer<typeof PublishSchema>;

/**
 * Admin: eklenti sürümü yayınlama/listeleme. Yalnız bu uçlar korumalı (X-Admin-Token) —
 * yeni sürüm YAYINLAMA admin-gated'dır (§16).
 */
@Controller('admin/updates')
@UseGuards(AdminGuard)
export class UpdatesAdminController {
  constructor(private readonly updates: UpdatesService) {}

  /** Yeni sürüm yayınla (aynı version varsa günceller). */
  @Post('plugin')
  async publish(@Body(new ZodBody(PublishSchema)) body: PublishInput) {
    const release = await this.updates.publish(body.version, body.changelog, body.zipB64);
    return { id: release.id, version: release.version, createdAt: release.createdAt };
  }

  /** Yayınlanmış sürümlerin listesi (en yeni önce). */
  @Get('plugin')
  async list(): Promise<PluginReleaseMeta[]> {
    return this.updates.list();
  }
}

/**
 * Public: WordPress güncelleme-denetçisi uçları — GUARD YOK. WP core paketi güncelleme
 * bilgisini + .zip'i imzasız çeker. Eklenti kodu sır değildir; "private" = tek dağıtım
 * kaynağı (panel), erişim kısıtlaması değil (§16).
 */
@Controller('updates')
export class UpdatesController {
  constructor(
    private readonly updates: UpdatesService,
    private readonly rateLimit: RateLimitService,
  ) {}

  /**
   * En son sürümü WordPress güncelleme-denetçisi biçimine çevirir. download_url MUTLAK URL:
   * PUBLIC_API_URL varsa onu, yoksa istekten (protocol + hostname) türetir. Yayınlanmış
   * sürüm yoksa boş nesne döner.
   */
  @Get('plugin/info')
  async info(@Req() req: FastifyRequest, @Ip() ip: string) {
    if (!(await this.rateLimit.hit(`updates:info:${ip}`, RL_MAX_INFO, RL_WINDOW_SEC))) {
      throw new HttpException(
        'Çok fazla istek. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const release = await this.updates.latest();
    if (!release) return {};

    const base = this.baseUrl(req);
    const downloadUrl = `${base}/v1/updates/plugin/download/${encodeURIComponent(release.version)}`;

    return {
      name: 'Jetlisans — Lisans Teslimat İstemcisi',
      slug: 'jetlisans',
      version: release.version,
      download_url: downloadUrl,
      requires: '5.8',
      tested: '6.6',
      requires_php: '7.4',
      sections: { changelog: release.changelog ?? '' },
      last_updated: release.createdAt.toISOString(),
    };
  }

  /**
   * .zip paketini indirir. @Res() kullanıldığı için passthrough yoktur — reply.send zorunlu.
   * Sürüm yoksa 404.
   */
  @Get('plugin/download/:version')
  async download(
    @Param('version') version: string,
    @Ip() ip: string,
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Hız sınırı: @Res() elle yönetildiği için (mevcut 404 deseni gibi) 429'u elle yaz.
    if (!(await this.rateLimit.hit(`updates:download:${ip}`, RL_MAX_DOWNLOAD, RL_WINDOW_SEC))) {
      reply
        .status(429)
        .send({ error: 'rate_limited', message: 'Çok fazla istek. Kısa süre sonra tekrar deneyin.' });
      return;
    }

    const zipB64 = await this.updates.getZip(version);
    if (!zipB64) {
      reply.status(404).send({ error: 'not_found', message: 'Sürüm bulunamadı' });
      return;
    }

    const buffer = Buffer.from(zipB64, 'base64');
    // ETag = paket içeriğinin sha256'sı (güçlü doğrulayıcı). WP güncelleyici/proxy aynı
    // sürümü If-None-Match ile tekrar istediğinde 304 döner → gövde yeniden gönderilmez.
    // Aynı sürüm yeniden yayınlanırsa içerik (dolayısıyla ETag) değişir → istemci taze indirir.
    const etag = `"${createHash('sha256').update(buffer).digest('hex')}"`;
    const ifNoneMatch = req.headers['if-none-match'];
    if (typeof ifNoneMatch === 'string' && ifNoneMatch === etag) {
      reply.header('etag', etag).header('cache-control', 'public, max-age=300').status(304).send();
      return;
    }

    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename=jetlisans-${version}.zip`)
      .header('content-length', buffer.length)
      .header('etag', etag)
      // Sürüm .zip'i kısa süre önbelleklenebilir: yinelenen DB base64 çözümünü azaltır.
      // Aynı sürüm yeniden yayınlanabildiğinden ölçülü tutuldu (300s).
      .header('cache-control', 'public, max-age=300')
      .send(buffer);
  }

  /** İndirme için mutlak taban URL: PUBLIC_API_URL (varsa, sondaki '/' atılır) yoksa istekten. */
  private baseUrl(req: FastifyRequest): string {
    const env = process.env.PUBLIC_API_URL;
    if (env && env.trim()) return env.trim().replace(/\/+$/, '');
    return `${req.protocol}://${req.hostname}`;
  }
}
