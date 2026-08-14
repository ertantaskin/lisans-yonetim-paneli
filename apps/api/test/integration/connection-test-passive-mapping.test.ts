import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { ProductsService } from '../../src/products/products.service';
import { SitesService } from '../../src/sites/sites.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import { cleanupByTag, createProduct, createSite, makeCrypto, makeDb, type Db } from './_helpers';

/**
 * ENTEGRASYON — onboarding bağlantı testi + PASİF eşleme görünürlüğü.
 *
 * İki denetim bulgusunun davranış zarfını kilitler:
 *
 * (a) `SitesService.testConnection` — eskiden ÜRETTİĞİ dört kontrolün DÖRDÜ de yeni açılmış bir
 *     sitede zaten geçiyordu (kayıt var, durum şema varsayılanı 'active', HMAC secret saniyeler
 *     önce üretildi, webhook boşsa "beklemede" ama ok=true). Operatör WordPress'e hiç gitmeden
 *     yemyeşil sonuç alıp kurulumu bitmiş sanıyordu. Artık mağazanın FİİLÎ davranışına bakan bir
 *     kontrol var: `sites.plugin_version` (yalnız GEÇERLİ İMZALI bir istekte yazılır).
 *
 * (b) `listCatalog` / `listUnmapped` — okuma yolları eşlemeyi yalnız `active` iken sayıyordu ama
 *     `createMapping`'in mükerrer ön-kontrolü `active` koşulu taşımıyor → operatör pasifleştirdiği
 *     eşlemeyi "eşlenmemiş" görüp "Eşle" deyince 409 alıyor, çıkış yolu bulamıyordu. Artık satır
 *     ÜÇÜNCÜ durumu (`mappingActive=false`) taşır; 409 KORUNUR (aynı anahtara ikinci satır açmak
 *     sessiz mükerrer üretirdi — `resolveMapping` "en eski"i seçer), yalnız mesajı doğru çıkışı
 *     söyler ve UI "Etkinleştir" gösterebilir.
 *
 * DEĞİŞMEZ: `resolveMapping` davranışı BURADA DA DOĞRULANIR — pasif eşleme teslimat YAPMAZ.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let sites: SitesService;
let products: ProductsService;

/** Kontrol satırını `key` ile bulur (UI de bu alana göre dallanır). */
function check(result: { checks: Array<{ key: string; ok: boolean; detail: string }> }, key: string) {
  return result.checks.find((c) => c.key === key);
}

describe('onboarding bağlantı testi + pasif eşleme görünürlüğü', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    sites = new SitesService(db as never, crypto);
    products = new ProductsService(db as never);
  });

  afterAll(async () => {
    // cleanupByTag site_product_mappings'i step-0'da siler (products'a RESTRICT FK).
    await cleanupByTag(db, tag);
    await end();
  });

  // ── (a) testConnection: eklenti bağlantısı kontrolü ────────────────────────
  it('yeni sitede test EKLENTİ kontrolü yüzünden başarısız; sürüm bildirilince başarılı', async () => {
    const site = await createSite(db, crypto, { tag });

    const before = await sites.testConnection(site.id);
    // Panel tarafı hazır: bunlar sitenin KENDİ kaydına bakar, hepsi geçer.
    expect(check(before, 'site')?.ok).toBe(true);
    expect(check(before, 'status')?.ok).toBe(true);
    expect(check(before, 'hmac')?.ok).toBe(true);
    // webhookUrl yok → "beklemede" (hata değil; eklenti bağlanınca otomatik yazılır).
    expect(check(before, 'webhook')?.ok).toBe(true);
    // ASIL BULGU: mağaza panele hiç imzalı istek göndermedi → genel sonuç YEŞİL OLAMAZ.
    expect(check(before, 'plugin')?.ok).toBe(false);
    expect(check(before, 'plugin')?.detail).toContain('hiç imzalı istek göndermedi');
    expect(before.ok).toBe(false);

    // Eklenti bağlanır: HmacGuard imzayı doğruladıktan SONRA sürümü yazar (0028).
    await sites.recordPluginVersion(site.id, '1.0.4');

    const after = await sites.testConnection(site.id);
    expect(check(after, 'plugin')?.ok).toBe(true);
    expect(check(after, 'plugin')?.detail).toContain('v1.0.4');
    expect(after.ok).toBe(true);
  });

  it('site askıya alınmışsa eklenti bağlı olsa bile genel sonuç başarısız', async () => {
    // Regresyon koruması: yeni kontrol eklenirken diğerlerinin "ok" katkısı bozulmamalı.
    const site = await createSite(db, crypto, { tag });
    await sites.recordPluginVersion(site.id, '1.0.4');
    await db
      .update(schema.sites)
      .set({ status: 'suspended' })
      .where(eq(schema.sites.id, site.id));

    const res = await sites.testConnection(site.id);
    expect(check(res, 'plugin')?.ok).toBe(true);
    expect(check(res, 'status')?.ok).toBe(false);
    expect(res.ok).toBe(false);
  });

  // ── (b) pasif eşleme: katalog + eşlenmemiş listesi + 409 ───────────────────
  it('pasif eşlemeli katalog satırı "eşli ama pasif" döner; createMapping hâlâ 409 verir', async () => {
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;

    await products.syncCatalog(site.id, [
      { remoteProductId, remoteVariationId: null, name: 'Pasif eşlemeli ürün', sku: null, kind: 'simple' },
    ]);
    const mapping = await products.createMapping({
      siteId: site.id,
      productId: product.id,
      remoteProductId,
    });

    // Aktif hâl: satır "eşli" ve UI'nın baktığı alan true.
    const active = (await products.listCatalog(site.id)).find(
      (r) => r.remoteProductId === remoteProductId,
    );
    expect(active?.mapped).toBe(true);
    expect(active?.mappingActive).toBe(true);
    expect(active?.mappedProductId).toBe(product.id);

    // Operatör eşlemeyi PASİFLEŞTİRİR.
    await products.updateMapping(mapping.id, { active: false });

    const passive = (await products.listCatalog(site.id)).find(
      (r) => r.remoteProductId === remoteProductId,
    );
    // `mapped` ANLAMI KORUNDU: teslimat yapacak aktif eşleme YOK.
    expect(passive?.mapped).toBe(false);
    // ÜÇÜNCÜ DURUM — UI "Eşlenmemiş" yerine "Eşleme pasif" + "Etkinleştir" gösterir.
    expect(passive?.mappingActive).toBe(false);
    expect(passive?.mappingId).toBe(mapping.id);
    expect(passive?.mappedProductId).toBe(product.id);

    // DEĞİŞMEZ: pasif eşleme teslimat YAPMAZ (bilinçli — resolveMapping'e dokunulmadı).
    expect(await products.resolveMapping(site.id, remoteProductId)).toBeNull();

    // 409 KORUNUR (sessiz mükerrer eşleme yaratılmaz) ama mesaj doğru çıkışı söyler.
    await expect(
      products.createMapping({ siteId: site.id, productId: product.id, remoteProductId }),
    ).rejects.toThrow(/PASİF/);

    // Etkinleştirme çıkış yolu gerçekten çalışıyor: satır tekrar eşli olur.
    await products.updateMapping(mapping.id, { active: true });
    const reactivated = (await products.listCatalog(site.id)).find(
      (r) => r.remoteProductId === remoteProductId,
    );
    expect(reactivated?.mapped).toBe(true);
    expect(reactivated?.mappingActive).toBe(true);
    expect(await products.resolveMapping(site.id, remoteProductId)).toEqual({
      productId: product.id,
      bundleQty: 1,
    });
  });

  it('eşlenmemiş gelen ürünler listesi pasif eşlemeyi satırla birlikte döndürür', async () => {
    const site = await createSite(db, crypto, { tag });
    const product = await createProduct(db, { tag });
    const remoteProductId = `rp-${randomUUID().slice(0, 8)}`;

    // Eşlemesiz gelmiş gerçek sipariş satırı: product_id NULL + remote_product_id dolu.
    // (createOrderWithLine helper'ı productId zorunlu kıldığı için elle insert ediliyor.)
    const remoteOrderId = `it-${tag}-ord-${randomUUID().slice(0, 8)}`;
    const [order] = await db
      .insert(schema.orders)
      .values({
        siteId: site.id,
        remoteOrderId,
        customerEmail: `${tag}@example.test`,
        status: 'pending',
        idempotencyKey: `${site.id}:${remoteOrderId}`,
      })
      .returning({ id: schema.orders.id });
    await db.insert(schema.orderLines).values({
      orderId: order!.id,
      productId: null,
      remoteLineId: `it-${tag}-line-1`,
      qty: 1,
      remoteProductId,
      remoteName: 'Mağazadan gelen ad',
    });

    // (1) Hiç eşleme yokken: gerçekten eşlenmemiş → mappingActive null.
    const fresh = (await products.listUnmapped()).find(
      (r) => r.siteId === site.id && r.remoteProductId === remoteProductId,
    );
    expect(fresh).toBeDefined();
    expect(fresh?.mappingActive).toBeNull();
    expect(fresh?.mappingId).toBeNull();

    // (2) Eşleme kurulup PASİFLEŞTİRİLİRSE satır listede KALIR (teslimat yapılamıyor) ama
    //     artık "eşleme pasif" olduğu görünür → UI "Eşle" (409) yerine "Etkinleştir" gösterir.
    const mapping = await products.createMapping({
      siteId: site.id,
      productId: product.id,
      remoteProductId,
    });
    await products.updateMapping(mapping.id, { active: false });

    const passive = (await products.listUnmapped()).find(
      (r) => r.siteId === site.id && r.remoteProductId === remoteProductId,
    );
    expect(passive).toBeDefined();
    expect(passive?.mappingActive).toBe(false);
    expect(passive?.mappingId).toBe(mapping.id);
    expect(passive?.mappedProductName).toBeTruthy();

    // (3) Etkinleştirilince satır listeden tamamen DÜŞER (artık teslim edilebilir).
    await products.updateMapping(mapping.id, { active: true });
    const gone = (await products.listUnmapped()).find(
      (r) => r.siteId === site.id && r.remoteProductId === remoteProductId,
    );
    expect(gone).toBeUndefined();
  });
});
