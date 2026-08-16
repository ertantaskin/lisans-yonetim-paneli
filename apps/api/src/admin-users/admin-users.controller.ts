import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Ip,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { OwnerGuard } from '../auth/owner.guard';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminRole } from '../auth/admin-role.decorator';
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import {
  AdminUsersService,
  LOGIN_FAIL_WINDOW_SEC,
  MAX_IDENTIFIER_LEN,
  type LoginOutcome,
  type PublicAdminUser,
} from './admin-users.service';
import { AdminTotpService } from './totp.service';

/**
 * Kimlik üst sınırı: sınırsız identifier hem gövde limitine kadar (1 MB) şişebiliyor hem de
 * gereksiz iş üretiyordu. 200 karakter her gerçek e-posta/kullanıcı adı için fazlasıyla yeterli.
 * Sabit servisten gelir (MAX_IDENTIFIER_LEN) — giriş ile OLUŞTURMA sınırı ayrışırsa girilemeyen
 * hesap doğar (bkz. CreateBody ve AdminUsersService.create).
 */
const LoginBody = z.object({
  identifier: z.string().min(1).max(MAX_IDENTIFIER_LEN),
  password: z.string().min(1),
});
type LoginBody = z.infer<typeof LoginBody>;

/**
 * IP başına Redis sabit-pencere hız sınırı (§8). Bu uç ADMIN_TOKEN arkasında olsa da Next
 * `/api/login` route handler'ı onu KİMLİK DOĞRULAMASIZ istekler adına çağırır; kimlik başına
 * lockout ise her istekte farklı identifier gönderilerek atlanabiliyordu. Her deneme bir scrypt
 * maliyeti doğurduğundan bu, ucuz isteklerle teslimat yolunu yavaşlatmaya da açık bir kapıydı.
 *
 * NOT (topoloji): panelden gelen girişlerde @Ip() Next konteynerinin IP'sidir (tek Caddy hop) →
 * bu kova pratikte panel-geneli bir TAVAN'dır; gerçek istemci-IP kovası Next `/api/login`
 * tarafında kurulur. Bu yüzden sınır, meşru çoklu-admin girişini kırmayacak kadar geniş ama
 * scrypt selini kesecek kadar dar seçildi (30/dk ≈ toplam ~3 sn CPU/dk).
 */
const LOGIN_RL_WINDOW_SEC = 60;
const LOGIN_RL_MAX = 30;

/**
 * Girişin ikinci adımı. `sub` panelin kısa ömürlü İMZALI beklet-token'ından gelir (parola
 * doğrulanmadan üretilmez); `code` 6 haneli TOTP. Kod uzunluğu üstten sınırlı — boşluk/tire
 * temizliği doğrulayıcıda yapılır.
 */
const LoginTotpBody = z.object({
  sub: z.string().uuid(),
  code: z.string().min(1).max(24),
});
type LoginTotpBody = z.infer<typeof LoginTotpBody>;

const ValidateBody = z.object({ sub: z.string().uuid(), ver: z.number().int().nonnegative() });
type ValidateBody = z.infer<typeof ValidateBody>;

const LogoutBody = z.object({ sub: z.string().uuid() });
type LogoutBody = z.infer<typeof LogoutBody>;

/**
 * Yeni admin. E-posta/kullanıcı adı üst sınırı GİRİŞ ile AYNI sabitten gelir: `login`
 * MAX_IDENTIFIER_LEN üstündeki kimliği DB'ye hiç inmeden reddeder, yani sınırsız oluşturma
 * "açılabilen ama ASLA giriş yapamayan" hesap üretirdi (hata jenerik olduğu için sebebi de
 * görünmezdi). `name` de sınırlanır — gövde limitine kadar şişebilen serbest metin.
 */
const CreateBody = z.object({
  email: z.string().email().max(MAX_IDENTIFIER_LEN),
  username: z.string().min(3).max(MAX_IDENTIFIER_LEN).optional(),
  name: z.string().min(1).max(200),
  password: z.string().min(8),
  role: z.enum(['owner', 'admin']).optional(),
});
type CreateBody = z.infer<typeof CreateBody>;

const PatchBody = z.object({ disabled: z.boolean() });
type PatchBody = z.infer<typeof PatchBody>;

const PasswordBody = z.object({ password: z.string().min(8) });
type PasswordBody = z.infer<typeof PasswordBody>;

const TotpCodeBody = z.object({ code: z.string().min(1).max(24) });
type TotpCodeBody = z.infer<typeof TotpCodeBody>;

/** Kendi TOTP'sini kapatan kullanıcı parola + geçerli kod verir; owner için ikisi de opsiyonel. */
const TotpDisableBody = z.object({
  password: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(24).optional(),
});
type TotpDisableBody = z.infer<typeof TotpDisableBody>;

/** Admin kimlik doğrulama — Next admin sunucusu ADMIN_TOKEN ile çağırır. */
@Controller('admin/auth')
@UseGuards(AdminGuard)
export class AdminAuthController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post('login')
  async login(
    @Body(new ZodBody(LoginBody)) body: LoginBody,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!(await this.rateLimit.hit(`admin:login:${ip}`, LOGIN_RL_MAX, LOGIN_RL_WINDOW_SEC))) {
      // Fastify reply başlığı, istisna filtresi 429'u render etmeden ÖNCE korunur (orders deseni).
      reply.header('retry-after', String(LOGIN_RL_WINDOW_SEC));
      throw new HttpException(
        'Çok fazla giriş denemesi. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    let outcome: LoginOutcome | null;
    try {
      outcome = await this.users.login(body.identifier, body.password);
    } catch (e) {
      // Kimlik başına lockout 429'u da Retry-After taşısın (kova pencere sonunda sıfırlanır).
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        reply.header('retry-after', String(LOGIN_FAIL_WINDOW_SEC));
      }
      throw e;
    }
    if (!outcome) throw new UnauthorizedException('Geçersiz kimlik veya parola');
    // TOTP açık: kullanıcı bilgisi DÖNMEZ, yalnız ikinci adımın hedefi (id). Panel bununla
    // kısa ömürlü imzalı beklet-çerezi kurar; OTURUM çerezi ancak /login/totp başarılı olunca.
    if (outcome.status === 'totp_required') return { totpRequired: true as const, sub: outcome.sub };
    return { user: outcome.user };
  }

  /**
   * Girişin İKİNCİ ADIMI (TOTP). Başarısızlıkta 401 ve GENERİK mesaj — "kod yanlış" ile
   * "böyle bir bekleyen giriş yok" ayırt edilmez (enumeration/oracle yok).
   */
  @Post('login/totp')
  async loginTotp(
    @Body(new ZodBody(LoginTotpBody)) body: LoginTotpBody,
    @Ip() ip: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    // Kod denemeleri de parola denemeleriyle AYNI IP kovasını tüketir (ucuz istek seli
    // ikinci adımdan da geçmesin).
    if (!(await this.rateLimit.hit(`admin:login:${ip}`, LOGIN_RL_MAX, LOGIN_RL_WINDOW_SEC))) {
      reply.header('retry-after', String(LOGIN_RL_WINDOW_SEC));
      throw new HttpException(
        'Çok fazla giriş denemesi. Kısa süre sonra tekrar deneyin.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    let user: PublicAdminUser | null;
    try {
      user = await this.users.verifyTotpLogin(body.sub, body.code);
    } catch (e) {
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        reply.header('retry-after', String(LOGIN_FAIL_WINDOW_SEC));
      }
      throw e;
    }
    if (!user) throw new UnauthorizedException('Doğrulama kodu geçersiz.');
    return { user };
  }

  /** Oturum iptali kontrolü (middleware): admin var + aktif + tokenVersion eşleşiyor mu. */
  @Post('validate')
  async validate(@Body(new ZodBody(ValidateBody)) body: ValidateBody) {
    const user = await this.users.validateSession(body.sub, body.ver);
    return { valid: user !== null, user: user ?? undefined };
  }

  /**
   * Oturum SONLANDIRMA (denetim P3): logout'ta admin'in tokenVersion'ı +1 → çalınmış/kopyalanmış
   * token dahil o ana kadarki TÜM oturum token'ları anında geçersizleşir. Next /api/logout route'u
   * cookie'yi silmeden ÖNCE best-effort çağırır (cookie silme = yalnız o tarayıcı; bu = tüm cihazlar).
   */
  @Post('logout')
  async logout(@Body(new ZodBody(LogoutBody)) body: LogoutBody) {
    return this.users.logout(body.sub);
  }
}

/** Admin yönetimi (listele/ekle/pasifleştir/parola/sil). ADMIN_TOKEN gerektirir. */
@Controller('admin/users')
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(
    private readonly users: AdminUsersService,
    private readonly totp: AdminTotpService,
  ) {}

  /**
   * OWNER-ONLY — aynı controller'daki create/patch/password/delete/totp-reset zaten owner-only;
   * `list` tek istisnaydı. Sır dönmez (e-posta, kullanıcı adı, rol, disabled, lastLoginAt) ve
   * tek çağıranı `/admins` sayfası ZATEN owner-gated → bugün sömürülebilir değil. Yine de
   * operatör kadrosunun tam listesi (kim owner, kim pasif, kim ne zaman girdi) hedef seçmeye
   * yarar; guard tutarlılığı savunma-derinliğidir (bir Next kapısının unutulması yükselmesin).
   */
  @UseGuards(OwnerGuard)
  @Get()
  list() {
    return this.users.list();
  }

  // ── İki faktörlü doğrulama (TOTP) ────────────────────────────────────────
  // Yetki: kurulum/onay/kapatma "kullanıcının KENDİSİ ya da owner" (servis içinde
  // `assertSelfOrOwner` — actor + doğrulanmış rol başlığından); SIFIRLAMA yalnız owner
  // (OwnerGuard, admin CRUD ile aynı kapı).

  @Get(':id/totp')
  totpStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.totp.status(id, actor, role);
  }

  /** Kurulumu başlat — sır + otpauth URI'si BİR KEZ döner (bayrak henüz açılmaz). */
  @Post(':id/totp/setup')
  totpSetup(
    @Param('id', new ParseUUIDPipe()) id: string,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.totp.beginSetup(id, actor, role);
  }

  /** İlk kodu doğrula → TOTP açılır (bu andan sonra giriş iki adımlıdır). */
  @Post(':id/totp/confirm')
  totpConfirm(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(TotpCodeBody)) body: TotpCodeBody,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.totp.confirmSetup(id, body.code, actor, role);
  }

  /** Kapat — kendisi için parola + geçerli kod; owner doğrudan. */
  @Post(':id/totp/disable')
  totpDisable(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(TotpDisableBody)) body: TotpDisableBody,
    @AdminActor() actor: string,
    @AdminRole() role: string,
  ) {
    return this.totp.disable(id, body, actor, role);
  }

  /** KURTARMA (owner): cihaz kaybında TOTP'yi sıfırlar + açık oturumları düşürür. */
  @Post(':id/totp/reset')
  @UseGuards(OwnerGuard)
  totpReset(@Param('id', new ParseUUIDPipe()) id: string, @AdminActor() actor: string) {
    return this.totp.reset(id, actor);
  }

  // OwnerGuard (denetim H1/P7 savunma-derinliği): admin oluşturma/pasifleştirme/parola/silme
  // yalnız owner'a açıktır — Next isOwner() kontrolüne EK olarak API katmanında da zorlanır.
  @Post()
  @UseGuards(OwnerGuard)
  create(@Body(new ZodBody(CreateBody)) body: CreateBody) {
    return this.users.create(body);
  }

  @Patch(':id')
  @UseGuards(OwnerGuard)
  patch(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodBody(PatchBody)) body: PatchBody) {
    return this.users.setDisabled(id, body.disabled);
  }

  @Post(':id/password')
  @UseGuards(OwnerGuard)
  resetPassword(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(PasswordBody)) body: PasswordBody,
  ) {
    return this.users.resetPassword(id, body.password);
  }

  @Delete(':id')
  @UseGuards(OwnerGuard)
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.remove(id);
  }
}
