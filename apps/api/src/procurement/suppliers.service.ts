import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { suppliers, type Supplier } from '../db/schema/suppliers';

/**
 * SuppliersService — tedarikçi CRUD (§12). Silme yok; pasifleştirme active=false ile
 * (geçmiş PO/parti referansları korunur).
 */
@Injectable()
export class SuppliersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(input: { name: string; contact?: string; notes?: string }): Promise<Supplier> {
    const [row] = await this.db
      .insert(suppliers)
      .values({
        name: input.name,
        contact: input.contact ?? null,
        notes: input.notes ?? null,
      })
      .returning();
    return row!;
  }

  async list(): Promise<Supplier[]> {
    return this.db.select().from(suppliers).orderBy(desc(suppliers.createdAt));
  }

  async getById(id: string): Promise<Supplier> {
    const [row] = await this.db.select().from(suppliers).where(eq(suppliers.id, id)).limit(1);
    if (!row) throw new NotFoundException('Tedarikçi bulunamadı');
    return row;
  }

  /** Kısmi güncelleme (ör. active=false ile pasifleştirme). */
  async update(
    id: string,
    patch: { name?: string; contact?: string | null; notes?: string | null; active?: boolean },
  ): Promise<Supplier> {
    await this.getById(id);
    const [row] = await this.db
      .update(suppliers)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(suppliers.id, id))
      .returning();
    return row!;
  }
}
