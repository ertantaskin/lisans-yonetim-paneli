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
import { RateLimitService } from '../common/rate-limit.service';
import { ZodBody } from '../common/zod-validation.pipe';
import {
  AdminUsersService,
  LOGIN_FAIL_WINDOW_SEC,
  type PublicAdminUser,
} from './admin-users.service';

/**
 * Kimlik üst sınırı: sınırsız identifier hem gövde limitine kadar (1 MB) şişebiliyor hem de
 * gereksiz iş üretiyordu. 200 karakter her gerçek e-posta/kullanıcı adı için fazlasıyla yeterli.
 */
const LoginBody = z.object({
  identifier: z.string().min(1).max(200),
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

const ValidateBody = z.object({ sub: z.string().uuid(), ver: z.number().int().nonnegative() });
type ValidateBody = z.infer<typeof ValidateBody>;

const LogoutBody = z.object({ sub: z.string().uuid() });
type LogoutBody = z.infer<typeof LogoutBody>;

const CreateBody = z.object({
  email: z.string().email(),
  username: z.string().min(3).optional(),
  name: z.string().min(1),
  password: z.string().min(8),
  role: z.enum(['owner', 'admin']).optional(),
});
type CreateBody = z.infer<typeof CreateBody>;

const PatchBody = z.object({ disabled: z.boolean() });
type PatchBody = z.infer<typeof PatchBody>;

const PasswordBody = z.object({ password: z.string().min(8) });
type PasswordBody = z.infer<typeof PasswordBody>;

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

    let user: PublicAdminUser | null;
    try {
      user = await this.users.verifyCredentials(body.identifier, body.password);
    } catch (e) {
      // Kimlik başına lockout 429'u da Retry-After taşısın (kova pencere sonunda sıfırlanır).
      if (e instanceof HttpException && e.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        reply.header('retry-after', String(LOGIN_FAIL_WINDOW_SEC));
      }
      throw e;
    }
    if (!user) throw new UnauthorizedException('Geçersiz kimlik veya parola');
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
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list() {
    return this.users.list();
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
