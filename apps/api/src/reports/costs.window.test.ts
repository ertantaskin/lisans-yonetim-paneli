import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { CostsService } from './costs.service';

/**
 * BİRİM — maliyet raporu zaman penceresi (denetim bulgusu O7).
 *
 * NEDEN BİRİM TESTİ DE VAR (entegrasyon testi ayrıca yazıldı): pencere fragmanları HAM `sql`
 * şablonuyla kuruluyor ve buradaki tek kritik hata SESSİZDİR — bir `Date` NESNESİ bind
 * edilirse postgres.js `ERR_INVALID_ARG_TYPE` atar ve uç HER ZAMAN 500 döner. `tsc` ve
 * `next build` bunu YAKALAMAZ; bu projede `/audit` tarih süzgecinde tam olarak bu yaşandı.
 * Bu test gerçek PG İSTEMEDEN üretilen SQL'i ve bind parametrelerini denetler → CI'ın hızlı
 * ayağında da korunur.
 *
 * Yaklaşım: `execute` çağrısını yakalayan sahte bir Database ile servis koşturulur, üretilen
 * SQL `PgDialect` ile gerçek sorgu + parametre listesine çevrilir.
 */

interface Captured {
  sql: string;
  params: unknown[];
}

const dialect = new PgDialect();

/** Servisi sahte executor ile koşturur; üretilen tüm sorguları döndürür. */
async function capture(
  params?: Parameters<CostsService['getCostReport']>[0],
): Promise<Captured[]> {
  const out: Captured[] = [];
  const fake = {
    execute: async (query: SQL) => {
      const q = dialect.sqlToQuery(query);
      out.push({ sql: q.sql, params: q.params });
      return [] as unknown[];
    },
  };
  await new CostsService(fake as never).getCostReport(params);
  return out;
}

/** Tüm sorgulardaki bind parametrelerini tek listede toplar. */
const allParams = (rows: Captured[]) => rows.flatMap((r) => r.params);

describe('CostsService zaman penceresi — üretilen SQL', () => {
  it('varsayılan pencere uygulanır ve ALT sınır dört akış sorgusuna girer', async () => {
    const rows = await capture();
    expect(rows).toHaveLength(6); // bySupplier, byMonth, byProduct, valuation, wastage, deliveredCogs

    // Pencerelenen kolonlar — her biri kendi gerekçesiyle seçildi (bkz. servis jsdoc'ları).
    const windowed = [
      'coalesce(po.received_at, po.created_at) >=',
      'b.received_at >=',
      'sa.created_at >=',
      'a.delivered_at >=',
    ];
    for (const needle of windowed) {
      expect(rows.some((r) => r.sql.includes(needle))).toBe(true);
    }

    // Varsayılanda ÜST sınır konmaz (ileri tarihli teslim-alma damgaları düşmesin).
    expect(rows.some((r) => r.sql.includes('<= $'))).toBe(false);
  });

  it('stok değerleme (valuation) PENCERESİZ kalır — anlık pozisyon, dönem akışı değil', async () => {
    const rows = await capture({ from: '2020-01-01', to: '2020-12-31' });
    const valuation = rows.find((r) => r.sql.includes("li.status = 'available'"));
    expect(valuation).toBeDefined();
    expect(valuation!.params).toHaveLength(0);
  });

  it('TARİH BAĞLAMA: bind parametreleri ISO DİZE, asla Date nesnesi değil', async () => {
    const rows = await capture({ from: '2026-01-01', to: '2026-06-30' });
    const params = allParams(rows);
    expect(params.length).toBeGreaterThan(0);
    for (const p of params) {
      // Bir Date sızarsa postgres.js bind aşamasında patlar → uç HER ZAMAN 500 döner.
      expect(p instanceof Date).toBe(false);
      expect(typeof p).toBe('string');
      expect(Number.isNaN(Date.parse(p as string))).toBe(false);
    }
    // Cast ŞART: cast'siz parametre `text` bind edilir, `timestamptz` karşılaştırması 42883 verir.
    expect(rows.some((r) => r.sql.includes('::timestamptz'))).toBe(true);
  });

  it('gün girdisi: `from` gün BAŞI, `to` gün SONU olarak genişletilir', async () => {
    const svc = new CostsService({ execute: async () => [] } as never);
    const report = await svc.getCostReport({ from: '2026-03-10', to: '2026-03-10' });
    // Aynı günün başı ile sonu → aralık BOŞ olmamalı (yoksa "bugüne kadar" seçen operatör
    // bugünün kayıtlarını göremezdi).
    expect(report.window.from).not.toBeNull();
    expect(report.window.to).not.toBeNull();
    expect(new Date(report.window.to!).getTime()).toBeGreaterThan(
      new Date(report.window.from!).getTime(),
    );
    expect(new Date(report.window.from!).getHours()).toBe(0);
    expect(new Date(report.window.to!).getHours()).toBe(23);
  });

  it('allTime → hiçbir tarih parametresi bind edilmez', async () => {
    const rows = await capture({ allTime: true });
    expect(allParams(rows)).toHaveLength(0);
    expect(rows.some((r) => r.sql.includes('::timestamptz'))).toBe(false);
  });

  it('bozuk tarih VARSAYILAN pencereye düşer — "sınırsız"a DEĞİL', async () => {
    // Bozuk bir girdinin ödülü tam-tablo taraması olmamalı (bulgunun kendisi buydu).
    // Servis 500 üretmez; 400 döndürmek controller katmanının işidir.
    const svc = new CostsService({ execute: async () => [] } as never);
    const report = await svc.getCostReport({ from: 'gecersiz' });
    expect(report.window.from).not.toBeNull();
    expect(report.window.to).toBeNull();
    expect(report.window.isDefault).toBe(true);
    expect(report.window.allTime).toBe(false);
  });
});
