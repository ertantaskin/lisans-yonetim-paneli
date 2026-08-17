import { Inject, Injectable } from '@nestjs/common';
import { compareVersions } from '@lisans/shared';
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

  /**
   * Verilen sürümün .zip base64 gövdesi.
   *
   * ÜÇ DURUM AYRILIR: sürüm hiç yok (`missing`) ≠ sürüm var ama paketi arşivden düşürülmüş
   * (`archived`) ≠ paket hazır (`ok`). Saklama motoru eski sürümlerin GÖVDESİNİ boşaltır
   * (sürüm geçmişi satırı KALIR — panelde görünür kalması bilinçli). Ayrım olmasaydı arşivlenmiş
   * bir sürüm "Sürüm bulunamadı" derdi ve operatör yayının SİLİNDİĞİNİ sanırdı.
   */
  async getZip(
    version: string,
  ): Promise<{ state: 'missing' } | { state: 'archived' } | { state: 'ok'; zipB64: string }> {
    const [row] = await this.db
      .select({ zipB64: pluginReleases.zipB64 })
      .from(pluginReleases)
      .where(eq(pluginReleases.version, version))
      .limit(1);
    if (!row) return { state: 'missing' };
    if (!row.zipB64) return { state: 'archived' };
    return { state: 'ok', zipB64: row.zipB64 };
  }
}

/**
 * Semver karşılaştırma `@lisans/shared` → `domain/semver.ts`'te YAŞAR; burada yalnız yeniden
 * export edilir (mevcut çağıranlar — `retention.service` — kırılmasın).
 *
 * NEDEN PAYLAŞILDI: aynı kural admin `/releases` ekranında da karar veriyor ("En yeni" rozeti
 * + düşük sürüm yayınlama kapısı) ve iki AYRI kopya duruyordu. Davranışları birebir aynıydı,
 * yani sorun bugünkü sonuç değil YARINKİ SAPMAYDI: biri ön-sürüm desteği kazansa panel bir
 * sürümü "en yeni" diye damgalarken müşteri siteleri BAŞKA paketi indirmeye devam ederdi ve
 * bu hiçbir yerde hata üretmezdi.
 *
 * `export { … } from` DEĞİL, import + ayrı export: yeniden-export adı bu modülde YEREL olarak
 * BAĞLAMAZ (bu kod tabanında daha önce yaşandı) — yukarıdaki `latest()` onu kullanıyor.
 */
export { compareVersions };
