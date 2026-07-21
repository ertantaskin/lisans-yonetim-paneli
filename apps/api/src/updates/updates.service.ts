import { Inject, Injectable } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { pluginReleases, type PluginRelease } from '../db/schema/pluginReleases';

/** Admin listesinde .zip gövdesi dönmez (büyük) — yalnız meta veri. */
export interface PluginReleaseMeta {
  id: string;
  version: string;
  changelog: string | null;
  createdAt: Date;
}

/**
 * UpdatesService — WP eklentisinin merkezî dağıtım kaynağı (§16). Yeni sürüm yayınlama
 * (admin) + en son sürümü/paketi sunma (public). "Private" = tek dağıtım kaynağı (panel),
 * erişim kısıtlaması değil; eklenti kodu sır değildir.
 */
@Injectable()
export class UpdatesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Sürüm yayınla — aynı version varsa UPDATE, yoksa INSERT (upsert). Yeniden yayınlama
   * created_at'i tazeler → o sürüm tekrar "en son" olur (latest sıralaması created_at DESC).
   */
  async publish(version: string, changelog: string | undefined, zipB64: string): Promise<PluginRelease> {
    const [row] = await this.db
      .insert(pluginReleases)
      .values({ version, changelog: changelog ?? null, zipB64 })
      .onConflictDoUpdate({
        target: pluginReleases.version,
        set: { changelog: changelog ?? null, zipB64, createdAt: new Date() },
      })
      .returning();
    return row!;
  }

  /** En son yayınlanan sürüm (created_at DESC ilk kayıt) veya kayıt yoksa null. */
  async latest(): Promise<PluginRelease | null> {
    const [row] = await this.db
      .select()
      .from(pluginReleases)
      .orderBy(desc(pluginReleases.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** Yayınlanmış sürümlerin listesi (en yeni önce), .zip gövdesi hariç. */
  async list(): Promise<PluginReleaseMeta[]> {
    return this.db
      .select({
        id: pluginReleases.id,
        version: pluginReleases.version,
        changelog: pluginReleases.changelog,
        createdAt: pluginReleases.createdAt,
      })
      .from(pluginReleases)
      .orderBy(desc(pluginReleases.createdAt));
  }

  /** Verilen sürümün .zip base64 gövdesi; sürüm yoksa null. */
  async getZip(version: string): Promise<string | null> {
    const [row] = await this.db
      .select({ zipB64: pluginReleases.zipB64 })
      .from(pluginReleases)
      .where(eq(pluginReleases.version, version))
      .limit(1);
    return row?.zipB64 ?? null;
  }
}
