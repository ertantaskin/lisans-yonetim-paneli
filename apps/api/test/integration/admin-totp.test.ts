import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import Redis from 'ioredis';
import { ForbiddenException, HttpException } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { AdminUsersService } from '../../src/admin-users/admin-users.service';
import { AdminTotpService } from '../../src/admin-users/totp.service';
import { totpCodeForStep, totpStep } from '../../src/auth/totp';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { makeCrypto, makeDb, tagPrefix, type Db } from './_helpers';

/**
 * ENTEGRASYON — admin girişinde TOTP (iki faktörlü doğrulama), gerçek PostgreSQL + Redis +
 * gerçek scrypt + gerçek AES-256-GCM envelope.
 *
 * Doğrulanan davranışlar:
 *  (a) kurulum → doğrulama → `totp_enabled=true`; onaya kadar bayrak KAPALI (yanlış kurulumda
 *      hesap kilitlenmez) ve sır DB'ye ŞİFRELİ yazılır (düz metin yok).
 *  (b) TOTP açıkken parola tek başına giriş VERMEZ: `login()` `totp_required` döner, eski
 *      `verifyCredentials()` null → çağıran çerez basamaz; `last_login_at` de YAZILMAZ.
 *  (c) yanlış kod hesap-lockout sayacını (parola ile AYNI kova) artırır; MAX_FAILS'te 429.
 *  (d) aynı kod İKİNCİ kez kabul edilmez (replay defteri Redis'te).
 *  (e) owner sıfırlaması → sır silinir + `token_version` +1 → açık oturumlar düşer.
 *  (f) `totp_enabled=false` kullanıcıda giriş AYNEN eskisi gibi (geriye dönük uyum).
 *  (g) yetki: başka bir yöneticinin TOTP'sini kurmaya çalışan owner-olmayan admin 403 alır.
 *  (h) `toPublic()` şifreli sırrı DIŞARI VERMEZ (list/login yanıtları).
 *
 * admin_users `cleanupByTag` KAPSAMAZ → tag'li e-postalar afterAll'da elle silinir; dokunulan
 * Redis anahtarları da temizlenir.
 */

const MAX_FAILS = 10; // servis ile aynı
const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let redis: Redis;
let crypto: CryptoService;
let users: AdminUsersService;
let totp: AdminTotpService;

const redisKeys = new Set<string>();

let seq = 0;
async function mkUser(password = 'CorrectHorse9!') {
  const n = seq++;
  const email = `${tagPrefix(tag)}-${n}@example.test`;
  const created = await users.create({ email, password, name: `IT totp ${n}`, role: 'admin' });
  redisKeys.add(`authfail:id:${created.id}`);
  return { ...created, email, password, actor: `admin:${email}` };
}

/** Kurulum + onay: kullanıcıyı TOTP açık hâle getirir ve sırrı döndürür. */
async function enableTotp(user: { id: string; actor: string }): Promise<string> {
  const { secret } = await totp.beginSetup(user.id, user.actor, '');
  const step = totpStep();
  redisKeys.add(`totp:used:${user.id}:${step}`);
  await totp.confirmSetup(user.id, totpCodeForStep(secret, step), user.actor, '');
  return secret;
}

/** O an geçerli OLMAYAN 6 haneli bir kod (pencere içindeki üç kodun hiçbiri değil). */
function wrongCode(secret: string): string {
  const now = totpStep();
  const valid = new Set([-1, 0, 1].map((d) => totpCodeForStep(secret, now + d)));
  for (let i = 0; i < 1000; i++) {
    const candidate = String(i).padStart(6, '0');
    if (!valid.has(candidate)) return candidate;
  }
  throw new Error('geçersiz kod üretilemedi');
}

describe('Admin TOTP (kurulum / giriş / lockout / replay / kurtarma)', () => {
  beforeAll(() => {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('REDIS_URL tanımlı değil — TOTP testi gerçek Redis gerektirir.');
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    redis = new Redis(url, { maxRetriesPerRequest: null });
    crypto = makeCrypto();
    totp = new AdminTotpService(db as never, redis as never, crypto);
    // config yalnız onModuleInit (seed) içinde kullanılır — burada çağrılmaz.
    users = new AdminUsersService(db as never, redis as never, { get: () => undefined } as never, totp);
  });

  afterAll(async () => {
    if (redisKeys.size > 0) await redis.del(...redisKeys);
    await redis.quit();
    await db.delete(schema.adminUsers).where(sql`email LIKE ${`${tagPrefix(tag)}-%`}`);
    await end();
  });

  it('(a) kurulum: onaya kadar bayrak KAPALI, sır DB’de ŞİFRELİ; onay sonrası açık', async () => {
    const u = await mkUser();
    const before = await totp.status(u.id);
    expect(before.totpEnabled).toBe(false);
    expect(before.pendingSetup).toBe(false);

    const { secret, otpauthUri } = await totp.beginSetup(u.id, u.actor, '');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(otpauthUri).toContain(encodeURIComponent(u.email));

    // Sır yazıldı ama bayrak HÂLÂ kapalı → yanlış kurulumda hesap kilitlenmez.
    const mid = await totp.status(u.id);
    expect(mid.totpEnabled).toBe(false);
    expect(mid.pendingSetup).toBe(true);
    // Bu aşamada giriş DEĞİŞMEZ (ikinci faktör henüz devrede değil).
    expect(await users.verifyCredentials(u.email, u.password)).not.toBeNull();

    // DB'de düz metin YOK; yalnız envelope ciphertext var ve doğru AAD ile çözülüyor.
    const [row] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, u.id))
      .limit(1);
    expect(row!.totpSecretEnc).toBeTruthy();
    expect(row!.totpSecretEnc).not.toContain(secret);
    expect(crypto.decrypt(row!.totpSecretEnc!, `admin_user:${u.id}`)).toBe(secret);
    // AAD kayıt kimliğine bağlı → başka bir satırın id'siyle çözülemez (satır taşıma imkânsız).
    expect(() => crypto.decrypt(row!.totpSecretEnc!, `admin_user:${randomUUID()}`)).toThrow();

    const step = totpStep();
    redisKeys.add(`totp:used:${u.id}:${step}`);
    await totp.confirmSetup(u.id, totpCodeForStep(secret, step), u.actor, '');
    expect((await totp.status(u.id)).totpEnabled).toBe(true);

    // (h) şifreli sır dışa dönük görünümde YOK.
    const listed = (await users.list()).find((a) => a.id === u.id)!;
    expect('totpSecretEnc' in listed).toBe(false);
  });

  it('(b) TOTP açıkken parola TEK BAŞINA giriş vermez (oturum yok, last_login_at yazılmaz)', async () => {
    const u = await mkUser();
    await enableTotp(u);

    const outcome = await users.login(u.email, u.password);
    expect(outcome).toEqual({ status: 'totp_required', sub: u.id });
    // Eski imza: yalnız TAM başarıda kullanıcı döner → çağıran çerez basamaz.
    expect(await users.verifyCredentials(u.email, u.password)).toBeNull();

    const [row] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, u.id))
      .limit(1);
    expect(row!.lastLoginAt).toBeNull(); // giriş TAMAMLANMADI

    // Yanlış parola + TOTP açık: yine null ve "totp_required" SIZMAZ.
    expect(await users.login(u.email, 'WRONGpass1!')).toBeNull();
  });

  it('(b2) ikinci adım geçilince giriş tamamlanır (last_login_at + kova temizliği)', async () => {
    const u = await mkUser();
    const secret = await enableTotp(u);

    const step = totpStep();
    redisKeys.add(`totp:used:${u.id}:${step}`);
    const user = await users.verifyTotpLogin(u.id, totpCodeForStep(secret, step));
    expect(user).not.toBeNull();
    expect(user!.id).toBe(u.id);
    expect('totpSecretEnc' in user!).toBe(false);

    const [row] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, u.id))
      .limit(1);
    expect(row!.lastLoginAt).not.toBeNull();
    expect(await redis.get(`authfail:id:${u.id}`)).toBeNull();
  });

  it('(c) yanlış kod parola ile AYNI lockout kovasını artırır; MAX_FAILS’te 429', async () => {
    const u = await mkUser();
    const secret = await enableTotp(u);
    const bad = wrongCode(secret);
    const acctKey = `authfail:id:${u.id}`;

    expect(await users.verifyTotpLogin(u.id, bad)).toBeNull();
    expect(Number(await redis.get(acctKey))).toBe(1);

    // Kalan bütçe: parola denemeleriyle ORTAK kova (ayrı kova = 2× brute-force bütçesi olurdu).
    expect(await users.verifyCredentials(u.email, 'WRONGpass1!')).toBeNull();
    expect(Number(await redis.get(acctKey))).toBe(2);

    for (let i = 2; i < MAX_FAILS; i++) {
      expect(await users.verifyTotpLogin(u.id, bad)).toBeNull();
    }
    expect(Number(await redis.get(acctKey))).toBe(MAX_FAILS);

    // Kilit penceresinde DOĞRU kod bile reddedilir (kova kontrolü doğrulamadan ÖNCE).
    const step = totpStep();
    redisKeys.add(`totp:used:${u.id}:${step}`);
    let err: unknown;
    try {
      await users.verifyTotpLogin(u.id, totpCodeForStep(secret, step));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpException);
    expect((err as HttpException).getStatus()).toBe(429);
    // Parola adımı da aynı kilide takılır.
    await expect(users.login(u.email, u.password)).rejects.toBeInstanceOf(HttpException);
  });

  it('(d) aynı kod İKİNCİ kez kabul edilmez (replay)', async () => {
    const u = await mkUser();
    const secret = await enableTotp(u);
    const step = totpStep();
    redisKeys.add(`totp:used:${u.id}:${step}`);
    const code = totpCodeForStep(secret, step);

    expect(await users.verifyTotpLogin(u.id, code)).not.toBeNull();
    // Kod hâlâ zaman penceresinde ama defterde işaretli → REDDEDİLİR.
    expect(await users.verifyTotpLogin(u.id, code)).toBeNull();
    expect(Number(await redis.get(`authfail:id:${u.id}`))).toBe(1);
  });

  it('(e) owner sıfırlaması: sır silinir + token_version +1 → açık oturumlar düşer', async () => {
    const u = await mkUser();
    await enableTotp(u);
    const [before] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, u.id))
      .limit(1);
    const oldVer = before!.tokenVersion;
    // Sıfırlamadan ÖNCE oturum geçerli.
    expect(await users.validateSession(u.id, oldVer)).not.toBeNull();

    await totp.reset(u.id, 'admin:owner@example.test');

    const [after] = await db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.id, u.id))
      .limit(1);
    expect(after!.totpEnabled).toBe(false);
    expect(after!.totpSecretEnc).toBeNull();
    expect(after!.tokenVersion).toBe(oldVer + 1);
    expect(await users.validateSession(u.id, oldVer)).toBeNull(); // açık oturum düştü

    // Sıfırlama sonrası giriş yeniden TEK adım (kullanıcı yeniden kurulum yapana kadar).
    expect(await users.verifyCredentials(u.email, u.password)).not.toBeNull();
  });

  it('(e2) kapatma: kullanıcı parola + GEÇERLİ kod ister; eksikse UnauthorizedException', async () => {
    const u = await mkUser();
    const secret = await enableTotp(u);

    // Rol 'admin' + kendi hesabı: parola/kod zorunlu.
    await expect(totp.disable(u.id, {}, u.actor, 'admin')).rejects.toThrow();
    await expect(
      totp.disable(u.id, { password: 'WRONGpass1!', code: '000000' }, u.actor, 'admin'),
    ).rejects.toThrow();
    expect((await totp.status(u.id)).totpEnabled).toBe(true);

    const step = totpStep();
    redisKeys.add(`totp:used:${u.id}:${step}`);
    await totp.disable(
      u.id,
      { password: u.password, code: totpCodeForStep(secret, step) },
      u.actor,
      'admin',
    );
    const after = await totp.status(u.id);
    expect(after.totpEnabled).toBe(false);
    expect(after.pendingSetup).toBe(false); // sır da silindi
  });

  it('(f) totp_enabled=false kullanıcıda akış AYNEN eskisi gibi (geriye dönük uyum)', async () => {
    const u = await mkUser();
    expect(await users.login(u.email, u.password)).toEqual({
      status: 'ok',
      user: expect.objectContaining({ id: u.id, email: u.email }),
    });
    expect(await users.verifyCredentials(u.email, u.password)).not.toBeNull();
    expect(await users.verifyCredentials(u.email, 'WRONGpass1!')).toBeNull();
    // TOTP kapalıyken ikinci adım ucu da kullanılamaz (yanlış akışa kapı yok).
    expect(await users.verifyTotpLogin(u.id, '123456')).toBeNull();
  });

  it('(g) yetki: owner-olmayan admin BAŞKASININ TOTP’sini kuramaz/kapatamaz', async () => {
    const target = await mkUser();
    const other = await mkUser();
    await expect(totp.beginSetup(target.id, other.actor, 'admin')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(totp.disable(target.id, {}, other.actor, 'admin')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    // Owner ise yapabilir (kurtarma yetkisi).
    const { secret } = await totp.beginSetup(target.id, other.actor, 'owner');
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});
