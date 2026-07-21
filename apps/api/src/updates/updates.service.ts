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

  /**
   * En YÜKSEK SEMVER sürüm (major.minor.patch) veya kayıt yoksa null. Yayın SIRASI
   * (created_at) yerine sürüm NUMARASI baz alınır → sırasız (out-of-order) yayında
   * (örn. 1.4.0'dan sonra hotfix 1.3.9 yayınlanırsa) siteler eski sürüme sabitlenmez.
   * Geçersiz biçimli sürüm daima en sona (en düşük) sıralanır. Sürümler benzersiz
   * (unique constraint) olduğundan eşitlik oluşmaz.
   */
  async latest(): Promise<PluginReleaseMeta | null> {
    // Yalnız meta kolonları — zip_b64 gövdesi HARİÇ. En yüksek semver'i seçmek için TÜM
    // sürümlerin tam .zip base64 gövdesini belleğe çekmek gereksizdi (N sürüm × ~1MB).
    // info() zaten yalnız version/changelog/createdAt kullanır → gövdeye ihtiyaç yok.
    const rows = await this.db
      .select({
        id: pluginReleases.id,
        version: pluginReleases.version,
        changelog: pluginReleases.changelog,
        createdAt: pluginReleases.createdAt,
      })
      .from(pluginReleases);
    if (rows.length === 0) return null;
    return rows.reduce((best, row) => (compareVersions(row.version, best.version) > 0 ? row : best));
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

/** "major.minor.patch" → [maj, min, pat] sayısal üçlü; biçime uymuyorsa null (geçersiz). */
function parseSemver(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Semver karşılaştırma: a>b → +1, a<b → -1, eşit → 0. Geçersiz biçimli sürüm daima
 * daha düşük sayılır (en sona sıralanır); iki geçersizde 0 döner.
 */
function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}
