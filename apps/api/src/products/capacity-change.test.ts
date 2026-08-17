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
 * güncellemek mevcut kalemlerin kapasitesini değiştirmez.
 *
 * GÜNCEL KURAL (kapasite artık anahtar başına verilebiliyor): ürün alanı bir VARSAYILANDIR,
 * bağlayıcı tavan değil → sayıyı düşürmek de artırmak da mevcut anahtarları etkilemez.
 * Veri bozan TEK geçiş **multi → single**'dır: `allocate()` tek-kullanım dalına düşer ve
 * anahtarın TAMAMINI tek birim sayar (anahtar başına N−1 kullanım kalıcı kaybolur).
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
    const c = productCapacityChange({ usageMode: 'single', maxUses: null }, {});
    expect(c).toEqual({ currentCapacity: 1, nextCapacity: 1, reduced: false });
  });

  it('single → multi kapasiteyi ARTIRIR, kısıtlanmaz', () => {
    const c = productCapacityChange(
      { usageMode: 'single', maxUses: null },
      { usageMode: 'multi', maxUses: 500 },
    );
    expect(c).toEqual({ currentCapacity: 1, nextCapacity: 500, reduced: false });
  });

  it('MAK VARSAYILANINI düşürmek serbesttir (500 → 100) — satırlar kendi kapasitesini taşır', () => {
    /*
     * DAVRANIŞ DEĞİŞİKLİĞİ (kullanıcı isteğiyle): kapasite artık stok girişinde ANAHTAR
     * BAŞINA verilebiliyor, ürün alanı yalnız VARSAYILAN. `license_items.max_uses` satırın
     * kendi değeridir ve atama/stok/rapor yollarının hepsi ORADAN okur → ürün varsayılanını
     * düşürmek mevcut anahtarların kalan hakkını YOK ETMEZ, yalnız sonraki girişleri etkiler.
     * Eskiden bu 409'lanıyordu ve 50'lik lot almaya başlayan operatörü kilitliyordu.
     */
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'multi', maxUses: 100 },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 100, reduced: false });
  });

  it('multi → single veri bozan geçiştir (maxUses gönderilmese bile)', () => {
    const c = productCapacityChange(
      { usageMode: 'multi', maxUses: 500 },
      { usageMode: 'single' },
    );
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 1, reduced: true });
  });

  it('multi kalırken kapasite null yapılsa bile mevcut anahtarlar bozulmaz (import guard ayrı korur)', () => {
    // Mod DEĞİŞMİYOR → allocate() hâlâ multi dalında ve satırın kendi max_uses'ini kullanıyor.
    // Ürünü kapasitesiz bırakmak yalnız YENİ girişleri engeller (stock.import 400 verir),
    // stoktaki anahtarların hakkını yok etmez → veri bozan geçiş DEĞİLDİR.
    const c = productCapacityChange({ usageMode: 'multi', maxUses: 500 }, { maxUses: null });
    expect(c).toEqual({ currentCapacity: 500, nextCapacity: 1, reduced: false });
  });

  it('single → single (maxUses 1 gönderilse bile) kapasite değişmez', () => {
    const c = productCapacityChange(
      { usageMode: 'single', maxUses: 1 },
      { usageMode: 'single', maxUses: 1 },
    );
    expect(c.reduced).toBe(false);
  });
});
