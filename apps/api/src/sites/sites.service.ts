import { createHash, randomBytes } from 'node:crypto';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { SiteType } from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { sites, type Site } from '../db/schema';

export interface CreatedSite {
  id: string;
  domain: string;
  /** Yalnız oluşturmada bir kez döner; sonra saklanmaz (hash tutulur). */
  apiKey: string;
  /** Yalnız oluşturmada bir kez döner (şifreli saklanır). */
  hmacSecret: string;
}

/** API anahtarı hash'i — sabit sha256 (DB'de düz anahtar durmaz). */
export function hashApiKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

@Injectable()
export class SitesService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  /** Yeni site (tenant) oluşturur; anahtar + secret'i bir kez döndürür. */
  async create(input: {
    domain: string;
    type?: SiteType;
    senderEmail?: string;
  }): Promise<CreatedSite> {
    const apiKey = `jl_${randomBytes(24).toString('hex')}`;
    const hmacSecret = randomBytes(32).toString('hex');

    const [row] = await this.db
      .insert(sites)
      .values({
        domain: input.domain,
        type: input.type ?? 'woocommerce',
        apiKeyHash: hashApiKey(apiKey),
        hmacSecretEnc: this.crypto.encrypt(hmacSecret),
        senderEmail: input.senderEmail ?? null,
        status: 'active',
      })
      .returning();

    return { id: row!.id, domain: row!.domain, apiKey, hmacSecret };
  }

  async list(): Promise<Array<Omit<Site, 'hmacSecretEnc' | 'apiKeyHash'>>> {
    const rows = await this.db.select().from(sites);
    return rows.map(({ hmacSecretEnc: _s, apiKeyHash: _a, ...rest }) => rest);
  }

  /** HMAC guard için: api anahtarı hash'inden aktif siteyi + çözülmüş secret'i getirir. */
  async findForAuth(apiKey: string): Promise<{ site: Site; hmacSecret: string } | null> {
    const [site] = await this.db
      .select()
      .from(sites)
      .where(eq(sites.apiKeyHash, hashApiKey(apiKey)))
      .limit(1);

    if (!site || site.status !== 'active') return null;
    return { site, hmacSecret: this.crypto.decrypt(site.hmacSecretEnc) };
  }

  async getById(id: string): Promise<Site> {
    const [site] = await this.db.select().from(sites).where(eq(sites.id, id)).limit(1);
    if (!site) throw new NotFoundException('Site bulunamadı');
    return site;
  }
}
