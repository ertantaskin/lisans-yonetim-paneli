import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { deployments, type Deployment } from '../db/schema/deployments';

/** Geçerli dağıtım hedefleri = deploy.sh argümanları (whitelist — enjeksiyon yok). */
export const DEPLOY_TARGETS = ['api', 'admin', 'api admin'] as const;
export type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/** Log gövdesi DB'de sınırlı tutulur (runner deploy.sh çıktısının kuyruğunu gönderir). */
const MAX_LOG_CHARS = 20000;

/**
 * DeploymentsService — panelden tetiklenen prod dağıtımlarının kaydı (§16). Panel YALNIZ
 * "istek" yazar; VPS host'undaki runner (cron) bunu görür, `deploy.sh`'ı çalıştırır ve
 * sonucu geri yazar. API konteynerine Docker soketi verilmez — bu ayrım güvenlik gereği.
 */
@Injectable()
export class DeploymentsService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Yeni dağıtım isteği kaydet (status='pending'). Aynı anda YALNIZ bir aktif (pending/running)
   * dağıtım olabilir → aksi halde 409 (kuyruk yığılması + eşzamanlı deploy engellenir).
   */
  async request(target: string, requestedBy: string): Promise<Deployment> {
    if (!DEPLOY_TARGETS.includes(target as DeployTarget)) {
      throw new BadRequestException(`Geçersiz hedef. İzinli: ${DEPLOY_TARGETS.join(', ')}`);
    }
    // SELECT-sonra-INSERT arası yarış (form çift-tık / eşzamanlı iki POST) iki 'pending' üretip
    // aynı kodun ardışık iki redeploy'una yol açardı. Tüm istek yolunu tek transaction'da
    // pg_advisory_xact_lock ile serileştir → "aynı anda tek aktif dağıtım" gerçekten garanti
    // (migration YOK; global tek-kaynak kilidi yeterli, dağıtım nadir bir owner işlemi).
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('deployments_request'))`);
      const active = await tx
        .select({ id: deployments.id })
        .from(deployments)
        .where(inArray(deployments.status, ['pending', 'running']))
        .limit(1);
      if (active.length > 0) {
        throw new ConflictException(
          'Zaten bekleyen veya çalışan bir dağıtım var. Bitmesini bekleyin.',
        );
      }
      const [row] = await tx
        .insert(deployments)
        .values({ target, requestedBy: requestedBy || 'panel:admin' })
        .returning();
      return row!;
    });
  }

  /** Dağıtım geçmişi (en yeni önce). */
  async list(limit = 50): Promise<Deployment[]> {
    return this.db
      .select()
      .from(deployments)
      .orderBy(desc(deployments.createdAt))
      .limit(Math.min(Math.max(limit, 1), 200));
  }

  /**
   * Runner: en eski PENDING isteği ATOMİK olarak claim eder (pending→running). `FOR UPDATE
   * SKIP LOCKED` ile iki runner örneği aynı isteği çalıştıramaz. Bekleyen yoksa null.
   */
  async claimNext(): Promise<Deployment | null> {
    // Zombi 'running' temizliği: runner çöküp finish yazamazsa satır kalıcı 'running' kalır
    // ve request() guard'ı yeni dağıtımı SONSUZA DEK engeller. 30dk'dan eski 'running' →
    // 'failed' (self-heal, runner'dan bağımsız). deploy.sh çok daha kısa sürer; 30dk emniyetli.
    await this.db
      .update(deployments)
      .set({
        status: 'failed',
        error: 'Zaman aşımı — dağıtım runner sonucu 30dk içinde bildirmedi.',
        finishedAt: new Date(),
      })
      .where(
        and(
          eq(deployments.status, 'running'),
          lt(deployments.startedAt, sql`now() - interval '30 minutes'`),
        ),
      );

    const [row] = await this.db
      .update(deployments)
      .set({ status: 'running', startedAt: new Date() })
      .where(
        eq(
          deployments.id,
          sql`(select id from deployments where status = 'pending' order by created_at asc limit 1 for update skip locked)`,
        ),
      )
      .returning();
    return row ?? null;
  }

  /** Runner: dağıtım sonucunu yaz (success|failed) + log/sha/hata. */
  async finish(
    id: string,
    status: 'success' | 'failed',
    opts: { gitSha?: string; log?: string; error?: string },
  ): Promise<Deployment | null> {
    if (status !== 'success' && status !== 'failed') {
      throw new BadRequestException("status yalnız 'success' veya 'failed' olabilir.");
    }
    const [row] = await this.db
      .update(deployments)
      .set({
        status,
        gitSha: opts.gitSha?.slice(0, 80) ?? null,
        log: opts.log ? opts.log.slice(-MAX_LOG_CHARS) : null,
        error: opts.error?.slice(0, 4000) ?? null,
        finishedAt: new Date(),
      })
      .where(eq(deployments.id, id))
      .returning();
    return row ?? null;
  }
}
