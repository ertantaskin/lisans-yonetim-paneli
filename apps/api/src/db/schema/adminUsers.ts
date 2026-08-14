import { sql } from 'drizzle-orm';
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * admin_users — panel yöneticileri (§8). Çoklu admin; e-posta VEYA kullanıcı adı + parola.
 * Parola scrypt ile hash'lenir (password_hash formatı: `scrypt$<saltHex>$<hashHex>`).
 * role ileride RBAC için (owner tüm yetki; admin standart). disabled: erişimi kapatır.
 */
export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  username: text('username').unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('admin'),
  disabled: boolean('disabled').notNull().default(false),
  /** Oturum iptali için: disable/delete/parola-sıfırlama'da +1 → eski token'lar geçersizleşir (§8). */
  tokenVersion: integer('token_version').notNull().default(0),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  /**
   * TOTP (iki faktörlü giriş) sırrı — AES-256-GCM envelope ile ŞİFRELİ saklanır (payload'larla
   * aynı kasa; düz metin ASLA yazılmaz). NULL = kullanıcı henüz kurulum yapmadı.
   *
   * NEDEN: panel canlı lisans deposunun tek kapısı ve giriş tek faktörlüydü — ele geçen bir
   * parola owner rolünde TÜM envanteri düz metin gösterebilir ve dağıtım tetikleyebilirdi.
   */
  totpSecretEnc: text('totp_secret_enc'),
  /**
   * TOTP gerçekten AÇIK mı. Kurulum sırasında sır yazılır ama bayrak, kullanıcı ilk kodu
   * DOĞRULAYANA kadar false kalır — yoksa yanlış kurulumda hesap kendini kilitlerdi.
   */
  totpEnabled: boolean('totp_enabled').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .default(sql`now()`),
});

export type AdminUser = typeof adminUsers.$inferSelect;
export type NewAdminUser = typeof adminUsers.$inferInsert;
