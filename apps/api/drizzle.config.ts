import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit config. Migration'lar ./drizzle altında SQL olarak üretilir ve
 * versiyon kontrolüne girer (kuru çalıştırma + CI için).
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://lisanspanel:lisanspanel@localhost:5432/lisanspanel',
  },
  strict: true,
  verbose: true,
});
