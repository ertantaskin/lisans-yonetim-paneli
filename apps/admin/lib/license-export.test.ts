/**
 * HANGİ REGRESYONU YAKALAR: envanter dışa aktarmasının SAF çekirdeği — CSV kaçışlama ve
 * kolon SIRASI/İÇERİĞİ. Bu iki şey sessizce bozulduğunda kimse fark etmez:
 *
 *  - Kaçışlama: bir hücrede noktalı virgül/tırnak/satır sonu varsa (ör. hesap alanı,
 *    serbest metin sebep) dosya Excel'de KAYAR — sütunlar birbirine karışır ve mutabakat
 *    yanlış sayılarla yapılır. Formül enjeksiyonu (`=`, `+`, `@` ile başlayan hücre) ise
 *    3. tarafa gönderilen dosyada gerçek bir güvenlik riskidir.
 *  - KVKK varyantı: "tedarikçi/stok" seti müşteri e-postası TAŞIMAMALI. Bir kolon yanlışlıkla
 *    o listeye eklenirse dosya sessizce kişisel veri taşımaya başlar; test bunu kilitler.
 *  - Maske sezgisi: API `masked` bayrağını göndermezse (api/admin dağıtım sapması) maskeli
 *    dosya "düz metin" gibi işaretlenip uyarısız inerdi.
 *
 * NOT: modül `components/inventory/license-export.ts` içinde yaşıyor ama NÖTR (ne 'use client'
 * ne 'use server') — bu yüzden buradan göreli import edilebiliyor (`parse.ts` ile aynı desen).
 */
import { describe, expect, it } from 'vitest';

import { toCsv, toTextList, type CsvColumn } from './csv';
import {
  INVENTORY_EXPORT_VARIANT,
  auditCsvColumns,
  exportNotices,
  inventoryCsvColumns,
  licenseValueText,
  looksMasked,
} from '../components/inventory/license-export';
import type { LicenseInventoryRow } from '../app/stock/license-actions';

/** Test satırı üreticisi — yalnız ilgilenilen alanlar override edilir. */
function row(over: Partial<LicenseInventoryRow> = {}): LicenseInventoryRow {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    productId: '22222222-2222-2222-2222-222222222222',
    productName: 'Windows 11 Pro',
    productSku: 'WIN11P',
    productType: 'key',
    usageMode: 'single',
    status: 'available',
    maxUses: 1,
    useCount: 0,
    remainingUses: 1,
    kind: 'key',
    value: 'AAAA-BBBB-CCCC',
    fields: null,
    batchId: null,
    batchCode: '2026-08-13-A',
    supplierName: 'Acme',
    unitCostCents: 1250,
    costCurrency: 'TRY',
    createdAt: '2026-08-13T10:00:00.000Z',
    delivered: null,
    ...over,
  };
}

const HEADER_LINE = (csv: string): string => csv.split('\r\n')[0]!;
const LINES = (csv: string): string[] => csv.split('\r\n');

describe('toCsv — kaçışlama ve uyarı satırları', () => {
  it('ayraç/tırnak/satır sonu içeren hücre tırnaklanır, içteki tırnak İKİLENİR', () => {
    const cols: CsvColumn<{ v: string }>[] = [{ header: 'Değer', value: (r) => r.v }];
    const csv = toCsv([{ v: 'a;b' }, { v: 'di"yor' }, { v: 'satır\nsonu' }], cols);
    const lines = LINES(csv);
    expect(lines[0]).toBe('Değer');
    expect(lines[1]).toBe('"a;b"');
    expect(lines[2]).toBe('"di""yor"');
    // Satır sonu tırnak İÇİNDE kalır → Excel tek hücre olarak okur (satır kaymaz).
    expect(csv).toContain('"satır\nsonu"');
  });

  it('formül enjeksiyonu: =/+/-/@ ile başlayan hücre tek tırnakla kaçırılır', () => {
    const cols: CsvColumn<{ v: string }>[] = [{ header: 'Değer', value: (r) => r.v }];
    const csv = toCsv([{ v: '=1+1' }, { v: '@SUM(A1)' }, { v: '-5' }, { v: 'normal' }], cols);
    const lines = LINES(csv);
    expect(lines[1]).toBe("'=1+1");
    expect(lines[2]).toBe("'@SUM(A1)");
    expect(lines[3]).toBe("'-5");
    expect(lines[4]).toBe('normal');
  });

  it('uyarı DİZİSİ her biri kendi satırında yazılır; başlık satırı aşağı kayar', () => {
    const cols: CsvColumn<{ v: string }>[] = [{ header: 'A', value: (r) => r.v }];
    const csv = toCsv([{ v: 'x' }], cols, ['UYARI 1', 'UYARI 2']);
    expect(LINES(csv)).toEqual(['UYARI 1', 'UYARI 2', 'A', 'x']);
  });

  it('tekil string uyarı davranışı BİREBİR korunur (mevcut çağıranlar kırılmaz)', () => {
    const cols: CsvColumn<{ v: string }>[] = [{ header: 'A', value: (r) => r.v }];
    expect(LINES(toCsv([{ v: 'x' }], cols, 'TEK UYARI'))).toEqual(['TEK UYARI', 'A', 'x']);
    // Boş uyarı satır AÇMAZ (aksi halde dosya boş bir ilk satırla başlardı).
    expect(LINES(toCsv([{ v: 'x' }], cols, ''))).toEqual(['A', 'x']);
  });
});

describe('envanter kolonları — sıra ve KVKK ayrımı', () => {
  it('stok seti kolon SIRASI sabittir', () => {
    expect(inventoryCsvColumns.map((c) => c.header)).toEqual([
      'Ürün',
      'SKU',
      'Tür',
      'Lisans/Hesap değeri',
      'Durum',
      'Kullanım',
      'Kalan hak',
      'Parti kodu',
      'Tedarikçi',
      'Birim maliyet',
      'Para birimi',
      'Stok ömrü bitişi',
      'Eklenme',
    ]);
  });

  it('KVKK: stok setinde müşteri e-postası / sipariş no YOK, iç denetim setinde VAR', () => {
    const stock = inventoryCsvColumns.map((c) => c.header);
    expect(stock).not.toContain('Müşteri e-postası');
    expect(stock).not.toContain('Mağaza sipariş no');

    const audit = auditCsvColumns.map((c) => c.header);
    expect(audit).toContain('Müşteri e-postası');
    expect(audit).toContain('Mağaza sipariş no');
    // İç denetim seti stok setini KAPSAR (aynı sırayla) — iki liste ayrışamaz.
    expect(audit.slice(0, stock.length)).toEqual(stock);
  });

  it('yalnız iç denetim varyantı KVKK uyarısı taşır', () => {
    expect(INVENTORY_EXPORT_VARIANT.inventory.warning).toBeUndefined();
    expect(INVENTORY_EXPORT_VARIANT.audit.warning).toContain('kişisel veri');
  });

  it('teslimat alanları BOŞ satırda iç denetim hücreleri boş kalır (undefined yazılmaz)', () => {
    const csv = toCsv([row()], auditCsvColumns);
    expect(csv).not.toContain('undefined');
    expect(LINES(csv)[1]!.endsWith(';;;;')).toBe(true); // 5 teslimat kolonu → 4 ayraç + son boş
  });

  it('maliyet KURUŞ→LİRA çevrilir ve para birimi AYRI kolondadır', () => {
    const csv = toCsv([row({ unitCostCents: 1250, costCurrency: 'TRY' })], inventoryCsvColumns);
    const cells = LINES(csv)[1]!.split(';');
    expect(cells[9]).toBe('12,50');
    expect(cells[10]).toBe('TRY');
    // Maliyet YOKSA hücre 0,00 değil BOŞ olmalı (0 ile "bilinmiyor" karışmasın).
    const none = toCsv([row({ unitCostCents: null })], inventoryCsvColumns);
    expect(LINES(none)[1]!.split(';')[9]).toBe('');
  });

  it('MAK dışı kalemde Kullanım/Kalan hak kolonları boş (yanıltıcı 0/1 yazılmaz)', () => {
    const single = LINES(toCsv([row()], inventoryCsvColumns))[1]!.split(';');
    expect(single[5]).toBe('');
    expect(single[6]).toBe('');
    const multi = LINES(
      toCsv([row({ usageMode: 'multi', maxUses: 500, useCount: 3, remainingUses: 497 })], inventoryCsvColumns),
    )[1]!.split(';');
    expect(multi[5]).toBe('3/500');
    expect(multi[6]).toBe('497');
  });
});

describe('licenseValueText — hesap ürünü tek hücreye sığar', () => {
  it('hesap alanları " | " ile birleşir (satır sonu KOYULMAZ)', () => {
    const r = row({
      kind: 'account',
      value: null,
      fields: [
        { key: 'user', label: 'Kullanıcı', value: 'a@b.com', secret: false },
        { key: 'pass', label: 'Parola', value: 'p;1', secret: true },
      ],
    });
    expect(licenseValueText(r)).toBe('Kullanıcı: a@b.com | Parola: p;1');
    // Ayraç içeren değer CSV'de tırnaklanır → sütun kaymaz.
    expect(toCsv([r], inventoryCsvColumns)).toContain('"Kullanıcı: a@b.com | Parola: p;1"');
  });

  it('alanı okunamayan hesap kaydında boş hücre döner (ham JSON dökülmez)', () => {
    expect(licenseValueText(row({ kind: 'account', value: null, fields: null }))).toBe('');
  });
});

describe('looksMasked — API bayrağı yoksa yedek sezgi', () => {
  it('maske gövdesi taşıyan key/hesap satırını yakalar', () => {
    expect(looksMasked([row()])).toBe(false);
    expect(looksMasked([row({ value: '••••••CCCC' })])).toBe(true);
    expect(
      looksMasked([
        row({
          kind: 'account',
          value: null,
          fields: [{ key: 'p', label: 'Parola', value: '••••••', secret: true }],
        }),
      ]),
    ).toBe(true);
  });
});

describe('exportNotices — dosyanın İÇİNE yazılan dürüstlük satırları', () => {
  const base = { masked: false, truncated: false, total: 3, exported: 3, limit: 5000 };

  it('temiz stok dosyasında hiç uyarı yok', () => {
    expect(exportNotices({ variant: 'inventory', ...base })).toEqual([]);
  });

  it('iç denetim + maskeli + kırpılmış → üç uyarı da dosyaya girer', () => {
    const out = exportNotices({
      variant: 'audit',
      masked: true,
      truncated: true,
      total: 9000,
      exported: 5000,
      limit: 5000,
    });
    expect(out).toHaveLength(3);
    expect(out[0]).toContain('kişisel veri');
    expect(out[1]).toContain('MASKELİ');
    expect(out[2]).toContain('9000');
    expect(out[2]).toContain('5000');
  });
});

describe('toTextList — bir kayıt = bir satır', () => {
  it('serbest metindeki satır sonu tek boşluğa iner (numaralı liste kaymaz)', () => {
    const out = toTextList(
      [row({ productName: 'Windows\n11 Pro' })],
      INVENTORY_EXPORT_VARIANT.inventory.line,
      ['başlık'],
    );
    const lines = out.split('\r\n');
    expect(lines[0]).toBe('başlık');
    expect(lines[1]).toBe('');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toContain('Windows 11 Pro');
  });
});
