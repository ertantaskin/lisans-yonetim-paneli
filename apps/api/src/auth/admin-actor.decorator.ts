import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Eylemi yapan admin'in kimliği (audit_log.actor). Next admin sunucusu, oturumdaki
 * admin'i `x-admin-actor` başlığıyla iletir — ADMIN_TOKEN ile AYNI güven düzeyinde:
 * token'sız istemci bu uçlara zaten erişemez, dolayısıyla header sahtelenemez.
 * Yoksa (auth kapalı / sistem çağrısı) 'panel:admin'.
 *
 * Çoklu-admin (§8) canlı olduğundan reveal/revoke/suspend/anonymize gibi hassas
 * eylemlerin HANGİ admin tarafından yapıldığı artık audit'e doğru düşer.
 */
export const AdminActor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string => {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const raw = req.headers['x-admin-actor'];
    const actor = typeof raw === 'string' ? raw.trim().slice(0, 200) : '';
    return actor || 'panel:admin';
  },
);
