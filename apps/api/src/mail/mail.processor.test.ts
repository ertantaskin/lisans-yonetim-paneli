import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { MailProcessor } from './mail.processor';
import {
  MAIL_DELIVERY_JOB,
  MAIL_NOTICE_JOB,
  type MailService,
  type ReplacementNoticeJob,
} from './mail.service';
import type { CryptoService } from '../crypto/crypto.service';
import type { Database } from '../db/db.module';
import type { TemplatesService } from './templates.service';

/**
 * MailProcessor iş-adı DALLANMASI birim testi (regresyon kilidi).
 *
 * REGRESYON: değişim/destek DURUM bildirimleri BullMQ'ya YENİ bir iş adıyla
 * (MAIL_NOTICE_JOB) eklendi ama worker yalnız teslimat gövdesini biliyordu → bildirim işi
 * "teslimat" sanılıp 'Sipariş bulunamadı' ile patlıyordu; müşteri "talebiniz onaylandı"
 * mailini HİÇ almıyordu (sessiz kayıp). Bu test dallanmayı sabitler:
 *   1) bildirim işi → sendNoticeJob (teslimat yolu HİÇ çalışmaz → lisans anahtarı çözülmez),
 *   2) bilinmeyen iş adı → HATA (sessiz 'completed' yok; kuyruk retry/dead-letter görsün),
 *   3) teslimat işi → teslimat yolu (bildirim dalına sapmaz).
 *
 * PG/Redis GEREKMEZ: db, crypto, templates, config ve MailService sahte verilir.
 */

/** select().from().where().limit(1) zincirini taklit eden minimal sahte db + yazma sayacı. */
type SelectChain = {
  from: () => SelectChain;
  where: () => SelectChain;
  limit: () => Promise<Record<string, unknown>[]>;
};

function fakeDb(rows: Record<string, unknown>[] = []): {
  db: Database;
  selectCalls: () => number;
  updates: Array<Record<string, unknown>>;
} {
  let selects = 0;
  const updates: Array<Record<string, unknown>> = [];
  // Açık tip anotasyonu: kendine-referanslı const'ta implicit-any olmasın.
  const chain: SelectChain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  const db = {
    select: () => {
      selects += 1;
      return chain;
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  } as unknown as Database;
  return { db, selectCalls: () => selects, updates };
}

/** sendNoticeJob çağrılarını yakalayan sahte MailService (gerçek SMTP'ye dokunmaz). */
function fakeMail(): { mail: MailService; calls: ReplacementNoticeJob[] } {
  const calls: ReplacementNoticeJob[] = [];
  const mail = {
    sendNoticeJob: (data: ReplacementNoticeJob) => {
      calls.push(data);
      return Promise.resolve();
    },
  } as unknown as MailService;
  return { mail, calls };
}

/**
 * Teslimat yoluna sapmayı ANINDA yakalayan sahte crypto: bildirim/bilinmeyen dalında
 * payload çözümü ÇAĞRILMAMALIDIR (sır sızıntısı koruması).
 */
const explodingCrypto = {
  decrypt: () => {
    throw new Error('Teslimat yolu çağrılmamalıydı (payload çözümü)');
  },
} as unknown as CryptoService;

const noTemplates = {} as unknown as TemplatesService;
const noConfig = {} as unknown as ConfigService;

/** process()'in beklediği Job tipini kaynaktan türet (imza değişirse test derlenmez). */
type MailJob = Parameters<MailProcessor['process']>[0];
function fakeJob(name: string, data: unknown): MailJob {
  return { name, id: 'job-1', data } as unknown as MailJob;
}

describe('MailProcessor: kuyruk işi adına göre dallanma', () => {
  it('bildirim işini (MAIL_NOTICE_JOB) sendNoticeJob dalına yönlendirir, teslimat yoluna GİRMEZ', async () => {
    const { db, selectCalls } = fakeDb();
    const { mail, calls } = fakeMail();
    const processor = new MailProcessor(db, explodingCrypto, noTemplates, noConfig, mail);

    const data: ReplacementNoticeJob = {
      emailLogId: 'log-1',
      to: 'musteri@example.com',
      subject: 'Değişim talebiniz — 10042',
      body: 'Değişim talebiniz onaylandı, yeni lisansınız hazır.',
    };
    await processor.process(fakeJob(MAIL_NOTICE_JOB, data));

    expect(calls).toEqual([data]);
    // Teslimat yolu hiç dokunmadı: atama/payload sorgusu yok → mail gövdesinde lisans anahtarı yok.
    expect(selectCalls()).toBe(0);
  });

  it('bilinmeyen iş adında SESSİZCE geçmez — hata fırlatır ve email_log kaydını failed işaretler', async () => {
    const { db, updates } = fakeDb();
    const { mail, calls } = fakeMail();
    const processor = new MailProcessor(db, explodingCrypto, noTemplates, noConfig, mail);

    await expect(
      processor.process(fakeJob('bilinmeyen-is-adi', { emailLogId: 'log-2' })),
    ).rejects.toThrow(/Bilinmeyen mail işi adı/);

    // Ne teslimat ne bildirim dalı çalıştı; kayıt dead-letter'da görünsün diye 'failed'.
    expect(calls).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.status).toBe('failed');
  });

  it('teslimat işini (MAIL_DELIVERY_JOB) teslimat dalına yönlendirir (bildirim dalına sapmaz)', async () => {
    // email_log zaten 'sent' → teslimat dalının idempotency kısa devresi; SMTP/şablon gerekmez.
    const { db, selectCalls } = fakeDb([{ status: 'sent' }]);
    const { mail, calls } = fakeMail();
    const processor = new MailProcessor(db, explodingCrypto, noTemplates, noConfig, mail);

    await processor.process(fakeJob(MAIL_DELIVERY_JOB, { orderId: 'o-1', emailLogId: 'log-3' }));

    expect(selectCalls()).toBe(1); // teslimat dalı email_log'u okudu
    expect(calls).toHaveLength(0); // bildirim dalı ÇAĞRILMADI
  });
});
