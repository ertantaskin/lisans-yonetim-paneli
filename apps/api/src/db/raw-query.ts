import type { SQL } from 'drizzle-orm';
import type { Database } from './db.module';

/**
 * Ham SQL sorgusunu çalıştırıp satırları tip-güvenli dizi olarak döndürür.
 * db.execute() postgres-js RowList döndürür (Array benzeri ama Array<T> DEĞİL) —
 * cast tek noktada yapılır; çağrı yerlerinde "as unknown as Array<...>" tekrarı kalkar.
 * SQL'i DEĞİŞTİRMEZ; yalnızca dönüş tipini normalize eder.
 *
 * `db` tipi bilerek `Pick<Database, 'execute'>`: hem enjekte edilen tam `Database`,
 * hem transaction (`tx`), hem de assign.ts'teki `Executor` alias'ı (aynı Pick) tek
 * helper'ı paylaşabilsin — üçü de yalnızca `.execute` taşır (davranış değişmez).
 */
export async function rawRows<T>(db: Pick<Database, 'execute'>, query: SQL): Promise<T[]> {
  const rows = await db.execute(query);
  return rows as unknown as T[];
}
