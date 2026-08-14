/**
 * HANGİ REGRESYONU YAKALAR: bu modül "DOLDURMA HEDEFİ" kavramının TEK tanımıdır ve tam da
 * o tanım ikiye ayrıldığı için bir bedava-lisans (H1) sınıfı hata yeniden açılmıştı:
 * per-atama iptalde `qty` düşürülünce aynı kolon hem MAĞAZA GERÇEĞİ hem DOLDURMA HEDEFİ
 * anlamına geliyordu; mağazadan gelen re-push (`reconcileOrder`) `qty`yi geri yükseltiyor ve
 * partial-auto iptal edilen birime TAZE anahtar teslim ediyordu. Çözüm ayrı defter
 * (`order_lines.canceled_units`, migration 0036) + hedefin TEK noktada türetilmesiydi.
 *
 * Buradaki testler o tek tanımı kilitler: hedef = `qty − canceled_units` (asla negatif değil),
 * kalan = hedef − teslim edilen, ve `lineStatusFor`ın ÜÇ dalı — özellikle hedef 0 iken satırın
 * 'fulfilled' sayılması (belgesiz kenar durum: tamamı iptal edilmiş satır sweep'lere
 * "doldurulacak iş" olarak görünmemeli).
 */
import { describe, expect, it } from 'vitest';

import { fillTarget, lineStatusFor, remainingUnits } from './fill-target';

describe('fillTarget', () => {
  it('hedef = qty − canceledUnits', () => {
    expect(fillTarget({ qty: 3, canceledUnits: 1 })).toBe(2);
  });

  it('canceledUnits yoksa (null/undefined) hedef = qty', () => {
    expect(fillTarget({ qty: 5 })).toBe(5);
    expect(fillTarget({ qty: 5, canceledUnits: null })).toBe(5);
    expect(fillTarget({ qty: 5, canceledUnits: 0 })).toBe(5);
  });

  it('tamamı iptal → hedef 0', () => {
    expect(fillTarget({ qty: 2, canceledUnits: 2 })).toBe(0);
  });

  it('canceledUnits > qty → hedef 0, NEGATİF DEĞİL', () => {
    // Mağaza adedi sonradan düşerse defter geçici olarak qty'yi aşabilir; negatif bir hedef
    // `remainingUnits`i şişirir ve "eksik teslimat" yanılsaması üretirdi.
    expect(fillTarget({ qty: 1, canceledUnits: 5 })).toBe(0);
  });

  it('qty 0 → hedef 0', () => {
    expect(fillTarget({ qty: 0 })).toBe(0);
    expect(fillTarget({ qty: 0, canceledUnits: 3 })).toBe(0);
  });
});

describe('remainingUnits', () => {
  it('kalan = hedef − teslim edilen', () => {
    expect(remainingUnits({ qty: 3, canceledUnits: 1, fulfilledQty: 0 })).toBe(2);
    expect(remainingUnits({ qty: 3, canceledUnits: 1, fulfilledQty: 1 })).toBe(1);
    expect(remainingUnits({ qty: 3, canceledUnits: 1, fulfilledQty: 2 })).toBe(0);
  });

  it('aşırı teslimatta kalan 0 (negatif değil)', () => {
    // İptal, teslim edilmiş birimden SONRA gelirse fulfilled > hedef olabilir.
    expect(remainingUnits({ qty: 3, canceledUnits: 2, fulfilledQty: 3 })).toBe(0);
  });

  it('hedef 0 iken kalan 0 → partial-auto TAZE anahtar aramaz (H1 koruması)', () => {
    expect(remainingUnits({ qty: 3, canceledUnits: 3, fulfilledQty: 0 })).toBe(0);
  });

  it('iptalsiz satırda kalan = qty − fulfilled', () => {
    expect(remainingUnits({ qty: 5, fulfilledQty: 2 })).toBe(3);
  });
});

describe('lineStatusFor', () => {
  it('hiç teslim edilmemiş + hedef > 0 → pending', () => {
    expect(lineStatusFor({ qty: 3, fulfilledQty: 0 })).toBe('pending');
    expect(lineStatusFor({ qty: 3, canceledUnits: 1, fulfilledQty: 0 })).toBe('pending');
  });

  it('kısmen teslim → partial', () => {
    expect(lineStatusFor({ qty: 3, fulfilledQty: 1 })).toBe('partial');
    expect(lineStatusFor({ qty: 3, canceledUnits: 1, fulfilledQty: 1 })).toBe('partial');
  });

  it('hedefe ulaşıldı → fulfilled', () => {
    expect(lineStatusFor({ qty: 3, fulfilledQty: 3 })).toBe('fulfilled');
    // İptal hedefi düşürdüğü için satır ERKEN tamamlanır (kalan birim doldurulmaz).
    expect(lineStatusFor({ qty: 3, canceledUnits: 1, fulfilledQty: 2 })).toBe('fulfilled');
  });

  it('hedefin üstünde teslim → yine fulfilled (>= karşılaştırması)', () => {
    expect(lineStatusFor({ qty: 3, canceledUnits: 2, fulfilledQty: 3 })).toBe('fulfilled');
  });

  /**
   * KENAR DURUM (belgesiz kalmasın): teslim edilen 0 ve hedef 0 → 'fulfilled'.
   * `fulfilledQty >= target` kontrolü `0 >= 0` olduğu için 'pending' dalına HİÇ girmez.
   * Doğru davranış budur: tamamı iptal edilmiş satır bekleyen iş değildir; 'pending'
   * dönseydi partial-auto/"Kalanları Ata" onu sonsuza dek doldurulacak iş sayardı.
   */
  it('fulfilled=0 & hedef=0 → fulfilled (pending DEĞİL)', () => {
    expect(lineStatusFor({ qty: 2, canceledUnits: 2, fulfilledQty: 0 })).toBe('fulfilled');
    expect(lineStatusFor({ qty: 0, fulfilledQty: 0 })).toBe('fulfilled');
    expect(lineStatusFor({ qty: 1, canceledUnits: 9, fulfilledQty: 0 })).toBe('fulfilled');
  });
});
