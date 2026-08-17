import { describe, expect, it } from 'vitest';
import { unitLabel } from './mail-render';

/**
 * TESLİMAT MAİLİNDEKİ BİRİM ETİKETİ — MAK/çok kullanımlık ürünün müşteriye ne söylediği.
 *
 * NEDEN TEST EDİLİYOR (ölçülmüş şikâyet, dev sipariş #69): 6 birimlik bir MAK siparişi iki
 * anahtara bölünmüştü (5 + 1) ve mail şunu yazıyordu:
 *
 *     • Windows 11 Pro MAK (Toplu Lisans) (5 adet): MAK-AAAA-BBBB-CCCC-0003
 *     • Windows 11 Pro MAK (Toplu Lisans): MAK-FINAL-0001
 *
 * İki ayrı yanlış: "adet" ANAHTAR SAYISI gibi okunuyor (müşteri 5 anahtar aldığını sanıyor) ve
 * `units = 1` olan ikinci anahtarda HİÇBİR ŞEY yazmıyor (müşteri o anahtarın tamamen kendisine
 * ait olduğunu sanıyor — oysa MAK anahtarı PAYLAŞIMLIDIR, panel yalnız defter tutar).
 *
 * KİLİTLENEN DAVRANIŞ: karar `units`e değil ÜRÜNÜN KULLANIM MODUNA bağlıdır.
 */
describe('unitLabel (mail kalem satırı birim etiketi)', () => {
  it('MAK: units=1 olsa BİLE etkinleştirme hakkını yazar', () => {
    // Eski kural (`units > 1`) burada boş string döndürüyordu — kullanıcının bildirdiği
    // "ikinci anahtar çıplak görünüyor" durumu tam olarak buydu.
    expect(unitLabel(1, 'multi', 'key')).toBe(' (bu siparişte 1 etkinleştirme hakkı)');
  });

  it('MAK: çoklu birimde "adet" DEMEZ (anahtar sayısıyla karıştırılıyordu)', () => {
    const out = unitLabel(5, 'multi', 'key');
    expect(out).toBe(' (bu siparişte 5 etkinleştirme hakkı)');
    expect(out).not.toContain('adet');
  });

  it('MAK + hesap ürünü: "etkinleştirme" yerine "kullanım hakkı" (hesap açılır, etkinleştirilmez)', () => {
    expect(unitLabel(3, 'multi', 'account')).toBe(' (bu siparişte 3 kullanım hakkı)');
  });

  it('tek kullanımlık: hiçbir şey yazmaz (units zaten daima 1)', () => {
    expect(unitLabel(1, 'single', 'key')).toBe('');
    // Tek kullanımlıkta units>1 oluşamaz; oluşsa bile ürün modu YETKİLİDİR (sessizce
    // "etkinleştirme hakkı" yazıp müşteriyi yanıltmaz).
    expect(unitLabel(4, 'single', 'key')).toBe('');
  });

  it('mod bilinmiyorsa ESKİ davranışa düşer (kritik olmayan etiket maili bozmaz)', () => {
    // Ürün satırı çözülemeyen kenar durum: yeni bir varsayım dayatmak yerine eski çıktı.
    expect(unitLabel(3, null, 'key')).toBe(' (3 adet)');
    expect(unitLabel(1, undefined, 'key')).toBe('');
  });
});
