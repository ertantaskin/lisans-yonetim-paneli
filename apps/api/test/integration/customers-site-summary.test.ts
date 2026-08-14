import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CustomersService } from '../../src/customers/customers.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  makeCrypto,
  makeDb,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — mağaza → müşteri hiyerarşisi (`customers.siteSummary` + `list({siteId})`).
 *
 * NEDEN BU DOSYA VAR: `/customers` giriş ekranı artık MAĞAZA kartlarıdır ve bu ekranın iki
 * sessiz kırılma noktası var:
 *
 *   1. LEFT JOIN → INNER JOIN kayması. Sorgu `sites LEFT JOIN orders` ile kurulur; biri
 *      yanlışlıkla INNER'a çevirirse HENÜZ SİPARİŞİ OLMAYAN mağaza ekrandan TAMAMEN kaybolur
 *      ve operatör yeni bağladığı mağaza için "bağlantı kurulmadı mı?" diye arar. Sıfır,
 *      yokluk değil BİLGİDİR — bu yüzden 0/0/null satırı sözleşmenin parçasıdır.
 *
 *   2. Aynı e-postanın iki mağazada da sayılması BİLİNÇLİ davranıştır (müşteri kaydı e-posta
 *      bazlı GLOBALdir, hiyerarşi yalnız sunumdadır). Biri bunu "çift sayım hatası" sanıp
 *      DISTINCT-global bir düzeltme yaparsa mağaza kartları gerçeği göstermez. Bu yüzden
 *      testte AÇIKÇA kilitlenir (kod yorumunda da yazılıdır).
 *
 * Üçüncü kilit `list({siteId})` kapsamıdır: site süzgeci uygulandığında YALNIZ o mağazanın
 * müşterileri dönmelidir — sızıntı olursa operatör başka mağazanın müşterisini o mağazanın
 * kartından açar.
 */

const tag = randomUUID().slice(0, 8);

let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let customers: CustomersService;

/** Bu koşuya özel e-postalar — paylaşılan DB'de başka satırlarla karışmasın. */
const SHARED_EMAIL = `${tag}-ortak@example.test`;
const ONLY_A_EMAIL = `${tag}-sadece-a@example.test`;
const ONLY_B_EMAIL = `${tag}-sadece-b@example.test`;

let siteA: { id: string; domain: string };
let siteB: { id: string; domain: string };
let siteEmpty: { id: string; domain: string };

describe('mağaza → müşteri hiyerarşisi (siteSummary + site kapsamlı liste)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    customers = new CustomersService(db as never);

    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    siteA = await createSite(db, crypto, { tag });
    siteB = await createSite(db, crypto, { tag });
    // Üçüncü mağaza BİLEREK siparişsiz bırakılır (LEFT JOIN kilidi).
    siteEmpty = await createSite(db, crypto, { tag });

    // A mağazası: ortak müşteriden 2 sipariş + yalnız A'nın müşterisinden 1 sipariş = 3 sipariş / 2 müşteri.
    await createOrderWithLine(db, {
      siteId: siteA.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: SHARED_EMAIL,
    });
    await createOrderWithLine(db, {
      siteId: siteA.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: SHARED_EMAIL,
    });
    await createOrderWithLine(db, {
      siteId: siteA.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: ONLY_A_EMAIL,
    });

    // B mağazası: AYNI ortak müşteri + yalnız B'nin müşterisi = 2 sipariş / 2 müşteri.
    await createOrderWithLine(db, {
      siteId: siteB.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: SHARED_EMAIL,
    });
    await createOrderWithLine(db, {
      siteId: siteB.id,
      productId: product.id,
      qty: 1,
      tag,
      customerEmail: ONLY_B_EMAIL,
    });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('siparişi OLMAYAN mağaza listede DURUR (0 müşteri / 0 sipariş / son sipariş yok)', async () => {
    const rows = await customers.siteSummary();
    const empty = rows.find((r) => r.siteId === siteEmpty.id);
    expect(empty).toBeTruthy(); // INNER JOIN'e kayarsa bu satır YOK olur
    expect(empty!.domain).toBe(siteEmpty.domain);
    expect(empty!.customerCount).toBe(0);
    expect(empty!.orderCount).toBe(0);
    expect(empty!.lastOrderAt).toBeNull();
  });

  it('mağaza sayaçları o mağazanın siparişlerinden türer (müşteri DISTINCT e-posta)', async () => {
    const rows = await customers.siteSummary();
    const a = rows.find((r) => r.siteId === siteA.id)!;
    expect(a.orderCount).toBe(3);
    expect(a.customerCount).toBe(2); // ortak + yalnız-A
    expect(a.lastOrderAt).not.toBeNull();
  });

  it('aynı e-posta İKİ mağazada da sayılır — bilinçli davranış, "çift sayım" DEĞİL', async () => {
    // Bunu "düzeltmek" (global DISTINCT) mağaza kartlarını yalan söyletir: ortak müşteri
    // gerçekten her iki mağazadan da alışveriş yapmıştır.
    const rows = await customers.siteSummary();
    const a = rows.find((r) => r.siteId === siteA.id)!;
    const b = rows.find((r) => r.siteId === siteB.id)!;
    expect(a.customerCount).toBe(2);
    expect(b.customerCount).toBe(2);

    const scopedA = await customers.list({ siteId: siteA.id });
    const scopedB = await customers.list({ siteId: siteB.id });
    expect(scopedA.items.map((c) => c.email)).toContain(SHARED_EMAIL);
    expect(scopedB.items.map((c) => c.email)).toContain(SHARED_EMAIL);
  });

  it('list({ siteId }) kapsamı: yalnız o mağazanın müşterileri döner', async () => {
    const scopedA = await customers.list({ siteId: siteA.id });
    const emails = scopedA.items.map((c) => c.email);

    expect(emails).toEqual(expect.arrayContaining([SHARED_EMAIL, ONLY_A_EMAIL]));
    // Sızıntı kilidi: B'nin müşterisi A kapsamında GÖRÜNMEMELİ.
    expect(emails).not.toContain(ONLY_B_EMAIL);

    // Sipariş sayısı da kapsanır: ortak müşterinin A'daki 2 siparişi (B'deki 1 sipariş sayılmaz).
    const shared = scopedA.items.find((c) => c.email === SHARED_EMAIL)!;
    expect(shared.orderCount).toBe(2);
    expect(shared.sites).toEqual([siteA.domain]);
  });

  it('süzgeçsiz liste ortak müşteriyi TEK satırda, iki mağazayla birlikte gösterir', async () => {
    // Global görünümde "Siteler" kolonu iki alan adı taşımalı — hiyerarşi yalnız sunumdadır,
    // veri modeli (e-posta bazlı tek müşteri) değişmez.
    const all = await customers.list({ search: SHARED_EMAIL });
    const shared = all.items.filter((c) => c.email === SHARED_EMAIL);
    expect(shared).toHaveLength(1);
    expect(shared[0]!.orderCount).toBe(3);
    expect([...shared[0]!.sites].sort()).toEqual([siteA.domain, siteB.domain].sort());
  });
});
