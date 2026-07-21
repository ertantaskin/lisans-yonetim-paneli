import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import type { ConfigService } from '@nestjs/config';
import {
  HMAC_HEADERS,
  buildSignaturePayload,
  type ProductKind,
  type UsageMode,
} from '@jetlisans/shared';
import { CryptoService } from '../../src/crypto/crypto.service';
import { SitesService } from '../../src/sites/sites.service';
import * as schema from '../../src/db/schema';

/**
 * ENTEGRASYON TEST ALTYAPISI (test/race/assignment.race.test.ts deseninde).
 *
 * - Nest ayağa KALDIRMAZ; servis/fonksiyonları doğrudan çağırır ya da servisi elle
 *   new'ler (gerçek db + gerçek CryptoService ile).
 * - Her test dosyası kendi `randomUUID().slice(0,8)` tag'iyle seed eder; afterAll'da
 *   SADECE kendi tag'iyle eklediklerini siler (`cleanupByTag`). Global truncate YOK.
 * - signHmac(): hmac.guard.ts'in beklediği imzayı birebir üretir (site-facing v1 uçları).
 */

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/** Tüm seed satırlarına gömülen ayırt edici işaret (izolasyon + temizlik). */
export const tagPrefix = (tag: string): string => `it-${tag}`;

/**
 * Gerçek Postgres bağlantısı + drizzle. DATABASE_URL zorunlu (yarış testi deseni).
 * Dönen `end` afterAll'da çağrılır; `client` alt-seviye postgres istemcisi.
 */
export function makeDb(): { db: Db; client: postgres.Sql; end: () => Promise<void> } {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL tanımlı değil — entegrasyon testleri gerçek PostgreSQL gerektirir.',
    );
  }
  const client = postgres(url, { max: 10 });
  const db = drizzle(client, { schema });
  return { db, client, end: () => client.end() };
}

/**
 * Test için CryptoService — Nest DI olmadan elle kurulur. MASTER_KEY env'den okunur;
 * yoksa bu koşuya özel rastgele 32-byte anahtar üretilir ve process.env'e yazılır
 * (aynı koşuda başka bir bileşen aynı anahtarı görsün diye). Şifreleme/çözme + payloadHash
 * bir koşu içinde tutarlıdır.
 */
export function makeCrypto(): CryptoService {
  let b64 = process.env.MASTER_KEY;
  if (!b64) {
    b64 = randomBytes(32).toString('base64');
    process.env.MASTER_KEY = b64;
  }
  const fakeConfig = {
    get: (key: string): string | undefined => (key === 'MASTER_KEY' ? b64 : undefined),
  } as unknown as ConfigService;
  const crypto = new CryptoService(fakeConfig);
  crypto.onModuleInit();
  return crypto;
}

// ---------------------------------------------------------------------------
// Seed factory'leri — hepsi tag alır, üretilen id'leri döndürür.
// ---------------------------------------------------------------------------

export interface CreatedProduct {
  id: string;
  sku: string;
}

/**
 * Ürün oluşturur (products tablosu doğrudan insert). kind/usageMode/maxUses/
 * warrantyDays/lowStockThreshold serbest; sku tag ile benzersizleştirilir.
 */
export async function createProduct(
  db: Db,
  opts: {
    tag: string;
    kind?: ProductKind;
    usageMode?: UsageMode;
    maxUses?: number;
    validityDays?: number;
    warrantyDays?: number;
    lowStockThreshold?: number;
    onExpiry?: 'hide' | 'keep';
    fulfillmentPolicy?: 'partial-auto' | 'partial-approval' | 'all-or-nothing';
    payloadSchema?: unknown;
    name?: string;
  },
): Promise<CreatedProduct> {
  const sku = `${tagPrefix(opts.tag)}-prod-${randomUUID().slice(0, 8)}`;
  const [row] = await db
    .insert(schema.products)
    .values({
      sku,
      name: opts.name ?? `IT ürün ${opts.tag}`,
      kind: opts.kind ?? 'key',
      usageMode: opts.usageMode ?? 'single',
      maxUses: opts.maxUses ?? null,
      validityDays: opts.validityDays ?? null,
      warrantyDays: opts.warrantyDays ?? null,
      lowStockThreshold: opts.lowStockThreshold ?? null,
      onExpiry: opts.onExpiry ?? 'hide',
      fulfillmentPolicy: opts.fulfillmentPolicy ?? 'partial-auto',
      payloadSchema: (opts.payloadSchema ?? null) as never,
    })
    .returning({ id: schema.products.id, sku: schema.products.sku });
  return { id: row!.id, sku: row!.sku };
}

export interface CreatedSite {
  id: string;
  domain: string;
  /** Yalnız oluşturmada döner (imzalama için gerekli). */
  apiKey: string;
  /** Yalnız oluşturmada döner (imzalama için gerekli). */
  hmacSecret: string;
}

/**
 * Site oluşturur. KARAR: gerçek SitesService ile oluşturuyoruz — hmac_secret_enc'i
 * doğru AAD (`site_secret:<id>`) ile şifreler ve api_key/hmac_secret'i bir kez döndürür;
 * böylece guard'ın findForAuth'u (aynı AAD ile decrypt) ve signHmac testte birebir çalışır.
 * Elle insert+encrypt AAD'yi elle kurmayı gerektirir ve kopya-kaçış riski taşır.
 */
export async function createSite(
  db: Db,
  crypto: CryptoService,
  opts: { tag: string; sandbox?: boolean; salesDailyQuota?: number | null },
): Promise<CreatedSite> {
  const sites = new SitesService(db as never, crypto);
  const domain = `${tagPrefix(opts.tag)}-${randomUUID().slice(0, 8)}.example.test`;
  const created = await sites.create({
    domain,
    sandbox: opts.sandbox ?? false,
    salesDailyQuota: opts.salesDailyQuota ?? null,
  });
  return {
    id: created.id,
    domain: created.domain,
    apiKey: created.apiKey,
    hmacSecret: created.hmacSecret,
  };
}

/**
 * `count` adet license_item ekler. Payload gerçek envelope ile (v2, license_item AAD)
 * şifrelenir → reveal/teslimat yolu birebir çalışır. id'ler uygulamada üretilir (AAD bağlama).
 * payload_hash tag+index ile benzersiz (mükerrer-key UNIQUE ihlali olmaz).
 */
export async function insertLicenseItems(
  db: Db,
  crypto: CryptoService,
  opts: {
    productId: string;
    count: number;
    tag: string;
    status?: (typeof schema.licenseItems.$inferInsert)['status'];
    maxUses?: number;
    expiresAt?: Date | null;
    payloadPrefix?: string;
  },
): Promise<string[]> {
  const rows = Array.from({ length: opts.count }, (_, i) => {
    const id = randomUUID();
    const plaintext = `${opts.payloadPrefix ?? 'KEY'}-${opts.tag}-${i}-${id.slice(0, 8)}`;
    return {
      id,
      productId: opts.productId,
      payloadEnc: crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
      payloadHash: crypto.payloadHash(plaintext),
      payloadSuffixHash: crypto.payloadSuffixHash(plaintext),
      status: opts.status ?? ('available' as const),
      maxUses: opts.maxUses ?? 1,
      expiresAt: opts.expiresAt ?? null,
    } satisfies typeof schema.licenseItems.$inferInsert;
  });
  const inserted = await db
    .insert(schema.licenseItems)
    .values(rows)
    .returning({ id: schema.licenseItems.id });
  return inserted.map((r) => r.id);
}

export interface CreatedOrder {
  orderId: string;
  lineId: string;
  remoteOrderId: string;
  remoteLineId: string;
}

/**
 * Tek satırlı sipariş oluşturur (orders + order_lines). idempotency_key OrdersService
 * ile aynı format: `${siteId}:${remoteOrderId}`. Atama YAPMAZ — çağıran akışına bırakır.
 */
export async function createOrderWithLine(
  db: Db,
  opts: {
    siteId: string;
    productId: string;
    qty: number;
    tag: string;
    customerEmail?: string;
    remoteOrderId?: string;
    remoteLineId?: string;
    status?: (typeof schema.orders.$inferInsert)['status'];
  },
): Promise<CreatedOrder> {
  const remoteOrderId = opts.remoteOrderId ?? `${tagPrefix(opts.tag)}-ord-${randomUUID().slice(0, 8)}`;
  const remoteLineId = opts.remoteLineId ?? `${tagPrefix(opts.tag)}-line-1`;
  const [order] = await db
    .insert(schema.orders)
    .values({
      siteId: opts.siteId,
      remoteOrderId,
      customerEmail: opts.customerEmail ?? `${opts.tag}@example.test`,
      status: opts.status ?? 'pending',
      idempotencyKey: `${opts.siteId}:${remoteOrderId}`,
    })
    .returning({ id: schema.orders.id });
  const [line] = await db
    .insert(schema.orderLines)
    .values({
      orderId: order!.id,
      productId: opts.productId,
      remoteLineId,
      qty: opts.qty,
    })
    .returning({ id: schema.orderLines.id });
  return { orderId: order!.id, lineId: line!.id, remoteOrderId, remoteLineId };
}

// ---------------------------------------------------------------------------
// Temizlik — tag ile izole silme (FK-güvenli sıra).
// ---------------------------------------------------------------------------

/**
 * Bu tag'le eklenen HER şeyi siler. Sıra FK kısıtlarına saygılıdır:
 *   assignments(restrict→license_items) → orders(cascade→lines+assignments)
 *   → license_items → products → sites.
 * sku `it-<tag>-...`, domain `it-<tag>-...` prefiksinden LIKE ile bulunur.
 */
export async function cleanupByTag(db: Db, tag: string): Promise<void> {
  const like = `${tagPrefix(tag)}-%`;
  // 0) site_product_mappings — products'a RESTRICT FK'li; ürün/site SİLİNMEDEN ÖNCE temizlenmeli.
  //    Tag'li ürün VEYA tag'li site referansı olan tüm eşlemeler. Eskiden her test bunu afterAll'da
  //    ELLE yapıyordu (createdSiteIds izleyip mapping siliyordu); burada merkezileştirildi → yeni
  //    testler mapping temizliğini atlarsa FK ihlali almaz (elle yapanlar için no-op: zaten silinmiş).
  await db.execute(sql`
    DELETE FROM site_product_mappings
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${like})
       OR site_id IN (SELECT id FROM sites WHERE domain LIKE ${like})
  `);
  // 1) Tag'li ürünlerin license_item'larına bağlı atamalar (restrict FK) — önce bunlar.
  await db.execute(sql`
    DELETE FROM assignments
    WHERE license_item_id IN (
      SELECT li.id FROM license_items li
      JOIN products p ON li.product_id = p.id
      WHERE p.sku LIKE ${like}
    )
  `);
  // 2) Tag'li sitelerin siparişleri — cascade ile order_lines + kalan assignments düşer.
  await db.execute(sql`
    DELETE FROM orders
    WHERE site_id IN (SELECT id FROM sites WHERE domain LIKE ${like})
  `);
  // 3) Artık atamasız kalan license_item'lar.
  await db.execute(sql`
    DELETE FROM license_items
    WHERE product_id IN (SELECT id FROM products WHERE sku LIKE ${like})
  `);
  // 4) Ürünler + siteler.
  await db.execute(sql`DELETE FROM products WHERE sku LIKE ${like}`);
  await db.execute(sql`DELETE FROM sites WHERE domain LIKE ${like}`);
}

// ---------------------------------------------------------------------------
// HMAC imzalama — hmac.guard.ts'in tersi (site-facing v1 istekleri).
// ---------------------------------------------------------------------------

export interface SignedRequest {
  headers: Record<string, string>;
  /** Guard `req.rawBody` üzerinden gövde hash'i hesaplar — imzayla AYNI byte'lar. */
  rawBody: Buffer;
  body: string;
}

/**
 * Guard'ın beklediği imzalı istek başlıklarını üretir:
 *
 *   bodyHash   = sha256(rawBody)
 *   payload    = buildSignaturePayload({ method, path, timestamp, nonce, bodyHash })
 *   X-Signature= HMAC-SHA256(secret, payload)   (hex)
 *
 * @param path Guard `req.url`'i kullanır (query/fragment dâhil); canonicalizePath
 *   imza içinde uygulanır — buraya ham url'i (örn. `/v1/orders`) geç.
 * @param body string ise aynen; obje ise JSON.stringify (rawBody = utf8).
 */
export function signHmac(opts: {
  method: string;
  path: string;
  apiKey: string;
  secret: string;
  body?: unknown;
  timestamp?: number;
  nonce?: string;
}): SignedRequest {
  const bodyStr =
    opts.body === undefined
      ? ''
      : typeof opts.body === 'string'
        ? opts.body
        : JSON.stringify(opts.body);
  const rawBody = Buffer.from(bodyStr, 'utf8');
  const bodySha256Hex = createHash('sha256').update(rawBody).digest('hex');
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? randomUUID();
  const payload = buildSignaturePayload({
    method: opts.method,
    path: opts.path,
    timestamp,
    nonce,
    bodySha256Hex,
  });
  const signature = createHmac('sha256', opts.secret).update(payload).digest('hex');
  return {
    headers: {
      [HMAC_HEADERS.apiKey]: opts.apiKey,
      [HMAC_HEADERS.timestamp]: timestamp,
      [HMAC_HEADERS.nonce]: nonce,
      [HMAC_HEADERS.signature]: signature,
    },
    rawBody,
    body: bodyStr,
  };
}
