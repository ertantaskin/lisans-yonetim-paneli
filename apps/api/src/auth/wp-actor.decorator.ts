import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * WordPress meta box aksiyonunu yapan WP kullanıcısının login'i (§7 "actor: wp:kullanıcı@site").
 * WP eklentisi `x-wp-actor` başlığıyla iletir. Bu uç HmacGuard arkasındadır → SİTE kimliği
 * site HMAC secret'ıyla doğrulanır (güven sınırı); başlık yalnız AUDIT ATTRIBUTION içindir
 * (hangi WP kullanıcısı tetikledi). Yetkilendirme site-scope kontrolüyle sağlanır, header ile DEĞİL.
 *
 * Sanitizasyon: yalnız güvenli karakterler (log/audit enjeksiyonu önlenir), üst sınır 60.
 * Controller bunu `wp:<user>@<site.domain>` biçiminde birleştirir (domain CurrentSite'tan — güvenilir).
 */
export const WpActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<FastifyRequest>();
  const raw = req.headers['x-wp-actor'];
  const user = (typeof raw === 'string' ? raw.trim() : '')
    .replace(/[^\w.@+\- ]/g, '')
    .slice(0, 60);
  return user || 'admin';
});
