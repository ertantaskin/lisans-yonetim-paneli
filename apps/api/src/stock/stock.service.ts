import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  AccountPayloadSchema,
  serializeAccountPayload,
  type AccountPayloadSchema as AccountPayloadSchemaT,
} from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { CryptoService } from '../crypto/crypto.service';
import { auditLog, licenseItems, orderLines, type NewLicenseItem, type Product } from '../db/schema';
import { ProductsService } from '../products/products.service';
import { FulfillmentService } from '../orders/fulfillment.service';

export interface ImportRejection {
  index: number;
  reason: string;
}

export interface ImportResult {
  requested: number;
  imported: number;
  duplicates: number;
  /** Doğrulamadan geçemeyen satırlar (account şema / keyFormat) — sessizce yutulmaz. */
  rejected: number;
  rejections: ImportRejection[];
  autoCompleted: number;
}

export type ImportItem = { payload: string | Record<string, unknown>; expiresAt?: string };

/** "Onayla ve Dağıt" önizleme (§13): girilecek stok bekleyen talebi ne kadar karşılar. */
export interface StockPreview {
  /** İstenen giriş adedi (birim). */
  count: number;
  /** Bu ürün için bekleyen (pending/partial) satır sayısı. */
  pendingLines: number;
  /** Bekleyen toplam birim = Σ(qty - fulfilled_qty). */
  pendingUnits: number;
  /** Bu giriş kaç bekleyen birimi tamamlar = min(count, pendingUnits). */
  wouldFill: number;
  /** Bekleyen karşılandıktan sonra artan stok = max(count - pendingUnits, 0). */
  remainingAfter: number;
}

@Injectable()
export class StockService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly products: ProductsService,
    private readonly fulfillment: FulfillmentService,
  ) {}

  /**
   * Stok import (§12). Her payload şifrelenir (envelope), içerik hash'iyle mükerrer
   * engellenir (UNIQUE payload_hash → onConflictDoNothing). Çok kullanımlıkta (multi)
   * her key ürünün max_uses kapasitesiyle girer.
   */
  async import(productId: string, items: ImportItem[]): Promise<ImportResult> {
    const product = await this.products.getById(productId);

    // Çok kullanımlık (MAK) ürün maxUses>1 ZORUNLU — aksi halde her key kapasite=1'e
    // düşer ve MAK anahtarı tek satışta tükenir (sessiz misconfig'i erken yakala).
    if (product.usageMode === 'multi' && (product.maxUses == null || product.maxUses <= 1)) {
      throw new BadRequestException(
        "usageMode='multi' ürün için max_uses > 1 tanımlı olmalı — import reddedildi.",
      );
    }
    const maxUses = product.usageMode === 'multi' ? product.maxUses! : 1;

    // Hesap ürünü için alan şemasını çöz (import doğrulaması + kanonik serialize).
    const accountSchema = this.resolveAccountSchema(product);
    const keyRegex = this.compileKeyFormat(product);

    const rejections: ImportRejection[] = [];
    const values: NewLicenseItem[] = [];

    items.forEach((it, index) => {
      let plaintext: string;
      try {
        plaintext = this.normalizePayload(it.payload, product, accountSchema, keyRegex);
      } catch (err) {
        rejections.push({ index, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      // id'yi uygulamada üretiyoruz ki payload'ı bu satıra AAD ile bağlayabilelim
      // (satır-taşıma engeli, §8). insert bu id ile yapılır.
      const id = randomUUID();
      values.push({
        id,
        productId,
        payloadEnc: this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
        payloadHash: this.crypto.payloadHash(plaintext),
        payloadSuffixHash: this.crypto.payloadSuffixHash(plaintext),
        maxUses,
        expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
        status: 'available',
      });
    });

    if (values.length === 0) {
      return {
        requested: items.length,
        imported: 0,
        duplicates: 0,
        rejected: rejections.length,
        rejections,
        autoCompleted: 0,
      };
    }

    const inserted = await this.db
      .insert(licenseItems)
      .values(values)
      .onConflictDoNothing({ target: licenseItems.payloadHash })
      .returning({ id: licenseItems.id });

    // duplicates = doğrulamayı geçip DB'de mükerrer (payload_hash) çıkanlar.
    const duplicates = values.length - inserted.length;

    // Sebepli stok değişikliği audit'e düşer (§12).
    await this.db.insert(auditLog).values({
      action: 'import',
      actor: 'panel:admin',
      targetType: 'product',
      targetId: productId,
      meta: { imported: inserted.length, duplicates, rejected: rejections.length },
    });

    // Stok girişinde tamamlama motorunu tetikle (§5 partial-auto FIFO).
    let autoCompleted = 0;
    if (inserted.length > 0) {
      autoCompleted = await this.fulfillment.autoCompleteProduct(productId);
    }

    return {
      requested: items.length,
      imported: inserted.length,
      duplicates,
      rejected: rejections.length,
      rejections,
      autoCompleted,
    };
  }

  /** Ürün account ise payloadSchema'yı doğrulayıp döner; değilse null. */
  private resolveAccountSchema(product: Product): AccountPayloadSchemaT | null {
    if (product.kind !== 'account') return null;
    const parsed = AccountPayloadSchema.safeParse(product.payloadSchema);
    if (!parsed.success) {
      throw new BadRequestException(
        "kind='account' ürünün payload_schema'sı geçersiz — import reddedildi.",
      );
    }
    return parsed.data;
  }

  /** keyFormat regex'ini derler (bozuk regex → import reddedilir, sessiz kabul yok). */
  private compileKeyFormat(product: Product): RegExp | null {
    if (!product.keyFormat) return null;
    try {
      return new RegExp(product.keyFormat);
    } catch {
      throw new BadRequestException(`Ürün key_format regex'i geçersiz: ${product.keyFormat}`);
    }
  }

  /**
   * Import satırını depolanacak KANONİK düz metne çevirir + doğrular.
   * - account: girdi (nesne veya JSON string) şemaya göre doğrulanıp kanonik JSON olur.
   * - key/code/custom: düz string; keyFormat varsa regex'e uyması şart.
   * @throws satır geçersizse (çağıran rejections'a düşürür)
   */
  private normalizePayload(
    payload: string | Record<string, unknown>,
    product: Product,
    accountSchema: AccountPayloadSchemaT | null,
    keyRegex: RegExp | null,
  ): string {
    if (accountSchema) {
      // account: nesne bekle; string gelirse JSON parse et.
      let input: unknown = payload;
      if (typeof payload === 'string') {
        try {
          input = JSON.parse(payload);
        } catch {
          throw new Error('Hesap payload geçerli JSON değil');
        }
      }
      return serializeAccountPayload(accountSchema, input);
    }

    // account olmayan: düz string bekle.
    if (typeof payload !== 'string') {
      throw new Error('Bu ürün tipi için payload düz string olmalı');
    }
    if (keyRegex && !keyRegex.test(payload)) {
      throw new Error('Payload key_format desenine uymuyor');
    }
    return payload;
  }

  /**
   * "Onayla ve Dağıt" önizleme (§13): bu ürüne N birim stok girilirse bekleyen
   * (pending/partial) talebin ne kadarının kapanacağını gösterir. Salt-okunur;
   * import/atama mantığını TETİKLEMEZ — yalnız mevcut açık satırları toplar.
   */
  async preview(productId: string, count: number): Promise<StockPreview> {
    // Ürün gerçekten var mı? (yoksa 404 — sessiz sıfır göstermeyiz)
    await this.products.getById(productId);

    const [row] = await this.db
      .select({
        // Açık satır sayısı.
        lines: sql<number>`count(*)`,
        // Bekleyen birim: qty - fulfilled_qty (negatif olamaz, coalesce güvenliği).
        units: sql<number>`coalesce(sum(greatest(${orderLines.qty} - ${orderLines.fulfilledQty}, 0)), 0)`,
      })
      .from(orderLines)
      .where(
        and(
          eq(orderLines.productId, productId),
          inArray(orderLines.status, ['pending', 'partial']),
        ),
      );

    const pendingLines = Number(row?.lines ?? 0);
    const pendingUnits = Number(row?.units ?? 0);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const wouldFill = Math.min(safeCount, pendingUnits);
    const remainingAfter = Math.max(safeCount - pendingUnits, 0);

    return { count: safeCount, pendingLines, pendingUnits, wouldFill, remainingAfter };
  }

  /** Ürün başına anlık 'available' stok (single: satır sayısı; multi: kalan kapasite). */
  async availableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(and(eq(licenseItems.productId, productId), eq(licenseItems.status, 'available')));
    return Number(row?.count ?? 0);
  }
}
