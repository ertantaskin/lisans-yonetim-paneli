import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import * as schema from '../../src/db/schema';
import { ZodBody } from '../../src/common/zod-validation.pipe';
import { ListAuditQuerySchema } from '../../src/audit/audit.controller';
import { AuditService } from '../../src/audit/audit.service';
import { makeDb, tagPrefix, type Db } from './_helpers';

/**
 * ENTEGRASYON — DENETİM İZİ LİSTESİ (`GET /v1/admin/audit`, §8).
 *
 * NEDEN BU DOSYA VAR: `audit_log` yıllardır yazılıyordu ama okunmuyordu; ilk okuma yüzeyinde
 * kilitlenmesi gereken üç sözleşme var ve üçü de bu projenin bilinen hata sınıflarına denk
 * geliyor:
 *   1. SÜZGEÇ GERÇEKTEN DARALTMALI — süzgeç sessizce yok sayılırsa operatör daraltılmış bir
 *      kapsama baktığını sanarken global listeye bakar (aynı gerekçe /customers siteId'sinde).
 *   2. SAYFALAMA TUTARLI OLMALI — `created_at DESC` TEK BAŞINA tie-break değildir: bir
 *      transaction içinde yazılan audit satırları AYNI damgayı taşır (toplu geçersiz kılma:
 *      kalem başına bir satır). Tie-break'siz LIMIT/OFFSET'te aynı kayıt iki sayfada çıkar ya
 *      da HİÇ çıkmaz. Aşağıdaki test bilerek TÜM satırlara AYNI `created_at` verir.
 *   3. TOPLAM İLE LİSTE ÇELİŞMEMELİ — sayım ve sayfa sorgusu aynı `where` fragmanını kullanır.
 * Ayrıca geçersiz enum'un HAM 500 değil AÇIK 400 ürettiği ve meta redaksiyon kalkanının
 * çalıştığı doğrulanır.
 *
 * NOT: gerçek Postgres ister (DATABASE_URL). Windows geliştirme makinesinde KOŞULMADI —
 * yalnız typecheck ile derlendiği doğrulandı.
 *
 * TEMİZLİK: `cleanupByTag` audit_log'a DOKUNMAZ (tag'i sku/domain üzerinden bulur) → bu dosya
 * kendi satırlarını AKTÖR öneki ile kendisi siler. Denetim izi append-only olduğu için test
 * verisi de yalnız buradan (doğrudan SQL ile) temizlenebilir.
 */

const tag = randomUUID().slice(0, 8);
const prefix = tagPrefix(tag);

/** Süzgeç testlerinin aktörü (kısmi ILIKE eşleşmesi bunun üzerinden yapılır). */
const ALICE = `${prefix}-alice`;
const BOB = `${prefix}-bob`;
/** Sayfalama testinin AYRI aktörü — süzgeç testlerinin satırlarını saymasın. */
const PAGER = `${prefix}-pager`;

/** Sayfalama testi satır sayısı — en küçük izinli sayfa boyutunun (25) 2 katından fazla. */
const PAGER_ROWS = 60;
const PAGE_SIZE = 25;

let db: Db;
let end: () => Promise<void>;
let audit: AuditService;

/** Sabit tarihler — `from`/`to` süzgeci deterministik olsun (now() kullanılmaz). */
const T_OLD = new Date('2026-01-10T09:00:00.000Z');
const T_MID = new Date('2026-02-10T09:00:00.000Z');
const T_NEW = new Date('2026-03-10T09:00:00.000Z');

describe('denetim izi listesi — süzgeç · sayfalama · toplam · 400 · meta redaksiyonu', () => {
  beforeAll(async () => {
    const conn = makeDb();
    db = conn.db;
    end = conn.end;
    audit = new AuditService(db as never);

    // ── Süzgeç kümesi (5 satır) ──
    await db.insert(schema.auditLog).values([
      {
        action: 'reveal',
        actor: ALICE,
        targetType: 'license_item',
        targetId: 'li-1',
        traceId: `${prefix}-trace-a`,
        createdAt: T_OLD,
        // Redaksiyon kalkanı: `password` ve iç içe `apiKey` [gizlendi] olmalı, `reason` kalmalı.
        meta: { reason: 'destek talebi', password: 'gizli-parola', nested: { apiKey: 'abc123' } },
      },
      {
        action: 'revoke',
        actor: ALICE,
        targetType: 'assignment',
        targetId: 'asg-1',
        traceId: `${prefix}-trace-b`,
        createdAt: T_MID,
        meta: { reason: 'iade' },
      },
      {
        action: 'revoke',
        actor: BOB,
        targetType: 'assignment',
        targetId: 'asg-2',
        traceId: `${prefix}-trace-c`,
        createdAt: T_MID,
        meta: null,
      },
      {
        action: 'import',
        actor: BOB,
        targetType: 'product',
        targetId: 'prod-1',
        traceId: `${prefix}-trace-d`,
        createdAt: T_NEW,
        meta: { imported: 3 },
      },
      {
        action: 'login',
        actor: BOB,
        targetType: null,
        targetId: null,
        traceId: null,
        createdAt: T_NEW,
        meta: null,
      },
    ]);

    // ── Sayfalama kümesi: TÜM satırlar AYNI created_at (tie-break'i zorlar) ──
    await db.insert(schema.auditLog).values(
      Array.from({ length: PAGER_ROWS }, () => ({
        action: 'assign' as const,
        actor: PAGER,
        targetType: 'order',
        targetId: randomUUID(),
        createdAt: T_MID,
        meta: null,
      })),
    );
  });

  afterAll(async () => {
    // Append-only tabloda test verisi yalnız burada silinir (uygulama kodunda silme ucu YOK).
    await db.execute(sql`DELETE FROM audit_log WHERE actor LIKE ${`${prefix}-%`}`);
    await end();
  });

  it('aktör süzgeci KISMİ eşleşir ve gerçekten daraltır', async () => {
    // Tag öneki tüm kümeyi kapsar (5 + 60), tam aktör adı yalnız kendi satırlarını.
    const all = await audit.list({ actor: prefix, pageSize: 100 });
    expect(all.total).toBe(5 + PAGER_ROWS);

    // "alice" — tam dize değil, PARÇA: operatör 'panel:ali@x.com' ezberlemek zorunda değil.
    const mine = await audit.list({ actor: `${tag}-alice`, pageSize: 100 });
    expect(mine.total).toBe(2);
    expect(mine.items.every((r) => r.actor === ALICE)).toBe(true);

    // Eşleşmeyen aktör → boş liste + toplam 0 (global listeye DÜŞMEZ).
    const none = await audit.list({ actor: `${prefix}-yok-boyle-biri`, pageSize: 100 });
    expect(none.total).toBe(0);
    expect(none.items).toHaveLength(0);
  });

  it('eylem (action) süzgeci daraltır — enum parametre cast yolu çalışıyor', async () => {
    const revokes = await audit.list({ actor: prefix, action: 'revoke', pageSize: 100 });
    expect(revokes.total).toBe(2);
    expect(revokes.items.every((r) => r.action === 'revoke')).toBe(true);

    const logins = await audit.list({ actor: prefix, action: 'login', pageSize: 100 });
    expect(logins.total).toBe(1);
    expect(logins.items[0]?.actor).toBe(BOB);
  });

  it('hedef (targetType + targetId) süzgeci daraltır', async () => {
    const byType = await audit.list({ actor: prefix, targetType: 'assignment', pageSize: 100 });
    expect(byType.total).toBe(2);

    const byId = await audit.list({
      actor: prefix,
      targetType: 'assignment',
      targetId: 'asg-2',
      pageSize: 100,
    });
    expect(byId.total).toBe(1);
    expect(byId.items[0]?.actor).toBe(BOB);
  });

  it('tarih aralığı (from/to) daraltır — sınırlar DAHİL', async () => {
    // T_MID tam sınır: hem from hem to olarak verildiğinde o günün kayıtları GELMELİ
    // (dışlayıcı `>`/`<` yazımı operatörün aradığı kaydı sessizce düşürürdü).
    const midOnly = await audit.list({
      actor: prefix,
      from: T_MID.toISOString(),
      to: T_MID.toISOString(),
      pageSize: 100,
    });
    // 2 süzgeç satırı (revoke×2) + 60 sayfalama satırı — hepsi T_MID.
    expect(midOnly.total).toBe(2 + PAGER_ROWS);

    const fromNew = await audit.list({ actor: prefix, from: T_NEW.toISOString(), pageSize: 100 });
    expect(fromNew.total).toBe(2); // import + login

    const untilOld = await audit.list({ actor: prefix, to: T_OLD.toISOString(), pageSize: 100 });
    expect(untilOld.total).toBe(1); // yalnız reveal
  });

  it('traceId süzgeci tek kaydı bulur (uçtan uca iz takibi)', async () => {
    const one = await audit.list({ traceId: `${prefix}-trace-b`, pageSize: 100 });
    expect(one.total).toBe(1);
    expect(one.items[0]?.action).toBe('revoke');
    expect(one.items[0]?.actor).toBe(ALICE);
  });

  it('sayfalama tutarlı: AYNI created_at damgasında bile kayıt tekrarlamaz/kaybolmaz', async () => {
    const seen: string[] = [];
    let total = -1;

    for (let page = 1; page <= 3; page += 1) {
      const res = await audit.list({ actor: `${tag}-pager`, page, pageSize: PAGE_SIZE });
      expect(res.page).toBe(page);
      expect(res.pageSize).toBe(PAGE_SIZE);
      // Toplam her sayfada AYNI olmalı (liste ile toplam ayrışmaz).
      if (total < 0) total = res.total;
      expect(res.total).toBe(total);
      seen.push(...res.items.map((r) => r.id));
    }

    expect(total).toBe(PAGER_ROWS);
    // Üç sayfa = 25 + 25 + 10; TEKRAR YOK, EKSİK YOK. Tie-break olmasaydı bu iki koşuldan
    // en az biri (çoğunlukla ikisi birden) bozulurdu.
    expect(seen).toHaveLength(PAGER_ROWS);
    expect(new Set(seen).size).toBe(PAGER_ROWS);

    // Sıralama kararlı: eşit damgada `id DESC` — tersine sıralanmış kopyayla birebir aynı.
    const expected = [...seen].sort().reverse();
    expect(seen).toEqual(expected);

    // Aralık dışı sayfa boş döner ama TOPLAM yine doğrudur (kontrat: total = süzgece uyan).
    const far = await audit.list({ actor: `${tag}-pager`, page: 99, pageSize: PAGE_SIZE });
    expect(far.items).toHaveLength(0);
    expect(far.total).toBe(PAGER_ROWS);
  });

  it('toplam ile liste tutarlı + küçük kümede totalCapped=false', async () => {
    const res = await audit.list({ actor: `${tag}-alice`, pageSize: 100 });
    expect(res.items).toHaveLength(res.total);
    expect(res.totalCapped).toBe(false);
    expect(res.countCap).toBeGreaterThan(0);
  });

  it('geçersiz enum/tarih 400 verir (ham 500 DEĞİL), boş string süzgeci temizler', () => {
    const pipe = new ZodBody(ListAuditQuerySchema);

    expect(() => pipe.transform({ action: 'boyle-bir-eylem-yok' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ from: 'dun' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ targetType: 'Order Line!' })).toThrow(BadRequestException);
    expect(() => pipe.transform({ page: 'x' })).toThrow(BadRequestException);

    // Boş string = "süzgeç yok" → geçerli (admin UI seçimi sıfırlarken boş parametre gönderir).
    expect(() => pipe.transform({ action: '', from: '', targetType: '' })).not.toThrow();
    expect(() => pipe.transform({ action: 'revoke' })).not.toThrow();
  });

  it('meta redaksiyonu: sır çağrıştıran anahtarlar gizlenir, geri kalanı korunur', async () => {
    const res = await audit.list({ actor: `${tag}-alice`, action: 'reveal', pageSize: 100 });
    const meta = res.items[0]?.meta as Record<string, unknown>;
    expect(meta.reason).toBe('destek talebi');
    expect(meta.password).toBe('[gizlendi]');
    expect((meta.nested as Record<string, unknown>).apiKey).toBe('[gizlendi]');
  });
});
