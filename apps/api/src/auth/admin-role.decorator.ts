import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Next admin sunucusunun ilettiği DOĞRULANMIŞ oturum rolü (`x-admin-role`): 'owner' | 'admin' | ''
 * (auth kapalı / oturum yok). AdminActor ile aynı güven düzeyi (token'sız istemci uçlara erişemez →
 * başlık sahtelenemez). OwnerGuard yetki kararında; bu decorator ise SUNUM kararında (maskeli vs düz)
 * kullanılır (denetim A1: düz-metin sır yalnız owner'a).
 */
export const AdminRole = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const raw = req.headers['x-admin-role'];
  return typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 32) : '';
});

/**
 * Düz-metin sır (lisans anahtarı / hesap parolası) GÖRÜNTÜLEME yetkisi (§8 "reveal ayrı rol", denetim A1).
 * - owner → izin (düz metin + reveal audit),
 * - başlık YOK ('' — auth KAPALI, panel tasarımca tek-operatör/herkese açık) → izin,
 * - 'admin' (owner-olmayan) → RED → çağıran maskeli döndürmeli.
 */
export function canRevealPlaintext(role: string): boolean {
  return role === '' || role === 'owner';
}
