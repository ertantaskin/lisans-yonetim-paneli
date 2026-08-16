import { describe, expect, it } from 'vitest';
import { DELIVERY_TEMPLATE_SAMPLE_VARS } from '@lisans/shared';
import { earliestValidUntil, formatValidUntil, formatValidUntilIso } from './mail.processor';

/**
 * Teslimat mailinde geçerlilik bitişi (§11 süreli hesap) — denetim D3.
 *
 * Sorgu `valid_until`i SÜZGEÇTE kullanıyor ama SEÇMİYORDU → şablona `{{valid_until}}`
 * yazan operatör sessizce boş string alıyordu; müşteri tarihi My Account'ta görüyor,
 * mailde göremiyordu. Bu iki saf yardımcı o değişkenin karar mantığıdır.
 */
/**
 * Biçim sözleşmesi: `gg.aa.yyyy SS:dd (UTC±hh:mm)`.
 *
 * Saat ve saat dilimi ETİKETİ zorunludur: mail YALNIZ gün yazarken müşteri sayfası mağazanın
 * saat diliminde SAATLİ yazıyordu → aynı `valid_until` iki yüzeyde FARKLI GÜN görünebiliyordu
 * (`2026-08-16T22:30Z`: mail "17.08.2026", sayfa "16.08.2026 22:30"). Bu regex, eski
 * (yalnız tarihli) çıktıyla EŞLEŞMEZ → düzeltme geri alınırsa test KIRMIZI olur.
 */
const FORMAT_RE = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2} \(UTC[+-]\d{2}:\d{2}\)$/;

describe('formatValidUntil', () => {
  // NOT: biçimlendirme YEREL saat dilimine göredir (konteyner TZ=Europe/Istanbul) — panelin
  // gösterdiği gün sınırıyla aynı olsun diye bilinçli. Bu yüzden assert'ler öğle vakti UTC
  // kullanır (±11 saatlik hiçbir dilimde gün DEĞİŞMEZ) → test makineden bağımsızdır.
  it('tarih + SAAT + saat dilimi yazar (belirsizlik bırakmaz)', () => {
    const d = new Date('2026-09-01T12:00:00Z');
    const out = formatValidUntil(d);
    expect(out).toMatch(FORMAT_RE);
    expect(out.startsWith('01.09.2026 ')).toBe(true);
    // Saat YEREL dilimde okunmalı — mailin anlattığı an, panelin gösterdiği anla aynı.
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    expect(out).toContain(` ${hh}:${mm} (UTC`);
  });

  it('ISO string kabul eder (sürücü Date yerine string döndürebilir)', () => {
    const out = formatValidUntil('2026-12-31T12:00:00Z');
    expect(out).toMatch(FORMAT_RE);
    expect(out.startsWith('31.12.2026 ')).toBe(true);
  });

  it('boş/geçersiz değerde MAİLİ DÜŞÜRMEZ, boş string döner', () => {
    // Kritik olmayan bir alan yüzünden teslimat maili asla başarısız olmamalı.
    expect(formatValidUntil(null)).toBe('');
    expect(formatValidUntil(undefined)).toBe('');
    expect(formatValidUntil('tarih-degil')).toBe('');
  });

  it('şablon ÖNİZLEMESİNİN örnek değeri gerçek çıktıyla AYNI biçimde', () => {
    // Örnek ile gerçek çıktının ayrışması bu projede yaşanmış bir sapmadır: önizleme saat
    // gösterirken gönderilen mail yalnız gün yazıyordu. Sözlük tek kaynak olduğu için
    // biçimi de o kaynakla kilitliyoruz.
    expect(DELIVERY_TEMPLATE_SAMPLE_VARS.valid_until).toMatch(FORMAT_RE);
  });
});

describe('formatValidUntilIso', () => {
  it('yoruma kapalı ISO 8601 (UTC) döndürür', () => {
    expect(formatValidUntilIso(new Date('2026-09-01T12:00:00Z'))).toBe('2026-09-01T12:00:00.000Z');
    expect(formatValidUntilIso('2026-12-31T12:00:00Z')).toBe('2026-12-31T12:00:00.000Z');
  });

  it('boş/geçersiz değerde boş string (mail düşmez)', () => {
    expect(formatValidUntilIso(null)).toBe('');
    expect(formatValidUntilIso('tarih-degil')).toBe('');
  });

  it('örnek değer gerçekten ayrıştırılabilir ISO (önizleme ile çıktı ayrışmasın)', () => {
    const sample = DELIVERY_TEMPLATE_SAMPLE_VARS.valid_until_iso!;
    expect(formatValidUntilIso(sample)).toBe(sample);
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
