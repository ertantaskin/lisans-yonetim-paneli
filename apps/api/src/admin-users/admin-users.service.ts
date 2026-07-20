import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { eq, sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { DB, type Database } from '../db/db.module';
import { REDIS } from '../redis/redis.module';
import { adminUsers, type AdminUser } from '../db/schema';
import { hashPassword, verifyPassword, DUMMY_HASH } from '../auth/password';

/** Parola hash'i olmadan dışa dönük admin görünümü. */
export type PublicAdminUser = Omit<AdminUser, 'passwordHash'>;

const MAX_FAILS = 10; // kimlik başına başarısız deneme sınırı
const FAIL_WINDOW_SEC = 900; // 15 dk

@Injectable()
export class AdminUsersService implements OnModuleInit {
  private readonly logger = new Logger(AdminUsersService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    private readonly config: ConfigService,
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
    const { passwordHash: _p, ...rest } = u;
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

  /**
   * Kimlik (e-posta VEYA kullanıcı adı) + parola doğrular. Deterministik çözüm:
   * '@' içeren identifier yalnız e-postaya, diğerleri yalnız kullanıcı adına bakar.
   * Kimlik başına Redis rate-limit (brute-force). Başarısızsa null; sınır aşıldıysa 429.
   */
  async verifyCredentials(identifier: string, password: string): Promise<PublicAdminUser | null> {
    const raw = identifier.trim();
    const isEmail = raw.includes('@');
    const rlKey = `authfail:${raw.toLowerCase()}`;

    const fails = Number(await this.redis.get(rlKey)) || 0;
    if (fails >= MAX_FAILS) {
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

    const ok = user && !user.disabled && verifyPassword(password, user.passwordHash);
    if (!ok) {
      if (!user || user.disabled) verifyPassword(password, DUMMY_HASH); // sabit-zaman
      await this.redis.multi().incr(rlKey).expire(rlKey, FAIL_WINDOW_SEC).exec();
      return null;
    }

    await this.redis.del(rlKey);
    await this.db
      .update(adminUsers)
      .set({ lastLoginAt: sql`now()` })
      .where(eq(adminUsers.id, user.id));
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
    return this.db.transaction(async (tx) => {
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
      return this.toPublic(row!);
    });
  }

  /** Parola sıfırla + tokenVersion +1 (eski oturumlar geçersizleşir). */
  async resetPassword(id: string, password: string): Promise<PublicAdminUser> {
    if (password.length < 8) throw new BadRequestException('Parola en az 8 karakter olmalı.');
    const [row] = await this.db
      .update(adminUsers)
      .set({
        passwordHash: hashPassword(password),
        tokenVersion: sql`${adminUsers.tokenVersion} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(adminUsers.id, id))
      .returning();
    if (!row) throw new NotFoundException('Admin bulunamadı.');
    return this.toPublic(row);
  }

  /** Sil. Advisory-lock'lı → son aktif admin silinemez (yarışsız). */
  async remove(id: string): Promise<{ ok: true }> {
    return this.db.transaction(async (tx) => {
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
      return { ok: true as const };
    });
  }
}
