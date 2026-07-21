import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { savedViews, type SavedView } from '../db/schema/savedViews';

/**
 * Kayıtlı görünümler servisi (§14). Operatör bir tablonun filtre/arama durumunu
 * (URL query) adlandırıp saklar, sonra tek tıkla geri yükler. Tüm işlemler ACTOR
 * bazlıdır: bir admin ASLA başka bir admin'in görünümünü göremez/silemez.
 */
@Injectable()
export class SavedViewsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Bu admin'in bu sayfaya ait görünümleri (en eski → en yeni). */
  async list(actor: string, page: string): Promise<SavedView[]> {
    return this.db
      .select()
      .from(savedViews)
      .where(and(eq(savedViews.actor, actor), eq(savedViews.page, page)))
      .orderBy(asc(savedViews.createdAt));
  }

  /** Yeni görünüm kaydeder; oluşturulan satırı döner. */
  async create(actor: string, page: string, name: string, query: string): Promise<SavedView> {
    const [row] = await this.db
      .insert(savedViews)
      .values({ actor, page, name, query })
      .returning();
    return row!;
  }

  /**
   * Görünümü siler — YALNIZ isteği yapan actor'a aitse. WHERE koşuluna actor de
   * eklendiğinden başkasının görünümü hedeflense bile hiçbir satır etkilenmez.
   * @returns silinen satır varsa true (yoksa: bulunamadı / başka actor'a ait).
   */
  async remove(actor: string, id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(savedViews)
      .where(and(eq(savedViews.id, id), eq(savedViews.actor, actor)))
      .returning({ id: savedViews.id });
    return deleted.length > 0;
  }
}
