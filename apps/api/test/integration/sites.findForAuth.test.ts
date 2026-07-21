import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HMAC_KEY_ROTATION_GRACE_SEC } from '@jetlisans/shared';
import { SitesService } from '../../src/sites/sites.service';
import { CryptoService } from '../../src/crypto/crypto.service';
import * as schema from '../../src/db/schema';
import type { Database } from '../../src/db/db.module';
import { cleanupByTag, createSite, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — SitesService.findForAuth api_key rotasyon zarafet penceresi (migration 0017),
 * gerçek PostgreSQL'e karşı.
 *
 * rekey() api_key'i ANINDA değiştirir (yeni hash), eski hash'i api_key_hash_prev'e taşır ve
 * api_key_rotated_at'i now yapar. findForAuth: eski api_key ile gelen istek, rotasyon
 * HMAC_KEY_ROTATION_GRACE_SEC (24s) penceresi İÇİNDEYSE siteyi yine bulur; pencere dolunca
 * eski hash reddedilir. Yeni api_key her zaman kabul (hmac secret grace deseninin aynası, §4/§14).
 *
 * Nest ayağa KALDIRILMAZ: SitesService elle new'lenir (gerçek db + gerçek CryptoService).
 * Her assert kendi tag'iyle seed edip afterAll'da yalnız kendi eklediklerini siler.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let sites: SitesService;

describe('SitesService.findForAuth — api_key rotasyon grace (0017)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    crypto = makeCrypto();
    sites = new SitesService(db as unknown as Database, crypto);
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('rekey sonrası YENİ api_key → her zaman kabul (site döner)', async () => {
    const site = await createSite(db, crypto, { tag });
    const { apiKey: newApiKey } = await sites.rekey(site.id);

    const auth = await sites.findForAuth(newApiKey);
    expect(auth).not.toBeNull();
    expect(auth!.site.id).toBe(site.id);
    // Yeni secret çözülür (en az bir kabul edilebilir secret listede).
    expect(auth!.hmacSecrets.length).toBeGreaterThanOrEqual(1);
  });

  it('rekey sonrası ESKİ api_key → grace penceresinde KABUL (site döner)', async () => {
    const site = await createSite(db, crypto, { tag });
    const oldApiKey = site.apiKey; // rekey öncesi anahtar
    await sites.rekey(site.id); // rotated_at = now → grace açık

    const auth = await sites.findForAuth(oldApiKey);
    expect(auth).not.toBeNull();
    expect(auth!.site.id).toBe(site.id);
  });

  it('rekey sonrası ESKİ api_key → grace penceresi DIŞINDA reddedilir (null)', async () => {
    const site = await createSite(db, crypto, { tag });
    const oldApiKey = site.apiKey;
    await sites.rekey(site.id);

    // Rotasyon zamanını grace penceresinin ötesine it (api_key_hash_prev korunur ama artık geçersiz).
    await db
      .update(schema.sites)
      .set({ apiKeyRotatedAt: new Date(Date.now() - (HMAC_KEY_ROTATION_GRACE_SEC + 3600) * 1000) })
      .where(eq(schema.sites.id, site.id));

    await expect(sites.findForAuth(oldApiKey)).resolves.toBeNull();
  });

  it('grace penceresi DIŞINDA bile YENİ api_key kabul edilmeye devam eder', async () => {
    const site = await createSite(db, crypto, { tag });
    const { apiKey: newApiKey } = await sites.rekey(site.id);

    await db
      .update(schema.sites)
      .set({ apiKeyRotatedAt: new Date(Date.now() - (HMAC_KEY_ROTATION_GRACE_SEC + 3600) * 1000) })
      .where(eq(schema.sites.id, site.id));

    const auth = await sites.findForAuth(newApiKey);
    expect(auth).not.toBeNull();
    expect(auth!.site.id).toBe(site.id);
  });

  it('hiç kayıtlı olmayan api_key → null', async () => {
    await createSite(db, crypto, { tag }); // FK/izolasyon için bir site var ama bu anahtar ona ait değil
    await expect(sites.findForAuth(`jl_${randomUUID().replace(/-/g, '')}`)).resolves.toBeNull();
  });
});
