import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Owner-rol SAVUNMA-DERİNLİĞİ guard'ı (denetim H1 sınıfı).
 *
 * AdminGuard'dan SONRA çalışır (ADMIN_TOKEN zaten doğrulandı). Next sunucusu her YAZMA
 * çağrısında doğrulanmış oturum rolünü `x-admin-role` başlığıyla iletir (apps/admin/lib/api.ts).
 * Karar tablosu:
 *   - başlık 'owner'                → geçir,
 *   - başlık VAR ama 'owner' değil  → 403 (auth AÇIK + non-owner admin: owner-only uca erişemez),
 *   - başlık YOK                    → geçir (auth KAPALI panel / rol iletmeyen okuma yolu / eski
 *                                     istemci; AdminGuard'ın ADMIN_TOKEN kapısı zaten geçilmiş,
 *                                     auth kapalıyken panel tasarımca herkese açıktır).
 *
 * Böylece Next katmanındaki TEK bir eksik isOwner() kontrolü (H1) artık owner-only uçlara
 * (eklenti yayınla / dağıtım / admin CRUD) yükselemez. Başlığı yalnız Next set eder ve API
 * yalnız ADMIN_TOKEN ile erişilebilir olduğundan tarayıcıdan spoof edilemez (ADMIN_TOKEN
 * sızarsa zaten tam erişim — belgeli sınır; bu guard "unutulmuş UI kontrolü" sınıfını kapatır).
 */
@Injectable()
export class OwnerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const role = req.headers['x-admin-role'];
    if (typeof role === 'string' && role.length > 0 && role !== 'owner') {
      throw new ForbiddenException('Bu işlem yalnız "owner" rolüne açıktır.');
    }
    return true;
  }
}
