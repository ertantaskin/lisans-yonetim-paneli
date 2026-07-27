import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../../src/db/schema';
import { ReportsService } from '../../src/reports/reports.service';
import type { CryptoService } from '../../src/crypto/crypto.service';
import {
  cleanupByTag,
  createOrderWithLine,
  createProduct,
  createSite,
  insertLicenseItems,
  makeCrypto,
  makeDb,
  type CreatedSite,
  type Db,
} from './_helpers';

/**
 * ENTEGRASYON — ReportsService.velocity (§18 satış hızı statü filtresi).
 *
 * velocity YALNIZ AYAKTA atamaları sayar (reconcile ile AYNI küme: active/suspended/expired) —
 * iade (revoked) ve değişimde geri alınan (replaced) atama SATIŞ SAYILMAZ (çift-sayım + iade
 * sonrası şişkin hız/tükenme-tahmini düzelir). Bu dosya o FILTER'ı kilitler: revoked/replaced
 * sayıma sızarsa (statü kümesi genişlerse) sold7d/sold30d beklenenden büyük çıkar → yakalanır.
 *
 * velocity private → overview() üzerinden okunur (public API yüzeyi). Aynı ürüne farklı statülü
 * atamalar seed'lenir; yalnız 3 ayakta statü sayılmalı.
 */

const tag = randomUUID().slice(0, 8);
let db: Db;
let end: () => Promise<void>;
let crypto: CryptoService;
let reports: ReportsService;
let site: CreatedSite;

describe('ReportsService.velocity (ayakta statü filtresi: active/suspended/expired)', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    crypto = makeCrypto();
    reports = new ReportsService(db as never);
    site = await createSite(db, crypto, { tag });
  });

  afterAll(async () => {
    await cleanupByTag(db, tag);
    await end();
  });

  it('active+suspended+expired sayılır; revoked+replaced SAYILMAZ (reconcile ile aynı küme)', async () => {
    const product = await createProduct(db, { tag, kind: 'key', usageMode: 'single' });
    // Her atama için ayrı license_item (temiz FK).
    const items = await insertLicenseItems(db, crypto, { productId: product.id, count: 5, tag });
    const order = await createOrderWithLine(db, {
      siteId: site.id,
      productId: product.id,
      qty: 5,
      tag,
      status: 'partial',
    });

    // 5 atama, farklı statülerde (units=1). created_at default now() → 7/30g penceresinde.
    const statuses = ['active', 'suspended', 'expired', 'revoked', 'replaced'] as const;
    await db.insert(schema.assignments).values(
      statuses.map((status, i) => ({
        orderId: order.orderId,
        lineId: order.lineId,
        licenseItemId: items[i]!,
        units: 1,
        status,
        deliveredAt: new Date(),
      })),
    );

    const overview = await reports.overview();
    const row = overview.velocity.find((r) => r.productId === product.id);
    expect(row).toBeDefined();

    // YALNIZ active(1)+suspended(1)+expired(1) = 3 sayılır; revoked+replaced (2) HARİÇ.
    expect(row!.sold7d).toBe(3);
    expect(row!.sold30d).toBe(3);
    // dailyRate = sold30d/30 = 0.1 (2 ondalık); daysRemaining sonlu bir sayı (rate>0).
    expect(row!.dailyRate).toBeCloseTo(0.1, 5);
    expect(row!.daysRemaining).not.toBeNull();
  });
});
