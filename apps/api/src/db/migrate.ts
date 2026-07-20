import 'reflect-metadata';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Standalone migration runner. `pnpm --filter @jetlisans/api db:migrate`.
 * Docker compose'da api açılmadan önce (veya entrypoint'te) çalıştırılır.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL tanımlı değil');

  // migration için tek bağlantı yeterli.
  const client = postgres(url, { max: 1 });
  const db = drizzle(client);

  console.log('Migration başlıyor...');
  await migrate(db, { migrationsFolder: './drizzle' });
  console.log('Migration tamam.');

  await client.end();
}

main().catch((err) => {
  console.error('Migration başarısız:', err);
  process.exit(1);
});
