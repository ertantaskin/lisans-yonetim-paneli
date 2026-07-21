import { randomUUID } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { OnboardingService } from '../../src/onboarding/onboarding.service';
import type { RateLimitService } from '../../src/common/rate-limit.service';
import { SitesService } from '../../src/sites/sites.service';
import { cleanupByTag, createSite, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * OnboardingService.claim atomik tek-kullanım entegrasyon testi (§14 "tek-seferlik bağlan kodu").
 *
 * Gerçek PostgreSQL gerektirir: tek-kullanım güvencesi (consumed_at IS NULL koşullu UPDATE)
 * DB tarafında zorlanır. Redis yalnız IP rate-limit için gerekir → testin odağı DB atomikliği
 * olduğundan Redis SAHTE geçilir (incr artan sayaç döndürür, expire no-op); harness yalnız PG
 * (DATABASE_URL) garantiler. Kod bir kez claim edilince tüketilir; İKİNCİ claim 404 döner.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let onboarding: OnboardingService;
let siteId: string;
let siteDomain: string;

// Sahte RateLimitService — hit() her zaman true (limit altında). Testin odağı DB atomikliği;
// rate-limit ayrı test edilir (onboarding artık ham Redis yerine RateLimitService kullanır).
const fakeRateLimit = {
  hit: async () => true,
} as unknown as RateLimitService;

describe('OnboardingService.claim (tek-seferlik bağlan kodu — atomik)', () => {
  beforeAll(async () => {
    const h = makeDb();
    db = h.db;
    end = h.end;
    const crypto = makeCrypto();

    const site = await createSite(db, crypto, { tag });
    siteId = site.id;
    siteDomain = site.domain;

    const sites = new SitesService(db as never, crypto);
    onboarding = new OnboardingService(db as never, fakeRateLimit, crypto, sites);
  });

  afterAll(async () => {
    // site_connect_tokens'ın sites'a FK'si YOK (plain uuid) → cleanupByTag kapsamı dışı, elle sil.
    await db.execute(sql`DELETE FROM site_connect_tokens WHERE site_id = ${siteId}`);
    // Onboarding/site audit satırları (targetId = siteId) — bu siteye özgü, elle sil.
    await db.execute(sql`DELETE FROM audit_log WHERE target_id = ${siteId}`);
    await cleanupByTag(db, tag);
    await end();
  });

  it('ilk claim başarılı, ikinci claim 404 (kod tüketildi)', async () => {
    const { code } = await onboarding.issueConnectCode(siteId);

    // 1) İlk claim — creds bir kez teslim edilir (domain + taze api_key/hmac_secret).
    const creds = await onboarding.claim(code, '203.0.113.7');
    expect(creds.siteDomain).toBe(siteDomain);
    expect(creds.apiKey).toMatch(/^jl_/);
    expect(creds.hmacSecret).toHaveLength(64); // randomBytes(32) hex

    // 2) İkinci claim (AYNI kod) — tüketilmiş → 404. Çifte teslim imkânsız.
    await expect(onboarding.claim(code, '203.0.113.7')).rejects.toBeInstanceOf(NotFoundException);

    // Token DB'de tüketilmiş işaretli ve şifreli creds temizlenmiş (sızıntı penceresi kapalı).
    const tokens = await db
      .select()
      .from(schema.siteConnectTokens)
      .where(eq(schema.siteConnectTokens.siteId, siteId));
    expect(tokens).toHaveLength(1);
    expect(tokens[0]!.consumedAt).not.toBeNull();
    expect(tokens[0]!.apiKeyEnc).toBeNull();
    expect(tokens[0]!.hmacSecretEnc).toBeNull();
  });

  it('geçersiz kod her zaman 404 döner', async () => {
    await expect(onboarding.claim('ZZZZZ-ZZZZZ', '203.0.113.7')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
