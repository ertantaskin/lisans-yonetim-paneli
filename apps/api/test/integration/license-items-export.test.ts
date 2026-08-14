import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '../../src/db/schema';
import { FulfillmentService } from '../../src/orders/fulfillment.service';
import { ProductsService } from '../../src/products/products.service';
import {
  LICENSE_COUNT_CAP,
  LICENSE_EXPORT_LIMIT,
  StockService,
} from '../../src/stock/stock.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createProduct,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — lisans envanteri DIŞA AKTARMA ucu (`exportLicenseItems`).
 *
 * NEDEN BU DOSYA VAR: dışa aktarma, panelin en hassas verisini (düz lisans anahtarı +
 * müşteri e-postası) DOSYAYA çıkarır. Üç kural sessizce bozulabilir ve bozulduğunda kimse
 * fark etmez — bu yüzden üçü de burada kilitlenir:
 *
 *  (a) ROL KAPISI (denetim A1/M1): düz metin YALNIZ owner'a. Owner-olmayan 'admin' MASKELİ
 *      almalı. Bu kural bir kez daha kırılırsa dosya panel dışına düz anahtarla çıkar.
 *  (b) "reveal audit'e düşer" (§8 DEĞİŞMEZ kural): düz-metin dışa aktarımı TEK bir denetim
 *      kaydı bırakmalı — kaç kalem, hangi süzgeç, hangi aktör. Anahtarın KENDİSİ meta'ya
 *      ASLA yazılmamalı. Maskeli dosya reveal DEĞİLDİR → kayıt yazılmaz (liste ucuyla simetri).
 *  (c) SESSİZ KIRPMA YASAK: sunucu tavanı aşıldığında yanıt `truncated` ile dürüstçe söylemeli
 *      ve gerçek `total` korunmalı; aksi halde operatör eksik bir dosyayla mutabakat yapar.
 */

const tag = randomUUID().slice(0, 8);
const TAG_UP = tag.toUpperCase();
const OWNER_ACTOR = `panel:it-export-owner-${tag}`;
const ADMIN_ACTOR = `panel:it-export-admin-${tag}`;
const TRUNC_ACTOR = `panel:it-export-trunc-${tag}`;

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let stock: StockService;
let productId: string;
let quarantinedId: string;

const mailFake = { enqueueDelivery: async () => {} } as never;
const webhookFake = { emit: async () => {} } as never;
const configFake = { get: () => undefined } as never;
const autocompleteQueueFake = { add: async () => ({ id: 'fake' }) } as never;

/** Bu koşuya ait 'reveal' audit satırları (meta ile birlikte). */
async function auditRows(actor: string): Promise<{ meta: Record<string, unknown> }[]> {
  const rows = await db
    .select({ meta: schema.auditLog.meta })
    .from(schema.auditLog)
    .where(eq(schema.auditLog.actor, actor));
  return rows as { meta: Record<string, unknown> }[];
}

describe('lisans envanteri dışa aktarma — rol kapısı, reveal audit, dürüst kırpma', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    const products = new ProductsService(db as never);
    const fulfillment = new FulfillmentService(db as never, products, mailFake, webhookFake);
    stock = new StockService(
      db as never,
      crypto,
      products,
      fulfillment,
      configFake,
      autocompleteQueueFake,
    );

    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    productId = product.id;
    // 3 stok kalemi + 1 karantina kalemi (süzgeç geçişini de doğrulayabilmek için).
    await insertLicenseItems(db, crypto, {
      productId,
      count: 3,
      tag,
      payloadPrefix: `EXPORT${TAG_UP}`,
    });
    const [dead] = await insertLicenseItems(db, crypto, {
      productId,
      count: 1,
      tag,
      payloadPrefix: `EXPDEAD${TAG_UP}`,
    });
    quarantinedId = dead!;
    await db
      .update(schema.licenseItems)
      .set({ status: 'quarantined' })
      .where(eq(schema.licenseItems.id, quarantinedId));
  });

  afterAll(async () => {
    await db.execute(
      sql`DELETE FROM audit_log WHERE actor IN (${OWNER_ACTOR}, ${ADMIN_ACTOR}, ${TRUNC_ACTOR})`,
    );
    await cleanupByTag(db, tag);
    await end();
  });

  it('(a) OWNER (reveal=true): düz metin döner + TEK reveal audit kaydı (op=export) yazılır', async () => {
    const res = await stock.exportLicenseItems({ productId }, OWNER_ACTOR, true);

    expect(res.rows).toHaveLength(4);
    expect(res.total).toBe(4);
    expect(res.truncated).toBe(false);
    expect(res.limit).toBe(LICENSE_EXPORT_LIMIT);
    expect(res.masked).toBe(false);
    // Sayım TAVANLI yapılır (perf); tavanın altındaki toplam TAM doğrudur ve bunu
    // `totalCapped=false` ile söyler. İstemci "4 kayıt" yazabilir, "4+" değil.
    expect(res.totalCapped).toBe(false);
    expect(res.countCap).toBe(LICENSE_COUNT_CAP);
    // Düz metin: payload tag'i görünür, maske gövdesi YOK.
    for (const r of res.rows) {
      expect(r.value).toContain(tag);
      expect(r.value).not.toContain('•');
    }

    // §8: TEK kayıt (sayfa döngüsü olsaydı N kayıt düşerdi) ve anahtar meta'ya SIZMAZ.
    const audits = await auditRows(OWNER_ACTOR);
    expect(audits).toHaveLength(1);
    const meta = audits[0]!.meta;
    expect(meta.op).toBe('export');
    expect(meta.view).toBe('license_inventory');
    expect(meta.count).toBe(4);
    expect(meta.total).toBe(4);
    expect(meta.truncated).toBe(false);
    expect(meta.limit).toBe(LICENSE_EXPORT_LIMIT);
    expect(meta.productId).toBe(productId);
    expect(meta.hasSearch).toBe(false);
    // Anahtarın KENDİSİ hiçbir meta alanında olmamalı.
    expect(JSON.stringify(meta)).not.toContain(`EXPORT${TAG_UP}`);
  });

  it('(b) OWNER-OLMAYAN (reveal=false): değerler MASKELİ ve reveal audit YAZILMAZ', async () => {
    const res = await stock.exportLicenseItems({ productId }, ADMIN_ACTOR, false);

    expect(res.rows).toHaveLength(4);
    expect(res.masked).toBe(true);
    for (const r of res.rows) {
      // Maske gövdesi var; düz metin (tag) SIZMAZ.
      expect(r.value).toContain('•');
      expect(r.value).not.toContain(tag);
    }
    // Maskeli dosya bir "reveal" DEĞİLDİR → denetim kaydı üretilmez (liste ucuyla simetrik).
    expect(await auditRows(ADMIN_ACTOR)).toHaveLength(0);
  });

  it('(c) süzgeçler AYNEN uygulanır — dosya ekrandaki listeyle aynı kümeyi anlatır', async () => {
    const available = await stock.exportLicenseItems(
      { productId, status: 'available' },
      OWNER_ACTOR,
      true,
    );
    expect(available.rows).toHaveLength(3);
    expect(available.rows.map((r) => r.id)).not.toContain(quarantinedId);

    const dead = await stock.exportLicenseItems(
      { productId, status: 'quarantined' },
      OWNER_ACTOR,
      true,
    );
    expect(dead.rows.map((r) => r.id)).toEqual([quarantinedId]);
  });

  it('(d) tavan aşımı DÜRÜSTÇE bildirilir: truncated=true, gerçek total korunur, audit de söyler', async () => {
    /*
     * 5.000'den fazla kalem eklemek bu paketin koşu süresini anlamsızca büyütürdü; kilitlenmek
     * istenen şey satır sayısı değil MANTIK: "dönen satır sayısı süzgece uyan toplamdan azsa
     * truncated=true" ve bu bilgi hem yanıtta hem denetim kaydında yer alır. Bu yüzden alt
     * katman (sayfalı liste) tavana dayanmış gibi taklit edilir.
     */
    const spy = vi.spyOn(stock, 'listLicenseItems').mockResolvedValue({
      rows: [
        { id: 'a', value: 'X' },
        { id: 'b', value: 'Y' },
      ] as never,
      total: 9_000,
      // 9.000 < LICENSE_COUNT_CAP → sayım tavana DAYANMADI, `total` gerçek toplamdır.
      totalCapped: false,
      countCap: LICENSE_COUNT_CAP,
      page: 1,
      pageSize: LICENSE_EXPORT_LIMIT,
      masked: false,
    });
    try {
      const res = await stock.exportLicenseItems({ productId }, TRUNC_ACTOR, true);
      expect(res.truncated).toBe(true);
      // Gerçek toplam KORUNUR (yoksa operatör "9.000 kaydın hepsi indi" sanır).
      expect(res.total).toBe(9_000);
      expect(res.rows).toHaveLength(2);
      expect(res.limit).toBe(LICENSE_EXPORT_LIMIT);

      // Alt katman TEK istekle, tavana kadar ve KENDİ audit'ini yazmadan çağrılır.
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![3]).toEqual({
        pageSizeOverride: LICENSE_EXPORT_LIMIT,
        audit: false,
      });

      const audits = await auditRows(TRUNC_ACTOR);
      expect(audits).toHaveLength(1);
      expect(audits[0]!.meta.truncated).toBe(true);
      expect(audits[0]!.meta.total).toBe(9_000);
      expect(audits[0]!.meta.count).toBe(2);
    } finally {
      spy.mockRestore();
    }
  });

  it('(e) INVARYANT: sayım tavanı dışa aktarma limitinden BÜYÜK olmalı', () => {
    /*
     * `truncated` kararı `total > rows.length` ile verilir ve `total` artık LICENSE_COUNT_CAP
     * ile tavanlıdır. Tavan dışa aktarma limitinin ÜSTÜNDE kaldığı sürece karar doğrudur
     * (tavana dayanılan her senaryoda 10.000 > 5.000). Tavan bir gün limitin ALTINA çekilirse
     * kırpılmış bir dosya "tam" sanılabilirdi — bu test o sessiz bozulmayı kapıda karşılar.
     */
    expect(LICENSE_COUNT_CAP).toBeGreaterThan(LICENSE_EXPORT_LIMIT);
  });
});
