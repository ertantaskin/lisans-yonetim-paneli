import { Controller, Get, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AdminGuard } from '../auth/admin.guard';
import { DashboardService, type DashboardSummary } from './dashboard.service';

/**
 * Admin: genel-bakış (dashboard) KPI özeti + iş istasyonu canlı akışı (salt-okunur, §13/§17).
 *
 * Controller öneki bilerek 'admin': `GET /v1/admin/dashboard` (mevcut, DEĞİŞMEDİ) ve YENİ
 * `GET /v1/admin/live` aynı sınıftan servis edilir — DashboardModule'e ikinci controller
 * eklemeye gerek kalmaz.
 */
@Controller('admin')
@UseGuards(AdminGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  /** Panel genel-bakış: bekleyen satır / bugünkü sipariş / düşük stok / açık talep / güvenlik / stok + son siparişler. */
  @Get('dashboard')
  async summary(): Promise<DashboardSummary> {
    return this.dashboard.summary();
  }

  /**
   * İş istasyonu canlı akışı — TEK uç, TEK anlık görüntü (§17): son siparişler + son destek
   * talepleri + bildirim çanı (okunmamış sayacı + son bildirimler) + üst şerit sayaçları.
   * Ekran mesai boyunca açık kalıp ~15 sn'de bir çağrılacak şekilde tasarlandı.
   *
   * Bant genişliği koruması: yanıtın `ts` HARİÇ deterministik özetinden zayıf ETag üretilir;
   * istemci `If-None-Match` ile aynı ETag'i gönderirse **304** (gövdesiz) döner. Panelde
   * hareket olmadığı sürece her poll birkaç yüz bayt başlıktan ibaret kalır.
   *
   * `Cache-Control: no-store`: operasyon verisi ara belleklerde/diskte TUTULMAZ; ETag yalnız
   * istemcinin kendi bellek-içi doğrulaması için kullanılır.
   *
   * @Res() elle yönetilir (updates.controller download deseni) — 304'te gövde gönderilmemeli.
   */
  @Get('live')
  async live(
    @Req() req: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('limit') limit?: string,
  ): Promise<void> {
    const parsed = Number(limit);
    const { snapshot, etag } = await this.dashboard.live(
      Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
    );

    reply.header('cache-control', 'no-store').header('etag', etag);

    if (matchesEtag(req.headers['if-none-match'], etag)) {
      reply.status(304).send();
      return;
    }

    reply.status(200).send(snapshot);
  }
}

/**
 * If-None-Match başlığı ETag ile eşleşiyor mu? Başlık virgülle ayrılmış çoklu değer
 * taşıyabilir; ayrıca bazı ara katmanlar 'W/' zayıf önekini düşürür → önek atılarak
 * karşılaştırılır. '*' HTTP semantiğinde "kaynak mevcutsa eşleş" demektir.
 */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (!header) return false;
  const raw = Array.isArray(header) ? header.join(',') : header;
  const strip = (v: string) => v.trim().replace(/^W\//, '');
  const target = strip(etag);
  return raw.split(',').some((candidate) => {
    const c = strip(candidate);
    return c === '*' || c === target;
  });
}
