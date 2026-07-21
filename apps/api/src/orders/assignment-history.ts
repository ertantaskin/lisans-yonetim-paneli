import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { assignmentHistory, assignments } from '../db/schema';

/**
 * Değişim soyağacını (§3 "eski anahtarlar") kaydeder — revoke→completeLine ile eski key yerine
 * TAZE key atandıktan SONRA çağrılır (değişim/recall-toplu-değiştir/admin-replace ortak deseni).
 * Satırın EN YENİ aktif atamasını (taze key) bulur ve assignment_history'ye yazar:
 *   assignmentId = yeni atama, oldLicenseItemId = değiştirilen (kusurlu) key, newLicenseItemId = taze key.
 * Yeni atama id'sini döndürür (çağıran newAssignmentId olarak da kullanabilir). Taze atama yoksa
 * (stok araya girip tükendi → completeLine no-op) null döner ve HİÇBİR ŞEY yazmaz (kayıt bütünlüğü).
 *
 * NOT: yalnız DEĞİŞİM (markLineCanceled=false) yolunda çağrılır — gerçek iade/iptalde soyağacı yok.
 */
export async function recordReplacementLineage(
  db: Database,
  opts: { lineId: string; oldLicenseItemId: string | null; reason: string; actor: string },
): Promise<string | null> {
  const [fresh] = await db
    .select({ id: assignments.id, licenseItemId: assignments.licenseItemId })
    .from(assignments)
    .where(and(eq(assignments.lineId, opts.lineId), eq(assignments.status, 'active')))
    .orderBy(desc(assignments.createdAt))
    .limit(1);
  if (!fresh) return null;
  await db.insert(assignmentHistory).values({
    assignmentId: fresh.id,
    oldLicenseItemId: opts.oldLicenseItemId,
    newLicenseItemId: fresh.licenseItemId,
    reason: opts.reason,
    actor: opts.actor,
  });
  return fresh.id;
}
