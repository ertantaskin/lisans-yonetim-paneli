import { z } from 'zod';

/** Boş string'i undefined'a çevirir (docker-compose `${VAR:-}` boş geçtiğinde opsiyonel alanlar için). */
function emptyToUndefined<T extends z.ZodTypeAny>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema);
}

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
   * AES-256-GCM envelope master anahtarı (base64, 32 byte). Üret: openssl rand -base64 32
   * Faz 1'de payload şifreleme zorunlu — bu değişken zorunludur.
   */
  MASTER_KEY: z.string().min(1),

  /** Admin uçları (site/ürün/stok yönetimi) için basit yönetici token'ı. */
  ADMIN_TOKEN: z.string().min(1),

  /**
   * İlk admin bootstrap (§8). admin_users tablosu BOŞSA ve ikisi de verilmişse açılışta
   * bir "owner" admin oluşturulur. Sonraki adminler panelden eklenir. Opsiyonel.
   * NOT: docker-compose `${VAR:-}` boş string geçer → boş'u undefined'a çeviriyoruz
   * (aksi halde .email()/.min(8) boş string'de doğrulamayı patlatır).
   */
  ADMIN_SEED_EMAIL: emptyToUndefined(z.string().email().optional()),
  ADMIN_SEED_PASSWORD: emptyToUndefined(z.string().min(8).optional()),
  ADMIN_SEED_NAME: emptyToUndefined(z.string().optional()),
  ADMIN_SEED_USERNAME: emptyToUndefined(z.string().optional()),

  /** Teslimat maili SMTP (dev: Mailpit, TLS'siz; üretim: SMTP_SECURE=true). */
  SMTP_HOST: z.string().default('mailpit'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: z
    .string()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  MAIL_FROM: z.string().default('Jetlisans <teslimat@jetlisans.local>'),

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
