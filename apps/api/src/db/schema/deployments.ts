import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * deployments — panelden tetiklenen prod dağıtım istekleri + geçmişi (§16 "sürüm/dağıtım
 * yönetimi panelden görünür"). Panel YALNIZ bir istek KAYDEDER (status='pending'); VPS
 * host'undaki `scripts/deploy-runner.sh` (cron) bunu görüp `deploy.sh`'ı çalıştırır ve
 * sonucu buraya geri yazar (running → success/failed). Panel konteynerine Docker soketi
 * VERİLMEZ (güvenlik: konteynerden host'a tam erişim) — host runner ayrımı bu yüzden.
 *
 * requested_by = isteği yapan admin (auth açıkken owner-only; kapalıyken 'panel:admin').
 */
export const deployments = pgTable(
  'deployments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Ne dağıtılacak: 'api' | 'admin' | 'api admin' (deploy.sh argümanı). */
    target: text('target').notNull(),
    /** pending → running → success | failed. */
    status: text('status').notNull().default('pending'),
    /** İsteği yapan admin (audit); auth kapalıysa 'panel:admin'. */
    requestedBy: text('requested_by').notNull(),
    /** Dağıtılan git kısa SHA (runner doldurur). */
    gitSha: text('git_sha'),
    /** deploy.sh çıktısının kuyruğu (runner doldurur; sınırlı uzunluk). */
    log: text('log'),
    /** Hata özeti (status='failed' ise). */
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('deployments_created_idx').on(t.createdAt.desc()),
    index('deployments_status_idx').on(t.status),
  ],
);

export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
