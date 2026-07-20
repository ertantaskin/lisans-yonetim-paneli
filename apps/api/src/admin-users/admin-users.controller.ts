import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { AdminUsersService } from './admin-users.service';

const LoginBody = z.object({ identifier: z.string().min(1), password: z.string().min(1) });
type LoginBody = z.infer<typeof LoginBody>;

const ValidateBody = z.object({ sub: z.string().uuid(), ver: z.number().int().nonnegative() });
type ValidateBody = z.infer<typeof ValidateBody>;

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
  constructor(private readonly users: AdminUsersService) {}

  @Post('login')
  async login(@Body(new ZodBody(LoginBody)) body: LoginBody) {
    const user = await this.users.verifyCredentials(body.identifier, body.password);
    if (!user) throw new UnauthorizedException('Geçersiz kimlik veya parola');
    return { user };
  }

  /** Oturum iptali kontrolü (middleware): admin var + aktif + tokenVersion eşleşiyor mu. */
  @Post('validate')
  async validate(@Body(new ZodBody(ValidateBody)) body: ValidateBody) {
    const user = await this.users.validateSession(body.sub, body.ver);
    return { valid: user !== null, user: user ?? undefined };
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

  @Post()
  create(@Body(new ZodBody(CreateBody)) body: CreateBody) {
    return this.users.create(body);
  }

  @Patch(':id')
  patch(@Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodBody(PatchBody)) body: PatchBody) {
    return this.users.setDisabled(id, body.disabled);
  }

  @Post(':id/password')
  resetPassword(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(PasswordBody)) body: PasswordBody,
  ) {
    return this.users.resetPassword(id, body.password);
  }

  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.users.remove(id);
  }
}
