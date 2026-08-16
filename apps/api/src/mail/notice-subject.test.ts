import { describe, expect, it } from 'vitest';
import {
  isDeliverySubject,
  NOTICE_SUBJECT_PREFIXES,
  ORDER_NOTICE_SUBJECT_PREFIX,
  REPLACEMENT_NOTICE_SUBJECT_PREFIX,
} from './mail.service';

/**
 * Mail TÜRÜ konudan ayırt edilir (email_log'da tür kolonu yok) ve bu ayrım /ops replay'inin
 * TEK güvencesidir: bir BİLDİRİM maili yanlışlıkla "teslimat" sayılırsa, replay o siparişin
 * TÜM aktif lisans anahtarlarını düz metin olarak müşteriye yeniden gönderir.
 *
 * Yeni bir bildirim türü eklenip öneki NOTICE_SUBJECT_PREFIXES'e YAZILMAZSA sessizce bu duruma
 * düşülür — hata çıkmaz, yalnız yanlış mail gider. §8 İnceleme Kuyruğu reddi için eklenen
 * `ORDER_NOTICE_SUBJECT_PREFIX` tam da bu riski taşıdığı için burada kilitlenir.
 */
describe('isDeliverySubject — bildirim/teslimat ayrımı', () => {
  it('KONTROL: sıradan teslimat konusu teslimat SAYILIR (test boş yere geçmiyor)', () => {
    expect(isDeliverySubject('Siparişiniz hazır — 10042')).toBe(true);
  });

  it('sipariş durumu bildirimi teslimat SAYILMAZ (replay anahtarları yeniden göndermez)', () => {
    expect(isDeliverySubject(`${ORDER_NOTICE_SUBJECT_PREFIX} — 10042`)).toBe(false);
    // Sandbox öneki (§14) eklenmiş hâli de aynı şekilde ayırt edilmeli.
    expect(isDeliverySubject(`[TEST MODU] ${ORDER_NOTICE_SUBJECT_PREFIX} — 10042`)).toBe(false);
  });

  it('değişim bildirimi ayrımı korunur (regresyon)', () => {
    expect(isDeliverySubject(`${REPLACEMENT_NOTICE_SUBJECT_PREFIX} — 10042`)).toBe(false);
    expect(isDeliverySubject(`[TEST MODU] ${REPLACEMENT_NOTICE_SUBJECT_PREFIX} — 10042`)).toBe(
      false,
    );
  });

  it('İKİ BİLDİRİM ÖNEKİ FARKLI: ret maili "Değişim talebiniz" diye gitmez', () => {
    // Müşteri hiç açmadığı bir talebin reddini okuyor sanmamalı — ayrı önek bilinçli.
    expect(ORDER_NOTICE_SUBJECT_PREFIX).not.toBe(REPLACEMENT_NOTICE_SUBJECT_PREFIX);
  });

  it('her bildirim öneki listede kayıtlı ve gerçekten teslimat-dışı sayılıyor', () => {
    for (const prefix of NOTICE_SUBJECT_PREFIXES) {
      expect(isDeliverySubject(`${prefix} — 10042`)).toBe(false);
    }
  });
});
