import { z } from 'zod';

/** /v1/health yanıtı — bağlantı testi (§4). */
export const HealthResponse = z.object({
  status: z.enum(['ok', 'degraded', 'down']),
  version: z.string(),
  time: z.string().datetime(),
  checks: z.object({
    db: z.boolean(),
    redis: z.boolean(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;
