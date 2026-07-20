import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, ne, or, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { adminUsers, type AdminUser } from '../db/schema';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password';

/** Parola hash'i olmadan dışa dönük admin görünümü. */
export type PublicAdminUser = Omit<AdminUser, 'passwordHash'>;

@Injectable()
export class AdminUsersService implements OnModuleInit {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly config: ConfigService,
  ) {}

  /** Bootstrap: tablo boşsa ve ADMIN_SEED_* verilmişse ilk admini oluşturur. */
  async onModuleInit(): Promise<void> {
    const email = this.config.get<string>('ADMIN_SEED_EMAIL');
    const password = this.config.get<string>('ADMIN_SEED_PASSWORD');
    if (!email || !password) return;
    const count = await this.count();
    if (count > 0) return;
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
    const { passwordHash: _p, ...rest } = u;
    return rest;
  }

  private async count(): Promise<number> {
    const [row] = await this.db.select({ n: sql<number>`count(*)::int` }).from(adminUsers);
    return row?.n ?? 0;
  }

  private async enabledCount(): Promise<number> {
    const [row] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(adminUsers)
      .where(eq(adminUsers.disabled, false));
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
    if (input.password.length < 8) {
      throw new BadRequestException('Parola en az 8 karakter olmalı.');
    }
    const id = randomUUID();
    try {
      const [row] = await this.db
        .insert(adminUsers)
        .values({
          id,
          email,
          username,
          name: input.name.trim(),
          passwordHash: hashPassword(input.password),
          role: input.role === 'owner' ? 'owner' : 'admin',
        })
        .returning();
      return this.toPublic(row!);
    } catch (e) {
      if (String(e).toLowerCase().includes('unique') || String(e).includes('23505')) {
        throw new ConflictException('E-posta veya kullanıcı adı zaten kayıtlı.');
      }
      throw e;
    }
  }

  /** Kimlik (e-posta veya kullanıcı adı) + parola doğrular; başarısızsa null. */
  async verifyCredentials(identifier: string, password: string): Promise<PublicAdminUser | null> {
    const idLower = identifier.toLowerCase().trim();
    const [user] = await this.db
      .select()
      .from(adminUsers)
      .where(or(eq(adminUsers.email, idLower), eq(adminUsers.username, identifier.trim())))
      .limit(1);

    if (!user || user.disabled) {
      verifyPassword(password, DUMMY_HASH); // sabit-zaman: yine de hash maliyeti öde
      return null;
    }
    if (!verifyPassword(password, user.passwordHash)) return null;

    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(adminUsers.id, user.id));
    return this.toPublic(user);
  }

  async setDisabled(id: string, disabled: boolean): Promise<PublicAdminUser> {
    if (disabled) {
      // Son aktif admini pasifleştirme → kilitlenme koruması.
      const [target] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
      if (!target) throw new NotFoundException('Admin bulunamadı.');
      if (!target.disabled && (await this.enabledCount()) <= 1) {
        throw new BadRequestException('Son aktif admin pasifleştirilemez.');
      }
    }
    const [row] = await this.db
      .update(adminUsers)
      .set({ disabled, updatedAt: sql`now()` })
      .where(eq(adminUsers.id, id))
      .returning();
    if (!row) throw new NotFoundException('Admin bulunamadı.');
    return this.toPublic(row);
  }

  async resetPassword(id: string, password: string): Promise<PublicAdminUser> {
    if (password.length < 8) throw new BadRequestException('Parola en az 8 karakter olmalı.');
    const [row] = await this.db
      .update(adminUsers)
      .set({ passwordHash: hashPassword(password), updatedAt: sql`now()` })
      .where(eq(adminUsers.id, id))
      .returning();
    if (!row) throw new NotFoundException('Admin bulunamadı.');
    return this.toPublic(row);
  }

  async remove(id: string): Promise<{ ok: true }> {
    const [target] = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    if (!target) throw new NotFoundException('Admin bulunamadı.');
    // Son aktif admini silme koruması.
    if (!target.disabled && (await this.enabledCount()) <= 1) {
      throw new BadRequestException('Son aktif admin silinemez.');
    }
    await this.db.delete(adminUsers).where(and(eq(adminUsers.id, id), ne(adminUsers.id, '')));
    return { ok: true };
  }
}
