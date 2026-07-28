import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { ProductsService } from '../../src/products/products.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createSite,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — mağaza ürün kataloğu senkronu (§3, `ProductsService.syncCatalog`).
 *
 * Bu uç site-facing HMAC yolundan çağrılır ve sitenin TÜM katalog snapshot'ını SİLİP yeniden
 * yazar (delete+insert). Yıkıcı bir yol olmasına rağmen hiç testi yoktu; burada davranış
 * zarfını kilitliyoruz:
 *   1. dolu snapshot   → satırlar yazılır, sayı doğru
 *   2. BOŞ dizi        → mevcut katalog SİLİNMEZ (no-op) — WP'de toplu düzenleme/boş cache
 *                        yüzünden gelen boş gövde operatörün kataloğunu süpürmemeli
 *   3. mükerrer ürün   → app-düzeyi dedup, tek satır (unique index NULL'ı ayrı sayar)
 *   4. şablon: manual  → operatörün ELLE girdiği admin sipariş URL şablonu EZİLMEZ ('kept_manual')
 *   5. şablon: otomatik→ geçerli şablon yazılır ('accepted'); host site domaini değilse
 *                        YAZILMAZ ('rejected_host') — mağaza yabancı adrese operatör linki
 *                        yazdıramaz (kimlik-avı yüzeyi)
 *
 * DEĞİŞMEZ: katalog senkronu yalnız LİSTE getirir — OTOMATİK EŞLEŞTİRME YOKTUR; bu testler
 * de hiçbir yerde eşleme (site_product_mappings) oluşmadığını varsayar/gerektirir.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let products: ProductsService;

/** Mağaza ürünü (katalog satırı) üretici — sır YOK (yalnız ad/sku/tip). */
function remoteProduct(overrides: Partial<{
  remoteProductId: string;
  remoteVariationId: string | null;
  name: string;
  sku: string | null;
  kind: string | null;
}> = {}) {
  return {
    remoteProductId: overrides.remoteProductId ?? `rp-${randomUUID().slice(0, 8)}`,
    remoteVariationId: overrides.remoteVariationId ?? null,
    name: overrides.name ?? 'Mağaza ürünü',
    sku: overrides.sku ?? null,
    kind: overrides.kind ?? 'simple',
  };
}

/** Bu sitenin katalog satırları (DB'den taze okuma). */
async function catalogRows(siteId: string) {
  return db
    .select()
    .from(schema.siteRemoteProducts)
    .where(eq(schema.siteRemoteProducts.siteId, siteId));
}

/** Sitenin admin sipariş URL şablonu + kaynak bayrağı. */
async function siteTemplate(siteId: string) {
  const [row] = await db
    .select({
      template: schema.sites.adminOrderUrlTemplate,
      manual: schema.sites.adminOrderUrlTemplateManual,
    })
    .from(schema.sites)
    .where(eq(schema.sites.id, siteId));
  return row!;
}

describe('ProductsService.syncCatalog — mağaza katalog snapshot senkronu', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    products = new ProductsService(db as never);
  });

  afterAll(async () => {
    // site_remote_products sites'a CASCADE FK'li → site silinince katalog da düşer.
    await cleanupByTag(db, tag);
    await end();
  });

  it('dolu snapshot yazılır — satır sayısı ve alanlar doğru', async () => {
    const site: CreatedSite = await createSite(db, crypto, { tag });
    const items = [
      remoteProduct({ name: 'Basit ürün', sku: 'SKU-1', kind: 'simple' }),
      remoteProduct({ name: 'Varyasyonlu ebeveyn', kind: 'variable' }),
      remoteProduct({ remoteVariationId: '501', name: 'Varyasyon A', kind: 'variation' }),
    ];

    const res = await products.syncCatalog(site.id, items);
    expect(res.synced).toBe(3);
    // Şablon alanı hiç gönderilmedi → mevcut değere DOKUNULMAZ.
    expect(res.adminOrderUrlTemplateStatus).toBe('absent');
    expect(res.adminOrderUrlTemplateAccepted).toBe(false);

    const rows = await catalogRows(site.id);
    expect(rows).toHaveLength(3);
    const varyasyon = rows.find((r) => r.remoteVariationId === '501');
    expect(varyasyon?.name).toBe('Varyasyon A');
    expect(varyasyon?.kind).toBe('variation');
    // Varyasyonsuz satırlarda '0' değil NULL saklanır (resolveMapping ile aynı semantik).
    expect(rows.filter((r) => r.remoteVariationId === null)).toHaveLength(2);
  });

  it('ikinci dolu snapshot ESKİSİNİ değiştirir (replace semantiği)', async () => {
    const site = await createSite(db, crypto, { tag });
    await products.syncCatalog(site.id, [remoteProduct({ name: 'Eski' }), remoteProduct()]);
    expect(await catalogRows(site.id)).toHaveLength(2);

    const res = await products.syncCatalog(site.id, [remoteProduct({ name: 'Yeni' })]);
    expect(res.synced).toBe(1);
    const rows = await catalogRows(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('Yeni');
  });

  it('BOŞ dizi gönderimi mevcut kataloğu SİLMEZ (no-op)', async () => {
    const site = await createSite(db, crypto, { tag });
    await products.syncCatalog(site.id, [remoteProduct(), remoteProduct(), remoteProduct()]);
    expect(await catalogRows(site.id)).toHaveLength(3);

    // (a) Yalnız boş dizi → transaction bile açılmaz (erken çıkış).
    const res = await products.syncCatalog(site.id, []);
    expect(res.synced).toBe(0);
    expect(await catalogRows(site.id)).toHaveLength(3);

    // (b) Boş dizi + şablon alanı → tx açılır (şablon değerlendirilir) ama katalog yine SİLİNMEZ.
    const tpl = `https://${site.domain}/wp-admin/post.php?post={orderId}&action=edit`;
    const withTpl = await products.syncCatalog(site.id, [], tpl);
    expect(withTpl.synced).toBe(0);
    expect(withTpl.adminOrderUrlTemplateStatus).toBe('accepted');
    expect(await catalogRows(site.id)).toHaveLength(3);
  });

  it('aynı mağaza ürünü mükerrer gelirse tek satır yazılır (dedup)', async () => {
    const site = await createSite(db, crypto, { tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;
    const res = await products.syncCatalog(site.id, [
      remoteProduct({ remoteProductId, name: 'İlk kazanır' }),
      remoteProduct({ remoteProductId, name: 'Mükerrer 1' }),
      // '0' varyasyon kimliği NULL'a normalize edilir → yukarıdakilerle AYNI anahtar.
      remoteProduct({ remoteProductId, remoteVariationId: '0', name: 'Mükerrer 2' }),
    ]);

    expect(res.synced).toBe(1);
    const rows = await catalogRows(site.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe('İlk kazanır');
    expect(rows[0]!.remoteVariationId).toBeNull();
  });

  it('şablon ELLE girilmişse (manual=true) mağazanınki EZMEZ → kept_manual', async () => {
    const site = await createSite(db, crypto, { tag });
    const elleGirilen = `https://${site.domain}/wp-admin/elle.php?id={orderId}`;
    // Operatörün panel formundan girdiği değer (sites.update manual=true yazar).
    await db
      .update(schema.sites)
      .set({ adminOrderUrlTemplate: elleGirilen, adminOrderUrlTemplateManual: true })
      .where(eq(schema.sites.id, site.id));

    // Mağaza BAŞKA (ve kendi başına geçerli) bir şablon bildiriyor → yok sayılmalı.
    const magazaninki = `https://${site.domain}/wp-admin/post.php?post={orderId}&action=edit`;
    const res = await products.syncCatalog(site.id, [remoteProduct()], magazaninki);

    expect(res.adminOrderUrlTemplateStatus).toBe('kept_manual');
    expect(res.adminOrderUrlTemplateAccepted).toBe(false);
    const after = await siteTemplate(site.id);
    expect(after.template).toBe(elleGirilen); // ← operatörün değeri korundu
    expect(after.manual).toBe(true); // senkron kaynak bayrağına DOKUNMAZ

    // Katalog kısmı normal işledi (şablon reddi senkronu başarısız ETMEZ).
    expect(res.synced).toBe(1);
    expect(await catalogRows(site.id)).toHaveLength(1);
  });

  it('manual=false + geçerli şablon YAZILIR; host uyuşmazlığında YAZILMAZ', async () => {
    const site = await createSite(db, crypto, { tag });
    expect((await siteTemplate(site.id)).manual).toBe(false); // varsayılan: mağaza kaynaklı

    // (a) Geçerli: http(s) + {orderId} + host == site domaini → yazılır.
    const gecerli = `https://${site.domain}/wp-admin/post.php?post={orderId}&action=edit`;
    const kabul = await products.syncCatalog(site.id, [remoteProduct()], gecerli);
    expect(kabul.adminOrderUrlTemplateStatus).toBe('accepted');
    expect(kabul.adminOrderUrlTemplateAccepted).toBe(true);
    expect((await siteTemplate(site.id)).template).toBe(gecerli);
    // Otomatik değer yazmak alanı "elle girilmiş" YAPMAZ (bayrağı yalnız sites.update yazar).
    expect((await siteTemplate(site.id)).manual).toBe(false);

    // (b) Yabancı host → SESSİZCE yok sayılır, mevcut (geçerli) değer korunur.
    const yabanci = `https://baska-magaza.example.org/wp-admin/post.php?post={orderId}&action=edit`;
    const redHost = await products.syncCatalog(site.id, [remoteProduct()], yabanci);
    expect(redHost.adminOrderUrlTemplateStatus).toBe('rejected_host');
    expect(redHost.adminOrderUrlTemplateAccepted).toBe(false);
    expect((await siteTemplate(site.id)).template).toBe(gecerli); // ← ezilmedi

    // (c) Biçim hatası ({orderId} yok) → yine yazılmaz.
    const bicimsiz = `https://${site.domain}/wp-admin/post.php?post=123&action=edit`;
    const redBicim = await products.syncCatalog(site.id, [remoteProduct()], bicimsiz);
    expect(redBicim.adminOrderUrlTemplateStatus).toBe('rejected_format');
    expect((await siteTemplate(site.id)).template).toBe(gecerli);

    // (d) null/boş gönderimi mevcut değeri SİLMEZ (temizleme operatörün işi).
    const bos = await products.syncCatalog(site.id, [remoteProduct()], null);
    expect(bos.adminOrderUrlTemplateStatus).toBe('accepted');
    expect((await siteTemplate(site.id)).template).toBe(gecerli);
  });
});
