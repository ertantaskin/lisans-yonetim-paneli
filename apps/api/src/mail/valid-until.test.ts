import { describe, expect, it } from 'vitest';
import { earliestValidUntil, formatValidUntil } from './mail.processor';

/**
 * Teslimat mailinde geçerlilik bitişi (§11 süreli hesap) — denetim D3.
 *
 * Sorgu `valid_until`i SÜZGEÇTE kullanıyor ama SEÇMİYORDU → şablona `{{valid_until}}`
 * yazan operatör sessizce boş string alıyordu; müşteri tarihi My Account'ta görüyor,
 * mailde göremiyordu. Bu iki saf yardımcı o değişkenin karar mantığıdır.
 */
describe('formatValidUntil', () => {
  // NOT: biçimlendirme YEREL saat dilimine göredir (konteyner TZ=Europe/Istanbul) — panelin
  // gösterdiği gün sınırıyla aynı olsun diye bilinçli. Bu yüzden assert'ler öğle vakti UTC
  // kullanır (±11 saatlik hiçbir dilimde gün DEĞİŞMEZ) → test makineden bağımsızdır.
  it('tarihi gün.ay.yıl olarak yazar', () => {
    expect(formatValidUntil(new Date('2026-09-01T12:00:00Z'))).toBe('01.09.2026');
  });

  it('ISO string kabul eder (sürücü Date yerine string döndürebilir)', () => {
    expect(formatValidUntil('2026-12-31T12:00:00Z')).toBe('31.12.2026');
  });

  it('boş/geçersiz değerde MAİLİ DÜŞÜRMEZ, boş string döner', () => {
    // Kritik olmayan bir alan yüzünden teslimat maili asla başarısız olmamalı.
    expect(formatValidUntil(null)).toBe('');
    expect(formatValidUntil(undefined)).toBe('');
    expect(formatValidUntil('tarih-degil')).toBe('');
  });
});

describe('earliestValidUntil', () => {
  it('kalemler arasındaki EN YAKIN bitişi seçer', () => {
    const a = new Date('2026-10-01T00:00:00Z');
    const b = new Date('2026-09-01T00:00:00Z');
    const c = new Date('2026-11-01T00:00:00Z');
    expect(earliestValidUntil([a, b, c])).toBe(b);
  });

  it('null kalemleri atlar (süresiz ürün karışık siparişte olabilir)', () => {
    const a = new Date('2026-10-01T00:00:00Z');
    expect(earliestValidUntil([null, a, undefined])).toBe(a);
  });

  it('hiç süreli kalem yoksa null döner (şablon değişkeni boş kalır)', () => {
    expect(earliestValidUntil([null, undefined])).toBeNull();
    expect(earliestValidUntil([])).toBeNull();
  });
});
