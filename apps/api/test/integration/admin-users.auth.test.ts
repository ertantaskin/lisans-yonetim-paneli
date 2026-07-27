import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminUsersService } from '../../src/admin-users/admin-users.service';
import { makeDb, tagPrefix, type Db } from './_helpers';

/**
 * ENTEGRASYON — AdminUsersService (§8 çoklu-admin auth), gerçek PostgreSQL + Redis + scrypt.
 *
 * Doğrulanan davranışlar:
 *  (a) yanlış parola × MAX_FAILS → lockout; e-posta ve kullanıcı-adı yolları TEK hesap-kimliği
 *      kovasında (`authfail:id:<id>`) birleşir (2×bütçe brute-force yok). Bilinen-hesap yanlış
 *      parola KİMLİK-DİZESİ (e-posta) kovasını ARTIRMAZ (enumeration sızmaz).
 *  (b) kilit penceresinde DOĞRU parola bile reddedilir (429) — kova kontrolü parola doğrulamadan ÖNCE.
 *  (c) setDisabled → mevcut oturum (eski tokenVersion) validateSession'da null; pasif hesap her ver'de null.
 *  (d) resetPassword → tokenVersion +1 (eski oturum geçersiz); yeni parola çalışır, eskisi null.
 *  (e) BİLİNMEYEN kimlik kimlik-dizesi kovasında sayılır (varlık sızdırmadan hız-limitli); farklı
 *      bilinmeyen kimlik BAĞIMSIZ kova (per-identifier).
 *
 * scrypt GERÇEK (hashPassword/verifyPassword) — kullanıcı create ile oluşturulur, doğrulama gerçek
 * hash'e karşı koşar. Rate-limit gerçek Redis (REDIS_URL) gerektirir. admin_users cleanupByTag KAPSAMAZ
 * → tag'li e-postalar afterAll'da elle silinir; dokunulan Redis anahtarları da temizlenir.
 */

const MAX_FAILS = 10;
const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let redis: Redis;
let svc: AdminUsersService;

/** Temizlenecek Redis anahtarları (authfail:*). */
const redisKeys = new Set<string>();
function trackKeysFor(opts: { id?: string; email?: string; username?: string; identifier?: string }) {
  if (opts.id) redisKeys.add(`authfail:id:${opts.id}`);
  if (opts.email) redisKeys.add(`authfail:${opts.email.toLowerCase()}`);
  if (opts.username) redisKeys.add(`authfail:${opts.username.toLowerCase()}`);
  if (opts.identifier) redisKeys.add(`authfail:${opts.identifier.toLowerCase()}`);
}

let userSeq = 0;
async function mkUser(opts: { username?: boolean; password?: string } = {}) {
  const n = userSeq++;
  const email = `${tagPrefix(tag)}-${n}@example.test`;
  const username = opts.username ? `${tagPrefix(tag)}-user-${n}` : null;
  const password = opts.password ?? 'CorrectHorse9!';
  const created = await svc.create({
    email,
    password,
    name: `IT admin ${n}`,
    username: username ?? undefined,
    role: 'admin',
  });
  trackKeysFor({ id: created.id, email, username: username ?? undefined });
  return { ...created, email, username, password };
}

async function expect429(fn: () => Promise<unknown>): Promise<void> {
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(HttpException);
  expect((err as HttpException).getStatus()).toBe(429);
}

describe('AdminUsersService auth (lockout / oturum geçersizleme / enumeration)', () => {
  beforeAll(() => {
    const url = process.env.REDIS_URL;
    if (!url) {
      throw new Error('REDIS_URL tanımlı değil — admin-users auth testi gerçek Redis gerektirir.');
    }
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    redis = new Redis(url, { maxRetriesPerRequest: null });
    // config yalnız onModuleInit (seed) içinde kullanılır — burada çağrılmaz.
    svc = new AdminUsersService(db as never, redis as never, { get: () => undefined } as never);
    // Son-aktif-admin guard'ının setDisabled/remove testlerini bloke etmemesi için bir "keeper" admin.
    // (Global tabloda en az 2 aktif admin garanti.)
  });

  afterAll(async () => {
    if (redisKeys.size > 0) await redis.del(...redisKeys);
    await redis.quit();
    const like = `${tagPrefix(tag)}-%`;
    await db.delete(schema.adminUsers).where(sql`email LIKE ${like}`);
    await end();
  });

  it('(a)+(b) e-posta+kullanıcı-adı TEK kovada → MAX_FAILS sonra kilit; doğru parola bile 429', async () => {
    const u = await mkUser({ username: true });

    // 5 yanlış e-posta üzerinden + 5 yanlış kullanıcı adı üzerinden = 10 (acctKey ortak → kilit sınırı).
    for (let i = 0; i < 5; i++) {
      expect(await svc.verifyCredentials(u.email, 'WRONGpass1!')).toBeNull();
    }
    for (let i = 0; i < 5; i++) {
      expect(await svc.verifyCredentials(u.username!, 'WRONGpass1!')).toBeNull();
    }

    // Hesap-kimliği kovası tam MAX_FAILS; e-posta KİMLİK-DİZESİ kovası ARTMADI (enumeration sızmaz).
    expect(Number(await redis.get(`authfail:id:${u.id}`))).toBe(MAX_FAILS);
    expect(await redis.get(`authfail:${u.email.toLowerCase()}`)).toBeNull();

    // (b) kilit penceresinde DOĞRU parola bile 429 (kova kontrolü parola doğrulamadan önce).
    await expect429(() => svc.verifyCredentials(u.email, u.password));
    // Kullanıcı adı yolu da aynı hesap kovasına takılır.
    await expect429(() => svc.verifyCredentials(u.username!, u.password));
  });

  it('(c) setDisabled → eski tokenVersion oturumu null; pasif hesap her ver de null', async () => {
    await mkUser({ username: false }); // keeper (son-aktif-admin guard'ı için 2. aktif admin)
    const u = await mkUser();
    const v0 = u.tokenVersion;

    // Pasifleştirmeden ÖNCE oturum geçerli.
    expect(await svc.validateSession(u.id, v0)).not.toBeNull();

    const disabled = await svc.setDisabled(u.id, true);
    expect(disabled.disabled).toBe(true);
    expect(disabled.tokenVersion).toBe(v0 + 1); // pasifleştirmede tokenVersion +1

    // Eski oturum (v0) geçersiz; yeni ver de pasif olduğu için null.
    expect(await svc.validateSession(u.id, v0)).toBeNull();
    expect(await svc.validateSession(u.id, v0 + 1)).toBeNull();
  });

  it('(d) resetPassword → eski tokenVersion geçersiz; yeni parola çalışır, eskisi null', async () => {
    const u = await mkUser();
    const v0 = u.tokenVersion;
    expect(await svc.validateSession(u.id, v0)).not.toBeNull();

    const NEWPASS = 'BrandNewPass42!';
    const reset = await svc.resetPassword(u.id, NEWPASS);
    expect(reset.tokenVersion).toBe(v0 + 1);

    // Eski oturum geçersiz, yeni ver geçerli.
    expect(await svc.validateSession(u.id, v0)).toBeNull();
    expect(await svc.validateSession(u.id, v0 + 1)).not.toBeNull();

    // Yeni parola doğrular, eski parola null.
    expect(await svc.verifyCredentials(u.email, NEWPASS)).not.toBeNull();
    expect(await svc.verifyCredentials(u.email, u.password)).toBeNull();
  });

  it('(e) BİLİNMEYEN kimlik idKey kovasında sayılır + kilitlenir; farklı bilinmeyen kimlik BAĞIMSIZ', async () => {
    const ghost = `${tagPrefix(tag)}-ghost1@example.test`;
    trackKeysFor({ identifier: ghost });

    for (let i = 0; i < MAX_FAILS; i++) {
      expect(await svc.verifyCredentials(ghost, 'whatever9!')).toBeNull();
    }
    // Sayaç kimlik-dizesi kovasında (varlık sızdırmadan).
    expect(Number(await redis.get(`authfail:${ghost}`))).toBe(MAX_FAILS);
    // Kilitli: bir sonraki deneme 429.
    await expect429(() => svc.verifyCredentials(ghost, 'whatever9!'));

    // Farklı bilinmeyen kimlik BAĞIMSIZ (per-identifier) → hâlâ null (429 DEĞİL).
    const ghost2 = `${tagPrefix(tag)}-ghost2@example.test`;
    trackKeysFor({ identifier: ghost2 });
    expect(await svc.verifyCredentials(ghost2, 'whatever9!')).toBeNull();
  });
});
