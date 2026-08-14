import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import { CryptoService } from '../crypto/crypto.service';
import { adminUsers, type AdminUser } from '../db/schema';
import { verifyPassword } from '../auth/password';
import {
  buildOtpauthUri,
  generateTotpSecret,
  totpReplayTtlSec,
  verifyTotpOnce,
} from '../auth/totp';
import { recordAuthEvent } from './auth-events';

/**
 * AdminTotpService — admin girişinde iki faktörlü doğrulama (§8 üzerine).
 *
 * Sır AES-256-GCM envelope ile ŞİFRELİ saklanır (`admin_users.totp_secret_enc`); AAD kayıt
 * kimliğine bağlanır (`admin_user:<id>`) → bir satırın ciphertext'i başka bir admin satırına
 * KOPYALANAMAZ (payload'lardaki v2 bağlamanın aynısı). Düz metin sır yalnız kurulum yanıtında,
 * bir kez, kullanıcının kendi ekranında görünür; loga/audit'e/hata mesajına ASLA yazılmaz.
 *
 * Kurulum iki adımlıdır (sır yaz → ilk kodu doğrula): bayrak (`totp_enabled`) ancak kullanıcı
 * çalışan bir kod ürettiğinde açılır. Aksi hâlde saat kayması ya da yanlış taranmış bir sır
 * hesabı KALICI kilitlerdi ve kurtarma için başka bir owner gerekirdi.
 */
@Injectable()
export class AdminTotpService {
  private readonly logger = new Logger(AdminTotpService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly crypto: CryptoService,
  ) {}

  /** Envelope AAD — sır satır kimliğine bağlanır (satır-taşıma saldırısı imkânsız). */
  private aad(userId: string): string {
    return `admin_user:${userId}`;
  }

  private async load(id: string): Promise<AdminUser> {
    const [user] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    if (!user) throw new NotFoundException('Admin bulunamadı.');
    return user;
  }

  /**
   * REPLAY DEFTERİ — kullanılan adım numarasını Redis'te tek-yazar (`SET NX`) ile sahiplenir.
   *
   * NEDEN REDİS (kullanıcı kaydı yerine): (a) şema DONMUŞ — "son kullanılan adım" için kolon
   * eklemek migration gerektirirdi (bu iş migration üretmiyor); (b) `SET NX` atomiktir, çok
   * replikalı/eşzamanlı iki istek arasında yarış bırakmaz; (c) auth sayaçları (`authfail:*`)
   * ve HMAC nonce'ları zaten Redis'te — replay koruması aynı yerde, aynı dille yaşar; (d) veri
   * doğası gereği GEÇİCİ (90 sn), kalıcı kolonda tutmak gereksiz yazma yükü olurdu.
   *
   * FAIL-CLOSED: Redis erişilemezse doğrulama REDDEDİLİR (hız sınırı fail-open'dır ama bu bir
   * KORUMA değil KİMLİK DOĞRULAMA adımıdır — HmacGuard nonce'u ile aynı ilke). Aksi hâlde
   * Redis'i düşürebilen biri replay'i serbest bırakırdı.
   */
  private claimStep(userId: string): (step: number) => Promise<boolean> {
    return async (step: number) => {
      const key = `totp:used:${userId}:${step}`;
      try {
        const res = await this.redis.set(key, '1', 'EX', totpReplayTtlSec(), 'NX');
        return res === 'OK';
      } catch (err) {
        this.logger.error(`TOTP replay defteri yazılamadı — fail-closed: ${String(err)}`);
        throw new ServiceUnavailableException(
          'Doğrulama şu an yapılamıyor. Kısa süre sonra tekrar deneyin.',
        );
      }
    };
  }

  /**
   * Yetki: kullanıcının KENDİSİ ya da owner. `actor` Next'in ilettiği `admin:<e-posta>`,
   * `role` ise doğrulanmış oturum rolü. Auth KAPALIYKEN (rol '' + actor 'panel:admin')
   * panel zaten tek-operatör/herkese açıktır → izin verilir (OwnerGuard ile aynı karar tablosu).
   */
  private assertSelfOrOwner(target: AdminUser, actor: string, role: string): void {
    if (role === 'owner') return;
    if (role === '' && actor === 'panel:admin') return;
    const actorEmail = actor.startsWith('admin:') ? actor.slice('admin:'.length).toLowerCase() : '';
    if (actorEmail && actorEmail === target.email.toLowerCase()) return;
    throw new ForbiddenException('Bu işlem yalnız hesabın sahibine ya da owner rolüne açıktır.');
  }

  /**
   * Durum bilgisi (ekranlar için) — sır ya da şifreli sır ASLA dönmez.
   * Yetki: kendisi ya da owner (başka bir yöneticinin ikinci faktör durumu kimseyi ilgilendirmez;
   * owner zaten toplu görünümü `/v1/admin/users` listesinden alır).
   */
  async status(
    id: string,
    actor = 'panel:admin',
    role = '',
  ): Promise<{ id: string; email: string; totpEnabled: boolean; pendingSetup: boolean }> {
    const user = await this.load(id);
    this.assertSelfOrOwner(user, actor, role);
    return {
      id: user.id,
      email: user.email,
      totpEnabled: user.totpEnabled,
      // Sır yazılmış ama bayrak açılmamış = yarıda kalmış kurulum (kullanıcıya "devam et" denir).
      pendingSetup: !user.totpEnabled && user.totpSecretEnc !== null,
    };
  }

  /**
   * Kurulumu BAŞLAT: yeni sır üret → şifreli yaz → düz metin sırrı + otpauth URI'sini BİR KEZ döndür.
   * Bayrak açılmaz; kullanıcı `confirm` ile ilk kodu doğrulayana kadar giriş akışı DEĞİŞMEZ.
   */
  async beginSetup(
    id: string,
    actor: string,
    role: string,
    issuer = 'Lisans Paneli',
  ): Promise<{ secret: string; otpauthUri: string; account: string }> {
    const user = await this.load(id);
    this.assertSelfOrOwner(user, actor, role);
    if (user.totpEnabled) {
      // Açıkken yeniden kurulum, çalışan bir faktörü sessizce değiştirmek demektir → önce kapat.
      throw new ConflictException('İki faktörlü doğrulama zaten açık — önce kapatın.');
    }
    const secret = generateTotpSecret();
    await this.db
      .update(adminUsers)
      .set({ totpSecretEnc: this.crypto.encrypt(secret, this.aad(id)), updatedAt: sql`now()` })
      .where(eq(adminUsers.id, id));
    await recordAuthEvent(
      this.db,
      'admin_totp_setup_started',
      'info',
      user.email,
      'TOTP kurulumu başlatıldı (henüz etkin değil)',
      { userId: user.id, actor },
    );
    return {
      secret,
      account: user.email,
      otpauthUri: buildOtpauthUri({ secret, account: user.email, issuer }),
    };
  }

  /** Kurulumu ONAYLA: ilk kod doğrulanırsa bayrak açılır (bu andan sonra giriş 2 adımlıdır). */
  async confirmSetup(id: string, code: string, actor: string, role: string): Promise<{ totpEnabled: true }> {
    const user = await this.load(id);
    this.assertSelfOrOwner(user, actor, role);
    if (user.totpEnabled) throw new ConflictException('İki faktörlü doğrulama zaten açık.');
    if (!user.totpSecretEnc) throw new BadRequestException('Önce kurulumu başlatın.');
    const ok = await this.checkCode(user, code);
    if (!ok) throw new BadRequestException('Kod doğrulanamadı. Telefonunuzun saatini kontrol edin.');
    await this.db
      .update(adminUsers)
      .set({ totpEnabled: true, updatedAt: sql`now()` })
      .where(eq(adminUsers.id, id));
    await recordAuthEvent(
      this.db,
      'admin_totp_enabled',
      'warning',
      user.email,
      'İki faktörlü doğrulama AÇILDI',
      { userId: user.id, actor },
    );
    return { totpEnabled: true };
  }

  /**
   * KAPAT. Kullanıcının kendisi için parola + GEÇERLİ KOD şarttır (çalınmış bir oturum çerezi
   * tek başına ikinci faktörü söküp atamasın); owner ise doğrudan kapatabilir (kurtarma yetkisi
   * zaten onda ve parola sıfırlama deseniyle simetrik).
   */
  async disable(
    id: string,
    input: { password?: string; code?: string },
    actor: string,
    role: string,
  ): Promise<{ totpEnabled: false }> {
    const user = await this.load(id);
    this.assertSelfOrOwner(user, actor, role);
    const byOwner = role === 'owner' || (role === '' && actor === 'panel:admin');
    if (!byOwner) {
      const passOk = input.password
        ? await verifyPassword(input.password, user.passwordHash)
        : false;
      const codeOk = passOk && input.code ? await this.checkCode(user, input.code) : false;
      // Tek mesaj: hangisinin yanlış olduğu söylenmez (parola oraklı üretmeyelim).
      if (!passOk || !codeOk) throw new UnauthorizedException('Parola veya kod hatalı.');
    }
    await this.clearSecret(id, false);
    await recordAuthEvent(
      this.db,
      'admin_totp_disabled',
      'warning',
      user.email,
      byOwner
        ? 'İki faktörlü doğrulama owner tarafından KAPATILDI'
        : 'İki faktörlü doğrulama kullanıcı tarafından kapatıldı',
      { userId: user.id, actor, byOwner },
    );
    return { totpEnabled: false };
  }

  /**
   * KURTARMA (owner): cihazını kaybeden kullanıcının TOTP'sini sıfırlar ve `token_version`'ı
   * artırır → o hesabın AÇIK TÜM oturumları anında düşer (parola sıfırlama deseninin aynısı).
   * Böylece cihazı ele geçiren biri hâlâ oturumdaysa da dışarı atılır.
   *
   * YEDEK KOD (backup codes) BİLİNÇLİ OLARAK YOK: ayrı bir kasa (hash'li, tek kullanımlık liste),
   * indirme/yazdırma UX'i ve kendi replay/iptal kuralları gerektirir; owner sıfırlaması bu panel
   * için (az sayıda operatör, owner her zaman erişilebilir) yeterli kurtarma yoludur.
   */
  async reset(id: string, actor: string): Promise<{ totpEnabled: false }> {
    const user = await this.load(id);
    await this.clearSecret(id, true);
    await recordAuthEvent(
      this.db,
      'admin_totp_reset',
      'warning',
      user.email,
      'TOTP owner tarafından sıfırlandı (oturumlar iptal edildi)',
      { userId: user.id, actor },
    );
    return { totpEnabled: false };
  }

  /** Sır + bayrağı temizler; `bumpTokenVersion` ise açık oturumları da düşürür. */
  private async clearSecret(id: string, bumpTokenVersion: boolean): Promise<void> {
    await this.db
      .update(adminUsers)
      .set({
        totpSecretEnc: null,
        totpEnabled: false,
        updatedAt: sql`now()`,
        ...(bumpTokenVersion ? { tokenVersion: sql`${adminUsers.tokenVersion} + 1` } : {}),
      })
      .where(eq(adminUsers.id, id));
  }

  /**
   * Kodu doğrular (±1 adım + TEK KULLANIM). Sır çözülemezse (MASTER_KEY sapması, bozuk kayıt)
   * FAIL-CLOSED: false döner ve loglanır — çözülemeyen bir sır "doğrulama atlansın" demek değildir.
   * ServiceUnavailable (Redis fail-closed) yukarı SIZDIRILIR; sessizce "yanlış kod" demek,
   * operatörü kod/telefon aramaya iterdi.
   */
  async checkCode(user: AdminUser, code: string): Promise<boolean> {
    if (!user.totpSecretEnc) return false;
    let secret: string;
    try {
      secret = this.crypto.decrypt(user.totpSecretEnc, this.aad(user.id));
    } catch (err) {
      this.logger.error(`TOTP sırrı çözülemedi (userId=${user.id}) — fail-closed: ${String(err)}`);
      return false;
    }
    const step = await verifyTotpOnce(secret, code, this.claimStep(user.id));
    return step !== null;
  }
}
