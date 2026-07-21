import { NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AiSupportService } from './ai-support.service';
import type { AiService } from './ai.service';
import type { Database } from '../db/db.module';

/**
 * AiSupportService maskeleme birim testi (§15 "ham e-posta modele gönderilmez").
 *
 * PG GEREKMEZ: maskEmail modül-dışı (export edilmemiş) olduğundan en küçük test edilebilir
 * yüzey suggest()'in kendisidir. db ve AiService sahte verilir; AiService'e giden system+user
 * içeriği yakalanıp ham e-postanın SIZMADIĞI, maskeli biçimin (a***@x.com) GİTTİĞİ doğrulanır.
 * Sonuç yalnız AI çıktısını döndürür — DB/mail yazımı yoktur.
 */

/** replacement_requests satırının suggest()'in okuduğu alt kümesini taklit eder. */
function fakeRow(customerEmail: string): Record<string, unknown> {
  return {
    id: 'rr-test',
    customerEmail,
    reason: 'Anahtar aktivasyonda hata veriyor',
    status: 'open',
    withinWarranty: true,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
  };
}

/** select().from().where().limit(1) zincirini taklit eden minimal sahte db. */
type QueryChain = {
  from: () => QueryChain;
  where: () => QueryChain;
  limit: () => Promise<Record<string, unknown>[]>;
};
function fakeDb(row: Record<string, unknown> | undefined): Database {
  // Açık tip anotasyonu: kendine-referanslı const'ta implicit-any (ts7022) olmasın.
  const chain: QueryChain = {
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(row === undefined ? [] : [row]),
  };
  return { select: () => chain } as unknown as Database;
}

/** completeJson'a geçen argümanları yakalayan sahte AiService (sabit öneri döndürür). */
function captureAi(): {
  ai: AiService;
  calls: Array<{ system: string; user: string }>;
} {
  const calls: Array<{ system: string; user: string }> = [];
  const ai = {
    completeJson: async (input: { system: string; user: string }) => {
      calls.push({ system: input.system, user: input.user });
      return { category: 'garanti', priority: 'orta', draftReply: 'Talebiniz inceleniyor.' };
    },
  } as unknown as AiService;
  return { ai, calls };
}

describe('AiSupportService.suggest — e-posta maskeleme', () => {
  it("ham e-posta modele gitmez; maskeli biçim (a***@x.com) gider", async () => {
    const { ai, calls } = captureAi();
    const service = new AiSupportService(fakeDb(fakeRow('aylin@xmail.com')), ai);

    const result = await service.suggest('rr-test');

    // Sonuç sahte AI çıktısını aynen döndürür (servis yalnız ÖNERİR).
    expect(result).toEqual({
      category: 'garanti',
      priority: 'orta',
      draftReply: 'Talebiniz inceleniyor.',
    });

    // Model tam olarak bir kez çağrıldı; gönderilen tüm metni birleştir.
    expect(calls).toHaveLength(1);
    const sent = `${calls[0]!.system}\n${calls[0]!.user}`;

    // Maskeli biçim GİTTİ.
    expect(calls[0]!.user).toContain('a***@x.com');
    // Ham e-posta ve alan adı HİÇBİR yere sızmadı (system + user).
    expect(sent).not.toContain('aylin@xmail.com');
    expect(sent).not.toContain('aylin');
    expect(sent).not.toContain('xmail.com');

    // Maskeli bağlamın diğer (sır olmayan) alanları modele gider — bağlam kurulmuş.
    expect(calls[0]!.user).toContain('Anahtar aktivasyonda hata veriyor');
    expect(calls[0]!.user).toContain('open');
  });

  it('çok noktalı alan adı doğru maskelenir (bob@mail.co.uk → b***@m.uk)', async () => {
    const { ai, calls } = captureAi();
    const service = new AiSupportService(fakeDb(fakeRow('bob@mail.co.uk')), ai);

    await service.suggest('rr-test');

    expect(calls[0]!.user).toContain('b***@m.uk');
    expect(`${calls[0]!.system}\n${calls[0]!.user}`).not.toContain('bob@mail.co.uk');
  });

  it('talep yoksa 404 (NotFoundException) — model çağrılmaz', async () => {
    const { ai, calls } = captureAi();
    const service = new AiSupportService(fakeDb(undefined), ai);

    await expect(service.suggest('yok')).rejects.toBeInstanceOf(NotFoundException);
    expect(calls).toHaveLength(0);
  });
});
