import { z } from 'zod';

/**
 * Ortam değişkeni şeması. Uygulama açılışında doğrulanır (§8 "zod şema doğrulama").
 * Eksik/hatalı değişkenle uygulama BAŞLAMAZ — sessiz yanlış konfig olmaz.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  /**
   * AES-256-GCM envelope master anahtarı (base64, 32 byte).
   * Faz 0'da opsiyonel bırakıldı; Faz 1'de şifreleme devreye girince zorunlu olur.
   */
  MASTER_KEY: z.string().optional(),

  SENTRY_DSN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** @nestjs/config `validate` kancası. */
export function validateEnv(config: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Ortam değişkeni doğrulaması başarısız:\n${issues}`);
  }
  return parsed.data;
}
