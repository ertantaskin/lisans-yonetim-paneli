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
import { ZodBody } from '../common/zod-validation.pipe';
import { UpdatesService, type PluginReleaseMeta } from './updates.service';

/**
 * Basit bellek-içi sabit-pencere hız sınırı (IP başına) — PUBLIC güncelleme uçları için
 * hafif DoS/kötüye-kullanım savunması. Tek-süreç varsayar (kalıcı/dağıtık depo DEĞİL);
 * amaç kaba tepe trafiğini kırpmak. Süresi geçen kova erişimde tembel sıfırlanır; harita
 * büyürse fırsatçı temizlik yapılır (bellek sızıntısı önlenir).
 */
const RL_WINDOW_MS = 60_000;
const RL_MAX_INFO = 60; // dakikada 60 info/IP
const RL_MAX_DOWNLOAD = 20; // dakikada 20 indirme/IP
const rlBuckets = new Map<string, { count: number; resetAt: number }>();

/** true = izin ver; false = pencere kotası aşıldı (çağıran 429 üretmeli). */
function updatesRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const bucket = rlBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    if (rlBuckets.size > 5000) {
      for (const [k, v] of rlBuckets) if (now >= v.resetAt) rlBuckets.delete(k);
    }
    rlBuckets.set(key, { count: 1, resetAt: now + RL_WINDOW_MS });
    return true;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

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
  constructor(private readonly updates: UpdatesService) {}

  /**
   * En son sürümü WordPress güncelleme-denetçisi biçimine çevirir. download_url MUTLAK URL:
   * PUBLIC_API_URL varsa onu, yoksa istekten (protocol + hostname) türetir. Yayınlanmış
   * sürüm yoksa boş nesne döner.
   */
  @Get('plugin/info')
  async info(@Req() req: FastifyRequest, @Ip() ip: string) {
    if (!updatesRateLimit(`info:${ip}`, RL_MAX_INFO)) {
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
    @Res() reply: FastifyReply,
  ): Promise<void> {
    // Hız sınırı: @Res() elle yönetildiği için (mevcut 404 deseni gibi) 429'u elle yaz.
    if (!updatesRateLimit(`download:${ip}`, RL_MAX_DOWNLOAD)) {
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
    reply
      .header('content-type', 'application/zip')
      .header('content-disposition', `attachment; filename=jetlisans-${version}.zip`)
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
