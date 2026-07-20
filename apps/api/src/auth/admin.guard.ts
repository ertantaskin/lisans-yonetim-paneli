import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyRequest } from 'fastify';
import { CryptoService } from '../crypto/crypto.service';

/**
 * Admin uçları (site/ürün/stok yönetimi) için basit token guard'ı.
 * `X-Admin-Token` başlığını ADMIN_TOKEN ile sabit-zamanlı karşılaştırır.
 * Faz 2'de panel_users + RBAC + TOTP ile değişecek (§8).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const provided = req.headers['x-admin-token'];
    const expected = this.config.getOrThrow<string>('ADMIN_TOKEN');

    if (typeof provided !== 'string' || !CryptoService.safeEqual(provided, expected)) {
      throw new UnauthorizedException('Geçersiz admin token');
    }
    return true;
  }
}
