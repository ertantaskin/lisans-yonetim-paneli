import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthedRequest } from './hmac.guard';
import type { Site } from '../db/schema';

/** Doğrulanmış siteyi controller'a enjekte eder (HmacGuard tarafından iliştirilir). */
export const CurrentSite = createParamDecorator((_data: unknown, ctx: ExecutionContext): Site => {
  const req = ctx.switchToHttp().getRequest<AuthedRequest>();
  if (!req.site) throw new Error('CurrentSite yalnız HmacGuard arkasında kullanılır');
  return req.site;
});
