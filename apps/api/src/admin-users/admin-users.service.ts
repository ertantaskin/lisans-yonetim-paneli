import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import { adminUsers, type AdminUser } from '../db/schema';
import { hashPassword, verifyPassword, dummyHash, needsRehash } from '../auth/password';
import { isUniqueViolation } from '../db/pg-error';
import { recordAuthEvent } from './auth-events';
import { AdminTotpService } from './totp.service';

/**
 * Parola hash'i olmadan dışa dönük admin görünümü.
 *
 * `totpSecretEnc` de ÇIKARILIR: şifreli olsa bile TOTP sırrının ciphertext'ini listeleme/login
 * yanıtlarında dolaştırmak gereksiz bir sızıntı yüzeyidir (sites `toPublicSite()` mapper'ıyla
 * aynı ilke — sır kolonları tek noktada strip edilir). Ekranlara yalnız `totpEnabled` bayrağı gider.
 */
export type PublicAdminUser = Omit<AdminUser, 'passwordHash' | 'totpSecretEnc'>;

/**
 * Giriş sonucu. `totp_required` = parola DOĞRU ama ikinci faktör bekleniyor —
 * bu durumda ÇAĞIRAN OTURUM AÇMAZ (yarım oturum yok, çerez verilmez).
 */
export type LoginOutcome =
  | { status: 'ok'; user: PublicAdminUser }
  | { status: 'totp_required'; sub: string };

const MAX_FAILS = 10; // kimlik başına başarısız deneme sınırı
const FAIL_WINDOW_SEC = 900; // 15 dk

/** Lockout penceresi (saniye) — controller 429'a `Retry-After` başlığı koyarken kullanır. */
export const LOGIN_FAIL_WINDOW_SEC = FAIL_WINDOW_SEC;

/**
 * Hesap-lockout kovasının ORTAK sözleşmesi — parola girişi, TOTP adımı ve TOTP kapatma
 * AYNI kovayı paylaşır. Ayrı kovalar, parolayı ele geçirmiş birine her adım için TAZE bir
 * deneme bütçesi vermek demektir. `totp.service` de buradan okur (iki yerde iki sabit
 * tutmak sapma üretirdi).
 */
export const ACCOUNT_FAIL_KEY = (userId: string) => `authfail:id:${userId}`;
export const ACCOUNT_MAX_FAILS = MAX_FAILS;

/**
 * Kimlik üst sınırı — GİRİŞ ile OLUŞTURMA yolunun TEK kaynağı (controller ZodBody bunu import eder).
 *
 * NEDEN TEK KAYNAK (denetim bulgusu): `login` bu sınırın üstündeki kimliği DB'ye hiç inmeden
 * `null`'lar ("hiçbir gerçek kimlik bu aralığın dışında olamaz" varsayımıyla). Oysa OLUŞTURMA
 * yolunda sınır YOKTU: `CreateBody` e-posta/kullanıcı adı için `.max()` taşımıyordu ve `onModuleInit`
 * seed'i controller Zod'unu HİÇ geçmiyor. 200+ karakterli bir kimlikle açılan hesap KALICI olarak
 * giriş yapamaz ve hata jenerik "Geçersiz kimlik veya parola" olduğu için sebebi görünmez.
 * Sınır artık iki uçta da AYNI sabitten gelir → varsayım gerçekten garanti edilir.
 */
export const MAX_IDENTIFIER_LEN = 200;

/**
 * Kimlik-dizesi kova anahtarı. HAM identifier YERİNE sha256 özeti kullanılır:
 *  (a) anahtar uzunluğu sabitlenir → uzun dizelerle Redis şişirilemez (900 sn TTL),
 *  (b) kullanıcı kimliği (e-posta = PII) Redis'e DÜZ yazılmaz.
 * Ad-alanı `authfail:h:` — hesap kovası (`authfail:id:<uuid>`) ile çakışmaz.
 */
function identifierBucketKey(normalizedIdentifier: string): string {
  return `authfail:h:${createHash('sha256').update(normalizedIdentifier).digest('hex')}`;
}

@Injectable()
export class AdminUsersService implements OnModuleInit {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
    /**
     * TOTP doğrulayıcı. @Optional: servis Nest DI dışında (entegrasyon testlerinde) elle
     * new'lenebiliyor ve mevcut çağıranlar 3 argümanla kuruluyor — geriye dönük uyum bozulmasın.
     * Enjekte EDİLMEMİŞSE ve kullanıcıda TOTP açıksa giriş FAIL-CLOSED reddedilir (aşağıya bkz.).
     *
     * @Inject ZORUNLU (sessiz tuzak): TypeScript, OPSİYONEL bir parametrenin tipini
     * `AdminTotpService | undefined` birleşimi olarak görür ve `design:paramtypes` metadata'sına
     * `Object` yazar. Token açıkça verilmezse Nest `Object`i çözemez, @Optional yüzünden de
     * HATA VERMEZ — bağımlılığı sessizce `undefined` bırakırdı ve TOTP açık hesaplar hiç giriş
     * yapamazdı (fail-closed, ama teşhisi zor).
     */
    @Optional() @Inject(AdminTotpService) private readonly totp?: AdminTotpService,
  ) {}

  async onModuleInit(): Promise<void> {
    const email = this.config.get<string>('ADMIN_SEED_EMAIL');
    const password = this.config.get<string>('ADMIN_SEED_PASSWORD');
    if (!email || !password) return;
    if ((await this.count()) > 0) return;
    try {
      await this.create({
        email,
        password,
        name: this.config.get<string>('ADMIN_SEED_NAME') ?? 'Yönetici',
        username: this.config.get<string>('ADMIN_SEED_USERNAME'),
        role: 'owner',
      });
      this.logger.log(`İlk admin seed edildi: ${email}`);
    } catch (e) {
      this.logger.warn(`Admin seed atlandı: ${e instanceof Error ? e.message : e}`);
    }
  }

  private toPublic(u: AdminUser): PublicAdminUser {
    const { passwordHash: _p, totpSecretEnc: _t, ...rest } = u;
    return rest;
  }

  private async count(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(adminUsers);
    return row?.n ?? 0;
  }

  async list(): Promise<PublicAdminUser[]> {
    const rows = await this.db.select().from(adminUsers).orderBy(adminUsers.createdAt);
    return rows.map((r) => this.toPublic(r));
  }

  async create(input: {
    email: string;
    password: string;
    name: string;
    username?: string | null;
    role?: string;
  }): Promise<PublicAdminUser> {
    const email = input.email.toLowerCase().trim();
    const username = input.username?.trim() || null;
    // Kimlik uzunluğu: controller Zod'u ZATEN sınırlar, ama `onModuleInit` seed yolu (ADMIN_SEED_*)
    // controller'dan HİÇ geçmez. Sınırsız bırakılırsa `login` (MAX_IDENTIFIER_LEN üstünü DB'ye
    // inmeden reddeder) o hesabı SONSUZA DEK "geçersiz kimlik" sayar → kurtarma yolu yalnız DB.
    if (email.length > MAX_IDENTIFIER_LEN || (username && username.length > MAX_IDENTIFIER_LEN)) {
      throw new BadRequestException(
        `E-posta ve kullanıcı adı en fazla ${MAX_IDENTIFIER_LEN} karakter olabilir.`,
      );
    }
    if (input.password.length < 8) throw new BadRequestException('Parola en az 8 karakter olmalı.');
    if (username && username.includes('@')) {
      throw new BadRequestException("Kullanıcı adı '@' içeremez.");
    }
    // Çapraz-kolon çakışması: username başka bir hesabın e-postası olmasın (kimlik belirsizliği).
    if (username) {
      const [clash] = await this.db
        .select({ id: adminUsers.id })
        .from(adminUsers)
        .where(eq(adminUsers.email, username.toLowerCase()))
        .limit(1);
      if (clash) throw new ConflictException('Kullanıcı adı mevcut bir e-posta ile çakışıyor.');
    }
    const id = randomUUID();
    // scrypt artık asenkron (event loop bloklanmaz) → hash insert'ten ÖNCE hesaplanır.
    const passwordHash = await hashPassword(input.password);
    try {
      const [row] = await this.db
        .insert(adminUsers)
        .values({
          id,
          email,
          username,
          name: input.name.trim(),
          passwordHash,
          role: input.role === 'owner' ? 'owner' : 'admin',
        })
        .returning();
      await this.recordAuthEvent('admin_created', 'warning', row!.email, 'Yeni admin oluşturuldu', {
        userId: row!.id,
        role: row!.role,
      });
      return this.toPublic(row!);
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new ConflictException('E-posta veya kullanıcı adı zaten kayıtlı.');
      }
      throw e;
    }
  }

  /**
   * Kimlik (e-posta VEYA kullanıcı adı) + parola doğrular. Deterministik çözüm:
   * '@' içeren identifier yalnız e-postaya, diğerleri yalnız kullanıcı adına bakar.
   * Kimlik başına Redis rate-limit (brute-force). Başarısızsa null; sınır aşıldıysa 429.
   *
   * NOT: kimlik başına kova TEK BAŞINA yetmez — her istekte FARKLI identifier gönderen saldırgan
   * her seferinde taze bir kova açar (ve her deneme bir scrypt maliyeti doğurur). Bu boşluğu
   * controller'daki IP başına hız sınırı kapatır (bkz. AdminAuthController.login).
   */
  /**
   * Admin auth/hesap YAŞAM DÖNGÜSÜ denetim izi (denetim A4): en yetkili yüzey artık security_events'e
   * düşer (login/başarısız-login → brute-force /security + anomali/velocity'de görünür; create/disable/
   * reset/remove → kalıcı hesap izi). Best-effort: yazım hatası auth/CRUD akışını ASLA bozmaz.
   * security_events.type/severity serbest metin (migration gerekmez); sır/parola ASLA meta'ya girmez.
   */
  private async recordAuthEvent(
    type: string,
    severity: 'info' | 'warning' | 'critical',
    subject: string | null,
    detail: string,
    meta: Record<string, unknown> = {},
  ): Promise<void> {
    // Gövde `auth-events.ts`e taşındı — AdminTotpService de AYNI yazıcıyı kullanıyor
    // (servisler arası dairesel import olmasın). Davranış birebir aynı (best-effort).
    await recordAuthEvent(this.db, type, severity, subject, detail, meta);
  }

  /**
   * Kimlik + parola doğrular; TOTP açıksa oturum AÇMADAN ikinci adımı ister.
   *
   * Eski `verifyCredentials` bunun sarmalayıcısıdır (imza korundu). Ayrım şuradan doğdu:
   * "parola doğru" ile "giriş tamamlandı" ARTIK AYNI ŞEY DEĞİL — çerez yalnız `status:'ok'`
   * dönerse verilir.
   */
  async login(identifier: string, password: string): Promise<LoginOutcome | null> {
    const raw = identifier.trim();
    // Boş / aşırı uzun kimlik: DB sorgusu ve scrypt maliyeti ÖDENMEDEN reddedilir. Controller
    // zaten 200 karakterde 400 döner; bu guard servisi doğrudan çağıran yollar içindir. (Hesap
    // varlığı sızmaz: hiçbir gerçek kimlik bu aralığın dışında olamaz.)
    if (raw.length === 0 || raw.length > MAX_IDENTIFIER_LEN) return null;
    const isEmail = raw.includes('@');
    // Kimlik-dizesi kovası: BİLİNMEYEN kimlikler (not-found/enumeration yolu) için hız-limiti —
    // hesap varlığını timing ile sızdırmadan tanımadığımız identifier'ları da sınırlar.
    // Anahtar sha256 ÖZETİ ile kurulur (sabit uzunluk + PII Redis'e düz yazılmaz).
    const idKey = identifierBucketKey(raw.toLowerCase());

    // Bilinmeyen-kimlik kovası kilitliyse hemen reddet.
    if ((Number(await this.redis.get(idKey)) || 0) >= MAX_FAILS) {
      throw new HttpException(
        'Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const [user] = await this.db
      .select()
      .from(adminUsers)
      .where(isEmail ? eq(adminUsers.email, raw.toLowerCase()) : eq(adminUsers.username, raw))
      .limit(1);

    // Hesap çözüldüyse HESAP-KİMLİĞİ kovası YETKİLİdir: e-posta ve kullanıcı adı yolları tek
    // kovada birleşir (aksi hâlde iki ayrı kova = 2×MAX_FAILS brute-force bütçesi). Kilitliyse reddet.
    // Anahtar ELLE KURULMAZ: ACCOUNT_FAIL_KEY (yukarıda) parola girişi · TOTP adımı · TOTP
    // kapatma için TEK sözleşmedir. Ad alanı ileride değişirse burada inline bir kopya kalsaydı
    // TOTP yolu YENİ kovaya, giriş yolu ESKİ kovaya yazar ve dosyanın kendi uyardığı durum
    // sessizce doğardı: ayrı kova = parolayı ele geçirene her adım için TAZE deneme bütçesi.
    const acctKey = user ? ACCOUNT_FAIL_KEY(user.id) : null;
    if (acctKey && (Number(await this.redis.get(acctKey)) || 0) >= MAX_FAILS) {
      throw new HttpException(
        'Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const ok = user && !user.disabled && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      // Sabit-zaman: hesap yok/pasifse de aynı scrypt maliyeti ödenir (enumeration koruması).
      if (!user || user.disabled) await verifyPassword(password, await dummyHash());
      // Bilinen hesapta YANLIŞ parola → hesap-kimliği kovası (e-posta+kullanıcı adı tek kovada).
      // Bilinmeyen kimlik → kimlik-dizesi kovası (varlık sızdırmadan yine de hız-limitli).
      const failKey = acctKey ?? idKey;
      const failRes = await this.redis.multi().incr(failKey).expire(failKey, FAIL_WINDOW_SEC).exec();
      const failCount = Number(failRes?.[0]?.[1] ?? 0);
      // A4: başarısız giriş kalıcı güvenlik iznine düşer (Redis sayacı 15dk sonra silinir; brute-force
      // /security akışında + anomali/velocity'de görünür kalsın). Kilit eşiğinde severity=critical.
      await this.recordAuthEvent(
        'admin_login_failed',
        failCount >= MAX_FAILS ? 'critical' : 'warning',
        raw.slice(0, 200),
        failCount >= MAX_FAILS
          ? 'Başarısız admin girişi — hesap 15 dk kilitlendi (brute-force şüphesi)'
          : 'Başarısız admin girişi',
        { known: !!user, failCount },
      );
      return null;
    }

    // Parola DOĞRU → hash'i güncel maliyete YÜKSELT (D4, rehash-on-login). Düz parola YALNIZ
    // burada elimizdedir; scrypt parametreleri artık hash'in içinde saklandığı için eski
    // (N=2^14) kayıtlar doğrulanmaya devam eder ve kullanıcı fark etmeden yenilenir.
    //
    // Koşullu UPDATE (CAS: passwordHash hâlâ AYNI mı): araya bir `resetPassword` girdiyse
    // taze parolayı ESKİSİYLE geri yazmayız. `tokenVersion` BİLEREK artırılmaz — bu bir
    // bakım işlemidir, güvenlik olayı değil; artırmak her adminin oturumunu ilk girişte
    // düşürürdü. Best-effort: yazım hatası girişi ASLA bozmaz (yalnız loglanır, bir sonraki
    // girişte tekrar denenir).
    if (needsRehash(user.passwordHash)) {
      try {
        const upgraded = await hashPassword(password);
        await this.db
          .update(adminUsers)
          .set({ passwordHash: upgraded })
          .where(and(eq(adminUsers.id, user.id), eq(adminUsers.passwordHash, user.passwordHash)));
      } catch (e) {
        this.logger.warn(
          `Parola hash'i güncel maliyete yükseltilemedi (giriş etkilenmedi): ${
            e instanceof Error ? e.message : e
          }`,
        );
      }
    }

    // TOTP açıksa giriş burada BİTMEZ: ne kova temizlenir, ne lastLoginAt yazılır,
    // ne de 'admin_login' izi düşer — bunlar ancak ikinci faktör geçilince olur. (Kova temizliği
    // ikinci adıma ertelenmezse, parolayı ele geçiren biri her denemede lockout sayacını
    // sıfırlayıp 6 haneli kodu SINIRSIZ deneyebilirdi.)
    if (user.totpEnabled) {
      if (!this.totp) {
        // FAIL-CLOSED: doğrulayıcı yoksa TOTP açık hesap giriş YAPAMAZ (2FA'yı sessizce
        // atlamaktansa erişimi kesmek doğru taraftır).
        this.logger.error('TOTP açık hesap için doğrulayıcı servis yok — giriş reddedildi.');
        return null;
      }
      return { status: 'totp_required', sub: user.id };
    }

    await this.redis.del(idKey);
    if (acctKey) await this.redis.del(acctKey);
    return { status: 'ok', user: await this.finishLogin(user, false) };
  }

  /** Eski imza (TOTP'siz çağıranlar + testler): yalnız TAM başarıda kullanıcı döner. */
  async verifyCredentials(identifier: string, password: string): Promise<PublicAdminUser | null> {
    const res = await this.login(identifier, password);
    return res && res.status === 'ok' ? res.user : null;
  }

  /**
   * GİRİŞİN İKİNCİ ADIMI — TOTP kodu. `sub` yalnız birinci adımı (parola) GEÇMİŞ bir isteğin
   * taşıdığı kısa ömürlü imzalı beklet-token'ından gelir (bkz. apps/admin/app/login/pending.ts);
   * bu uç ADMIN_TOKEN arkasındadır ve panelden başka çağıranı yoktur.
   *
   * LOCKOUT: parola denemeleriyle AYNI hesap kovası (`authfail:id:<id>`) kullanılır — ayrı kova
   * açmak, parolayı bilen saldırgana 6 haneli kod için TAZE bir bütçe vermek olurdu. Böylece bir
   * hesaba 15 dakikada toplam MAX_FAILS deneme düşer (10⁶'lık uzayda brute-force imkânsız).
   */
  async verifyTotpLogin(sub: string, code: string): Promise<PublicAdminUser | null> {
    // Parola girişiyle AYNI kova — anahtar tek sözleşmeden (ACCOUNT_FAIL_KEY) türetilir.
    const acctKey = ACCOUNT_FAIL_KEY(sub);
    if ((Number(await this.redis.get(acctKey)) || 0) >= MAX_FAILS) {
      throw new HttpException(
        'Çok fazla başarısız deneme. 15 dakika sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const [user] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, sub)).limit(1);
    // Hesap yok/pasif/TOTP kapalı → bu uç hiç kullanılmamalıydı; sayacı artırmadan reddet
    // (beklet-token'ı imzalı olduğu için buraya normalde yalnız meşru akış düşer).
    if (!user || user.disabled || !user.totpEnabled) return null;

    const ok = this.totp ? await this.totp.checkCode(user, code) : false;
    if (!ok) {
      const failRes = await this.redis.multi().incr(acctKey).expire(acctKey, FAIL_WINDOW_SEC).exec();
      const failCount = Number(failRes?.[0]?.[1] ?? 0);
      await this.recordAuthEvent(
        'admin_totp_failed',
        failCount >= MAX_FAILS ? 'critical' : 'warning',
        user.email,
        failCount >= MAX_FAILS
          ? 'Geçersiz TOTP kodu — hesap 15 dk kilitlendi (2FA brute-force şüphesi)'
          : 'Geçersiz TOTP kodu',
        { userId: user.id, failCount },
      );
      return null;
    }
    await this.redis.del(acctKey);
    return this.finishLogin(user, true);
  }

  /** Tam başarılı girişin ortak kuyruğu: son giriş damgası + denetim izi. */
  private async finishLogin(user: AdminUser, twoFactor: boolean): Promise<PublicAdminUser> {
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(adminUsers.id, user.id));
    // A4: başarılı giriş de ize düşer (kim/ne zaman girdi — çoklu-admin sorumluluğu).
    await this.recordAuthEvent('admin_login', 'info', user.email, 'Admin girişi başarılı', {
      userId: user.id,
      role: user.role,
      twoFactor,
    });
    return this.toPublic(user);
  }

  /** Oturum geçerlilik kontrolü (middleware her istekte çağırır): var + aktif + tokenVersion eşleşiyor. */
  async validateSession(sub: string, ver: number): Promise<PublicAdminUser | null> {
    const [user] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, sub)).limit(1);
    if (!user || user.disabled || user.tokenVersion !== ver) return null;
    return this.toPublic(user);
  }

  /**
   * Pasifleştir/aktifleştir. Advisory-lock'lı transaction → son aktif admin yarışı imkânsız.
   * Pasifleştirmede tokenVersion +1 (mevcut oturum anında geçersizleşir).
   */
  async setDisabled(id: string, disabled: boolean): Promise<PublicAdminUser> {
    const result = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_users_lockout'))`);
      const [target] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
      if (!target) throw new NotFoundException('Admin bulunamadı.');
      if (disabled && !target.disabled) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(adminUsers)
          .where(eq(adminUsers.disabled, false));
        if (n <= 1) throw new BadRequestException('Son aktif admin pasifleştirilemez.');
      }
      const [row] = await tx
        .update(adminUsers)
        .set({
          disabled,
          updatedAt: sql`now()`,
          ...(disabled ? { tokenVersion: sql`${adminUsers.tokenVersion} + 1` } : {}),
        })
        .where(eq(adminUsers.id, id))
        .returning();
      return row!;
    });

    // Denetim izi COMMIT'ten SONRA yazılır (deferEffects deseni). İKİ sebep:
    //  1) ATOMİKLİK: tx geri alınırsa "Admin pasifleştirildi" olayı GERÇEKLEŞMEMİŞ bir değişiklik
    //     için kayda geçmez (olay ancak değişiklik kalıcı olduğunda yazılır).
    //  2) HAVUZ: tx bir bağlantı tutarken kök havuzdan ikinci bağlantı istenmez. Yazımı `tx`e
    //     almak da doğru DEĞİLDİ: best-effort yutma tx içinde çalışmaz — başarısız INSERT tx'i
    //     abort eder (25P02) ve yutma yalnız sebebi gizleyip commit'i anlaşılmaz biçimde düşürürdü.
    await this.recordAuthEvent(
      disabled ? 'admin_disabled' : 'admin_reactivated',
      'warning',
      result.email,
      disabled ? 'Admin pasifleştirildi (oturumlar iptal edildi)' : 'Admin yeniden aktifleştirildi',
      { userId: result.id },
    );
    return this.toPublic(result);
  }

  /**
   * Oturum SONLANDIRMA (denetim P3): tokenVersion +1 → o ana kadar üretilmiş TÜM imzalı oturum
   * token'ları (çalınmış olanlar dahil) middleware validate'inde ver-uyuşmazlığı görüp geçersizleşir.
   * Best-effort: bulunamayan id no-op (logout akışı yine tamamlanır). Tüm cihazlarda çıkış yapar.
   */
  async logout(id: string): Promise<{ ok: true }> {
    await this.db
      .update(adminUsers)
      .set({ tokenVersion: sql`${adminUsers.tokenVersion} + 1`, updatedAt: sql`now()` })
      .where(eq(adminUsers.id, id));
    return { ok: true };
  }

  /** Parola sıfırla + tokenVersion +1 (eski oturumlar geçersizleşir). */
  async resetPassword(id: string, password: string): Promise<PublicAdminUser> {
    if (password.length < 8) throw new BadRequestException('Parola en az 8 karakter olmalı.');
    const passwordHash = await hashPassword(password); // asenkron scrypt (event loop bloklanmaz)
    const [row] = await this.db
      .update(adminUsers)
      .set({
        passwordHash,
        tokenVersion: sql`${adminUsers.tokenVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(adminUsers.id, id))
      .returning();
    if (!row) throw new NotFoundException('Admin bulunamadı.');
    await this.recordAuthEvent(
      'admin_password_reset',
      'warning',
      row.email,
      'Admin parolası sıfırlandı (oturumlar iptal edildi)',
      { userId: row.id },
    );
    return this.toPublic(row);
  }

  /** Sil. Advisory-lock'lı → son aktif admin silinemez (yarışsız). */
  async remove(id: string): Promise<{ ok: true }> {
    const removed = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('admin_users_lockout'))`);
      const [target] = await tx.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
      if (!target) throw new NotFoundException('Admin bulunamadı.');
      if (!target.disabled) {
        const [{ n }] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(adminUsers)
          .where(eq(adminUsers.disabled, false));
        if (n <= 1) throw new BadRequestException('Son aktif admin silinemez.');
      }
      await tx.delete(adminUsers).where(eq(adminUsers.id, id));
      return { email: target.email, userId: target.id };
    });

    // COMMIT'ten SONRA (setDisabled ile aynı gerekçe: atomiklik + havuz).
    await this.recordAuthEvent('admin_removed', 'warning', removed.email, 'Admin silindi', {
      userId: removed.userId,
    });
    return { ok: true as const };
  }
}
