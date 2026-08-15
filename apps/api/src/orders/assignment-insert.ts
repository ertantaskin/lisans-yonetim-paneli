import type { Database } from '../db/db.module';
import { assignments } from '../db/schema';

/**
 * Atama satırlarının toplu yazımı — TEK KAYNAK (createOrder + completeLine).
 *
 * NEDEN TOPLU: eskiden atanan HER BİRİM için ayrı `INSERT … RETURNING` atılıyordu
 * (tek-kullanımlık üründe `allocate()` kalem başına bir tahsis döndürür) → qty=500'lük bir
 * satır 500 seri gidiş-dönüş demekti; hepsi transaction İÇİNDE, satır kilitleri tutulurken,
 * havuzun (max 10) bir bağlantısı rezerveyken ve kota açık sitede advisory-lock altında.
 *
 * NEDEN CHUNK'LI (çürütme denetiminin bulduğu YENİ arıza modu): PostgreSQL Bind mesajı
 * parametre sayısını int16'da taşır (65535). Satır başına 7 kolon parametrize edildiği için
 * tek ifadeye geçiş ~9.362 tahsisten sonra `MAX_PARAMETERS_EXCEEDED` üretir ve TÜM sipariş
 * 500 ile geri alınır — eski döngüde böyle bir tavan YOKTU, yani düzeltmenin kendisi yeni bir
 * kırılma noktası açıyordu. Bu kod tabanı aynı tuzağı başka yerde zaten chunk'layarak çözüyor
 * (`products.service` katalog senkronu, 500'lük dilimler) — aynı sayı burada da kullanılır
 * (500 × 7 = 3.500 parametre, sınırın çok altında).
 *
 * NEDEN `licenseItemId` ile eşleme: `RETURNING`'in giriş sırasını koruduğu YAZILI bir garanti
 * değildir. Bir `allocations` dizisinde aynı kalem iki kez geçmez (tek-kullanımda her satır
 * ayrı kalem; multi'de `allocate` zaten kalem başına topluyor) — bu invaryant ÇAPRAZ-DOSYA
 * olduğu için burada AÇIKÇA doğrulanır: ihlal edilirse bir atama id'si sessizce kaybolur ve
 * yanıtta mükerrer id çıkardı (mağazanın tek adresleme anahtarı odur: reveal/replace/suspend).
 */

/** Tek ifadedeki azami satır (500 × 7 kolon = 3.500 parametre; int16 sınırı 65535). */
export const ASSIGNMENT_INSERT_CHUNK = 500;

export interface AssignmentInsertRow {
  orderId: string;
  lineId: string;
  licenseItemId: string;
  units: number;
  validUntil: Date | null;
  deliveredAt: Date;
}

/**
 * Satırları toplu yazar ve `licenseItemId → assignmentId` haritası döner.
 * Boş dizide hiç sorgu atmaz (boş `VALUES` söz dizimi hatası olurdu).
 */
export async function insertAssignments(
  exec: Database,
  rows: AssignmentInsertRow[],
): Promise<Map<string, string>> {
  const byItem = new Map<string, string>();
  if (rows.length === 0) return byItem;

  for (let i = 0; i < rows.length; i += ASSIGNMENT_INSERT_CHUNK) {
    const slice = rows.slice(i, i + ASSIGNMENT_INSERT_CHUNK);
    const inserted = await exec
      .insert(assignments)
      .values(slice.map((r) => ({ ...r, status: 'active' as const })))
      .returning({ id: assignments.id, licenseItemId: assignments.licenseItemId });
    for (const r of inserted) byItem.set(r.licenseItemId, r.id);
  }

  // Invaryant: her tahsis için AYRI bir atama id'si olmalı. Eşitsizlik yalnız dizide mükerrer
  // kalem varsa (Map üzerine yazar) ya da RETURNING eksik satır dönerse oluşur; ikisi de
  // sessiz kalırsa mağaza teslim edilmiş bir atamayı bir daha adresleyemez. Transaction
  // gövdesinde fırlatmak siparişin TAMAMINI geri alır — sessiz bozuk kayıttan iyidir.
  if (byItem.size !== rows.length) {
    throw new Error(
      `Atama yazımı tutarsız: ${rows.length} tahsis için ${byItem.size} kayıt okundu — sipariş geri alındı.`,
    );
  }
  return byItem;
}
