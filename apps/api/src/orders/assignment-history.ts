import { and, desc, eq } from 'drizzle-orm';
import type { Database } from '../db/db.module';
import { assignmentHistory, assignments } from '../db/schema';

/**
 * Değişim soyağacını (§3 "eski anahtarlar") kaydeder — revoke→completeLine ile eski key yerine
 * TAZE key atandıktan SONRA çağrılır (değişim/recall-toplu-değiştir/admin-replace ortak deseni).
 * assignment_history'ye yazar:
 *   assignmentId = yeni atama, oldLicenseItemId = değiştirilen (kusurlu) key, newLicenseItemId = taze key.
 * Yeni atama id'sini döndürür (çağıran newAssignmentId olarak da kullanabilir). Taze atama yoksa
 * (stok araya girip tükendi → completeLine no-op) null döner ve HİÇBİR ŞEY yazmaz (kayıt bütünlüğü).
 *
 * `opts.newAssignmentId` (KESİN yol — tercih edilen): `completeLine` sonucundaki
 * `createdAssignmentIds[0]`. Verilmezse GERİYE DÖNÜK yol kullanılır: "satırın EN YENİ aktif ataması".
 * O tahmin aynı satırda EŞZAMANLI iki değişimde YANLIŞ atamayı seçebilir (diğer değişimin taze
 * ataması daha yeniyse soyağacı ona bağlanır) → yeni çağıranlar id'yi MUTLAKA geçmelidir.
 *
 * `db`: dış transaction geçilebilir (revoke+atama+soyağacı TEK atomik birim olsun diye).
 *
 * NOT: yalnız DEĞİŞİM (markLineCanceled=false) yolunda çağrılır — gerçek iade/iptalde soyağacı yok.
 */
export async function recordReplacementLineage(
  db: Database,
  opts: {
    lineId: string;
    oldLicenseItemId: string | null;
    reason: string;
    actor: string;
    newAssignmentId?: string | null;
  },
): Promise<string | null> {
  const [fresh] = opts.newAssignmentId
    ? // KESİN: bu turda OLUŞTURULAN atama (id çağırandan geldi) — tahmin yok.
      await db
        .select({ id: assignments.id, licenseItemId: assignments.licenseItemId })
        .from(assignments)
        .where(eq(assignments.id, opts.newAssignmentId))
        .limit(1)
    : // Geriye dönük: satırın en yeni aktif ataması (eşzamanlı değişimde yanılabilir).
      await db
        .select({ id: assignments.id, licenseItemId: assignments.licenseItemId })
        .from(assignments)
        .where(and(eq(assignments.lineId, opts.lineId), eq(assignments.status, 'active')))
        // TIE-BREAK (id DESC) ŞART: qty>1 satırda atamalar TEK transaction'da yazılır ve
        // `now()` tx başını döndürdüğü için createdAt damgaları BİREBİR aynıdır → tie-break'siz
        // "en yeni" seçimi KEYFİ bir atamaya düşer ve soyağacı (assignment_history) KALICI
        // olarak yanlış atamaya bağlanır (denetim izi sonradan düzeltilemez). Yön ayna: DESC.
        // NOT: bu yalnız GERİYE DÖNÜK daldır; `newAssignmentId` geçen çağıranlar tahmin yapmaz.
        .orderBy(desc(assignments.createdAt), desc(assignments.id))
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
