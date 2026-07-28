import { describe, expect, it } from 'vitest';
import { productCapacityChange } from './products.service';

/**
 * Ürün güncellemesinin kapasiteye etkisi (§11) — `products.update` 409 guard'ının KARAR
 * fonksiyonu.
 *
 * REGRESYON KAYNAĞI (re-doğrulama bulgusu): guard önce "stokta anahtar VARKEN usage_mode
 * veya max_uses değişemez" diyordu; bu FAZLA GENİŞTİ ve mevcut stoğu ETKİLEMEYEN meşru
 * düzenlemeleri de blokluyordu (en belirgini: MAK ürününde kapasiteyi ARTIRMAK).
 * `license_items.max_uses` import anında yazılan bir ANLIK GÖRÜNTÜdür — ürün satırını
 * güncellemek mevcut kalemlerin kapasitesini değiştirmez; dolayısıyla yalnız kapasite
 * DÜŞÜRME (multi→single dahil) veri bozar.
 *
 * `reduced=false` → guard hiç çalışmaz (stok sorgusu bile yapılmaz);
 * `reduced=true`  → yalnız o zaman "kapasitesi kaybolacak canlı kalem var mı" bakılır.
 */
describe('products: productCapacityChange (kapasite guard karar fonksiyonu)', () => {
  it('MAK kapasitesini ARTIRMAK kısıtlanmaz (500 → 800)', () => {
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'multi', maxUses: 800 },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 800, reduced: false });
  });

  it('usageMode değişmeden yapılan düzenleme (ad/eşik) kapasiteye dokunmaz', () => {
    // Admin formu her kaydetmede usageMode + maxUses'i AYNI değerle geri gönderir.
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'multi', maxUses: 500 },
    );
    expect(c.reduced).toBe(false);
  });

  it('tek kullanımlık üründe alan düzenlemesi (maxUses hiç gönderilmez) serbesttir', () => {
    const c = productCapacityChange({ usageMode: 'single', maxUses: null }, { name: 'yeni ad' });
    expect(c).toEqual({ currentCapacity: 1, nextCapacity: 1, reduced: false });
  });

  it('single → multi kapasiteyi ARTIRIR, kısıtlanmaz', () => {
    const c = productCapacityChange(
      { usageMode: 'single', maxUses: null },
      { usageMode: 'multi', maxUses: 500 },
    );
    expect(c).toEqual({ currentCapacity: 1, nextCapacity: 500, reduced: false });
  });

  it('MAK kapasitesini DÜŞÜRMEK veri bozan geçiştir (500 → 100)', () => {
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'multi', maxUses: 100 },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 100, reduced: true });
  });

  it('multi → single veri bozan geçiştir (maxUses gönderilmese bile)', () => {
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'single' },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 1, reduced: true });
  });

  it('multi ürünün kapasitesi açıkça null yapılırsa kapasite 1e düşer (veri bozan)', () => {
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { maxUses: null },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 1, reduced: true });
  });

  it('single → single (maxUses 1 gönderilse bile) kapasite değişmez', () => {
    const c = productCapacityChange(
      { usageMode: 'single', maxUses: 1 },
      { usageMode: 'single', maxUses: 1 },
    );
    expect(c.reduced).toBe(false);
  });
});
