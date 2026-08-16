import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { DeliveryMailBuilder } from './delivery-mail.builder';
import type { CryptoService } from '../crypto/crypto.service';
import type { Database } from '../db/db.module';
import type { TemplatesService } from './templates.service';

/**
 * Gövde üretiminin (gerçek gönderim = panel önizlemesi) DAVRANIŞ kilidi.
 *
 * NEDEN BU TEST VAR: teslimat maili artık İKİ yerden isteniyor (BullMQ worker gönderirken,
 * operatör sipariş detayından önizlerken). Bu projede "aynı şeyin iki uygulaması" tekrar eden
 * bir hata sınıfıdır (mail ile müşteri sayfası bir kez ayrışmıştı). Burada kilitlenen invaryant:
 *   1) `reveal:true` → gövde DÜZ METİN sır taşır (müşteri kendi lisansını maskeli alamaz),
 *   2) `reveal:false` → key maskeli; hesap ürününde secret alan KUYRUKSUZ maskeli, secret
 *      OLMAYAN alan (kullanıcı adı) okunur kalır — ve iki çıktının GERİ KALANI birebir aynıdır
 *      (aynı şablon, aynı sıra, aynı rehber yerleşimi),
 *   3) şeması çözülemeyen `account` payload'ında maske KUYRUKSUZDUR (parolanın son 4 hanesi
 *      `maskSecret` ile sızmaz — fail-safe yön),
 *   4) aktif atama yoksa BOŞ mail üretilmez (`ok:false`).
 *
 * PG/SMTP GEREKMEZ: db/crypto/templates/config sahte verilir.
 */

/** Bir sorgu zincirini (select…from…join…where…orderBy) taklit eden sahte, sonucu sabit. */
function chain(result: unknown[]): Record<string, unknown> {
  const self: Record<string, unknown> = {};
  for (const m of ['from', 'innerJoin', 'leftJoin', 'where', 'orderBy', 'limit']) {
    self[m] = () => self;
  }
  // await edilebilir olsun: son halka Promise gibi davranır (drizzle builder'ı thenable'dır).
  self.then = (res: (v: unknown[]) => unknown) => Promise.resolve(result).then(res);
  return self;
}

/**
 * Sahte db: çağrı SIRASINA göre sonuç döndürür (builder'ın sorgu sırası sabittir:
 * orders → sites → atamalar → rehberler).
 */
function fakeDb(results: unknown[][]): Database {
  let i = 0;
  const next = () => chain(results[i++] ?? []);
  return {
    select: () => next(),
    selectDistinct: () => next(),
  } as unknown as Database;
}

const crypto = {
  // Testte ciphertext = düz metin (AES yolunu değil, MASKELEME/render yolunu sınıyoruz).
  decrypt: (enc: string) => enc,
} as unknown as CryptoService;

const templates = {
  resolve: () =>
    Promise.resolve({ subject: 'Siparişiniz hazır — {{order_no}}', body: 'Merhaba,\n\n{{items}}\n' }),
} as unknown as TemplatesService;

const config = { getOrThrow: () => 'panel@example.com' } as unknown as ConfigService;

const order = {
  id: 'o-1',
  siteId: 's-1',
  remoteOrderId: '1042',
  customerEmail: 'musteri@example.com',
};

/** Tek anahtarlı (kind=key) sipariş. */
const keyRow = {
  units: 1,
  validUntil: null,
  payloadEnc: 'AAAA-BBBB-CCCC-V66T',
  licenseItemId: 'li-1',
  productName: 'Windows 11 Pro',
  productId: 'p-1',
  productKind: 'key',
  payloadSchema: null,
};

/** Hesap ürünü: kullanıcı adı (açık) + parola (secret). */
const accountRow = {
  units: 1,
  validUntil: null,
  payloadEnc: JSON.stringify({ kullanici: 'ofis@example.com', sifre: 'GizliParola123' }),
  licenseItemId: 'li-2',
  productName: 'Office 365',
  productId: 'p-2',
  productKind: 'account',
  payloadSchema: [
    { key: 'kullanici', label: 'Kullanıcı adı', secret: false, required: true },
    { key: 'sifre', label: 'Parola', secret: true, required: true },
  ],
};

function build(rows: unknown[], reveal: boolean) {
  const builder = new DeliveryMailBuilder(
    fakeDb([[order], [{ domain: 'ornek-site.com', sandbox: false }], rows, []]),
    crypto,
    templates,
    config,
  );
  return builder.build('o-1', { reveal });
}

describe('DeliveryMailBuilder — gönderim ve önizleme TEK render yolu', () => {
  it('reveal:true → gövde düz metin anahtar taşır (müşteriye giden mail)', async () => {
    const res = await build([keyRow], true);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content.text).toContain('AAAA-BBBB-CCCC-V66T');
    expect(res.content.masked).toBe(false);
    // Şablon çözümü/değişken doldurma da aynı yoldan: konu render edilmiş olmalı.
    expect(res.content.subject).toBe('Siparişiniz hazır — 1042');
    expect(res.content.to).toBe('musteri@example.com');
  });

  it('reveal:false → anahtar MASKELİ, gövdenin geri kalanı birebir aynı', async () => {
    const open = await build([keyRow], true);
    const masked = await build([keyRow], false);
    expect(open.ok && masked.ok).toBe(true);
    if (!open.ok || !masked.ok) return;

    expect(masked.content.text).not.toContain('AAAA-BBBB-CCCC-V66T');
    // key maskesi: sabit gövde + son 4 hane (hangi anahtar olduğu ayırt edilebilir kalır).
    expect(masked.content.text).toContain('••••••V66T');
    expect(masked.content.masked).toBe(true);
    // Aynı şablon/aynı iskelet: iki çıktı YALNIZ sır alanında ayrışmalı.
    expect(masked.content.subject).toBe(open.content.subject);
    expect(masked.content.text.replace('••••••V66T', 'AAAA-BBBB-CCCC-V66T')).toBe(
      open.content.text,
    );
  });

  it('hesap ürününde maske ALAN-FARKINDA: parola kuyruksuz, kullanıcı adı okunur', async () => {
    const res = await build([accountRow], false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content.text).toContain('Kullanıcı adı: ofis@example.com');
    expect(res.content.text).toContain('Parola: ••••••');
    // Parolanın hiçbir parçası (son 4 hane dahil) sızmamalı.
    expect(res.content.text).not.toContain('GizliParola123');
    expect(res.content.text).not.toContain('a123');
  });

  it('şeması ÇÖZÜLEMEYEN hesap payload’ında maske KUYRUKSUZDUR (fail-safe)', async () => {
    // payloadSchema bozuk/eksik → `AccountPayloadSchema.safeParse` başarısız → düz payload dalı.
    // `maskSecret` burada kanonik JSON'un kuyruğunu (= parolanın sonu + '"}') bırakırdı.
    const broken = { ...accountRow, payloadSchema: null };
    const res = await build([broken], false);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.content.text).toContain('••••••');
    expect(res.content.text).not.toContain('GizliParola123');
    expect(res.content.text).not.toMatch(/••••••\S/); // kuyruk YOK
  });

  it('aktif atama yoksa BOŞ mail üretilmez', async () => {
    const res = await build([], true);
    expect(res).toEqual({ ok: false, reason: 'no-active-assignments' });
  });
});
