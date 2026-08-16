import { describe, expect, it } from 'vitest';
import { PRODUCT_FORM_FIELDS, ProductFormError, buildProductBody } from './product-form-body';

/**
 * Bu testler bir GERÇEK kusurdan doğdu: form `<select name="guideId">` alanını basıyordu,
 * gövde kurucusu onu HİÇ okumuyordu. Operatör kurulum rehberini seçip kaydediyor, ekran
 * yeşil sonuç veriyor, `products.guide_id` NULL kalıyor, rehber müşteriye HİÇ ulaşmıyordu.
 * typecheck ve `next build` temizdi — çünkü fonksiyon `'use server'` dosyasında olduğu için
 * test EDİLEMİYORDU. Aşağıdaki ilk test o sınıfı bir daha kaçırmaz: formdaki her alan adı
 * gövdeye ULAŞMALI.
 */

/** Formu doldurulmuş gibi kurar; `overrides` ile alan boşaltılabilir/değiştirilebilir. */
function form(overrides: Record<string, string | null> = {}): FormData {
  const base: Record<string, string> = {
    sku: 'OFF365',
    name: 'Office 365',
    kind: 'account',
    usageMode: 'single',
    fulfillmentPolicy: 'partial-auto',
    onExpiry: 'hide',
    categoryId: '11111111-1111-1111-1111-111111111111',
    guideId: '22222222-2222-2222-2222-222222222222',
    validityDays: '365',
    warrantyDays: '30',
    lowStockThreshold: '5',
    keyFormat: '^[A-Z0-9-]+$',
    payloadSchema: '[{"key":"username","label":"Kullanıcı adı","secret":false,"required":true}]',
  };
  const fd = new FormData();
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== null) fd.set(k, v);
  }
  return fd;
}

describe('buildProductBody — form alanı kapsamı', () => {
  it('formdaki HER alan gövdeye ulaşır (sessizce düşen alan yok)', () => {
    const body = buildProductBody(form({ usageMode: 'multi', maxUses: '500', stockless: 'on', releaseAt: '2026-09-01T10:00' }), true);
    // `payloadSchema` yalnız kind='account' iken, `maxUses` yalnız usageMode='multi' iken
    // gönderilir — kurulum ikisini de sağlıyor, yani listenin tamamı beklenmeli.
    for (const field of PRODUCT_FORM_FIELDS) {
      expect(body, `"${field}" alanı gövdeye hiç ulaşmıyor`).toHaveProperty(field);
    }
  });
});

describe('buildProductBody — kurulum rehberi (guideId)', () => {
  it('create: seçilen rehber gövdeye girer', () => {
    expect(buildProductBody(form()).guideId).toBe('22222222-2222-2222-2222-222222222222');
  });

  it('create: "Rehber gönderme" seçiliyken alan HİÇ gönderilmez (DB default null)', () => {
    expect(buildProductBody(form({ guideId: '' }))).not.toHaveProperty('guideId');
  });

  it('update: "Rehber gönderme" seçilince açık null gider (bağ GERÇEKTEN kalkar)', () => {
    // Kritik: `undefined` bırakılsaydı API `.partial()` alanı "değişmedi" sayar ve
    // müşteriye YANLIŞ ürünün talimatı gitmeye devam ederdi.
    expect(buildProductBody(form({ guideId: '' }), true).guideId).toBeNull();
  });

  it('update: rehber değiştirilebilir', () => {
    const body = buildProductBody(form({ guideId: '33333333-3333-3333-3333-333333333333' }), true);
    expect(body.guideId).toBe('33333333-3333-3333-3333-333333333333');
  });
});

describe('buildProductBody — kategori ile simetri', () => {
  it('kategori ve rehber aynı kuralı izler (create atlar, update null gönderir)', () => {
    const created = buildProductBody(form({ categoryId: '', guideId: '' }));
    expect(created).not.toHaveProperty('categoryId');
    expect(created).not.toHaveProperty('guideId');

    const updated = buildProductBody(form({ categoryId: '', guideId: '' }), true);
    expect(updated.categoryId).toBeNull();
    expect(updated.guideId).toBeNull();
  });
});

describe('buildProductBody — mevcut davranış korunuyor', () => {
  it('stockless işaretsizken false', () => {
    expect(buildProductBody(form()).stockless).toBe(false);
  });

  it('multi olmayan üründe maxUses gönderilmez', () => {
    expect(buildProductBody(form({ maxUses: '500' }))).not.toHaveProperty('maxUses');
  });

  it('lowStockThreshold=0 geçerli değerdir (uyarı kapalı ile karıştırılmaz)', () => {
    expect(buildProductBody(form({ lowStockThreshold: '0' })).lowStockThreshold).toBe(0);
  });

  it('key tipinde payloadSchema hiç gönderilmez', () => {
    expect(buildProductBody(form({ kind: 'key' }))).not.toHaveProperty('payloadSchema');
  });
});

/**
 * SESSİZ VERİ KAYBI (denetim C12). Eski davranış: bozuk girdi YUTULUYOR, alan gövdeye hiç
 * girmiyordu. Create'te API refine'ı bunu yakalıyordu ama UPDATE DTO'su `.partial()` olduğu
 * için alanın yokluğu "değişmedi" demek → API 200, form yeşil, DÜZENLEME KAYBOLMUŞ.
 * Bu testler yutmanın geri gelmesini engeller.
 */
describe('buildProductBody — bozuk girdi sessizce yutulmaz', () => {
  it('bozuk payloadSchema hata fırlatır (create)', () => {
    expect(() => buildProductBody(form({ payloadSchema: '{bozuk' }))).toThrow(ProductFormError);
  });

  it('bozuk payloadSchema hata fırlatır (update) — asıl veri kaybı yolu', () => {
    // Kritik: burada YUTULSAYDI istek `payloadSchema` alanı OLMADAN giderdi, API 200 dönerdi
    // ve operatörün hesap-alan düzenlemesi hiçbir iz bırakmadan kaybolurdu.
    expect(() => buildProductBody(form({ payloadSchema: '{bozuk' }), true)).toThrow(
      /Hesap alanları okunamadı/,
    );
  });

  it('geçersiz releaseAt hata fırlatır (create)', () => {
    expect(() => buildProductBody(form({ releaseAt: 'olmayan-tarih' }))).toThrow(ProductFormError);
  });

  it('geçersiz releaseAt hata fırlatır (update) — mevcut tarih SİLİNMEZ', () => {
    // Eski davranışta `releaseAt: null` gönderiliyordu, yani bozuk bir girdi kayıtlı ön
    // sipariş tarihini sessizce siliyordu.
    expect(() => buildProductBody(form({ releaseAt: 'olmayan-tarih' }), true)).toThrow(
      /Ön sipariş tarihi okunamadı/,
    );
  });

  it('geçerli değerlerde hâlâ fırlatmaz (yanlış pozitif yok)', () => {
    expect(() => buildProductBody(form({ releaseAt: '2026-09-01T10:00' }), true)).not.toThrow();
    // Boş releaseAt geçerlidir: update'te "temizle" anlamına gelir (açık null).
    expect(buildProductBody(form({ releaseAt: '' }), true).releaseAt).toBeNull();
  });
});
