import { describe, expect, it } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { pgHttpException, pgHttpMapping } from './pg-http-mapping';

/**
 * SQLSTATE → HTTP çevirisinin DAVRANIŞ testi (DB gerektirmez).
 *
 * Neyi korur: (a) kullanıcı girdisinden doğan PG kodları anlamlı 4xx'e çevrilir,
 * (b) sunucu kusurunu gösteren kodlar 500 KALIR (yanlışlıkla "girdiniz hatalı" denmesin),
 * (c) drizzle'ın `DrizzleQueryError` sarmalaması (kod `cause` zincirinde) atlanmaz.
 */

/** postgres.js hatasının test ikizi. */
const pgErr = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`ham pg mesajı ${code}`), { code, ...extra });

/** drizzle-orm 0.45 sürücü hatasını sarar ve orijinali `cause`a koyar. */
const wrapped = (err: unknown) => Object.assign(new Error('Failed query: …'), { cause: err });

describe('pgHttpMapping', () => {
  it('23505 (unique_violation) → 409', () => {
    expect(pgHttpMapping(pgErr('23505'))?.status).toBe(409);
  });

  it('23503 (FK) → varsayılan 404: istemci var olmayan bir id gönderdi', () => {
    const m = pgHttpMapping(pgErr('23503', { detail: 'Key (supplier_id)=(…) is not present in table "suppliers".' }));
    expect(m?.status).toBe(404);
  });

  it('23503 + "still referenced" → 409: kayıt kullanımda, silinemez', () => {
    const m = pgHttpMapping(
      pgErr('23503', {
        detail: 'Key (id)=(…) is still referenced from table "purchase_orders".',
      }),
    );
    expect(m?.status).toBe(409);
  });

  it('22003 / 22001 / 22P02 → 400 (girdi kaynaklı)', () => {
    expect(pgHttpMapping(pgErr('22003'))?.status).toBe(400);
    expect(pgHttpMapping(pgErr('22001'))?.status).toBe(400);
    expect(pgHttpMapping(pgErr('22P02'))?.status).toBe(400);
  });

  it('57014 / 55P03 (zaman aşımı, kilit) → 503 + Retry-After', () => {
    for (const code of ['57014', '55P03']) {
      const m = pgHttpMapping(pgErr(code));
      expect(m?.status).toBe(503);
      expect(m?.retryAfterSec).toBeGreaterThan(0);
    }
  });

  it('40P01 / 40001 (deadlock, serialization) → 409, Retry-After YOK', () => {
    for (const code of ['40P01', '40001']) {
      const m = pgHttpMapping(pgErr(code));
      expect(m?.status).toBe(409);
      expect(m?.retryAfterSec).toBeUndefined();
    }
  });

  it('drizzle sarmalamasında kod `cause` zincirinden okunur', () => {
    expect(pgHttpMapping(wrapped(pgErr('23505')))?.status).toBe(409);
  });

  it('sunucu kusuru gösteren kodlar ÇEVRİLMEZ → 500 + Sentry olarak akar', () => {
    // 23502 not_null_violation, 42703 undefined_column, 42P01 undefined_table:
    // bunlar için doğru davranış düzeltilmektir, kullanıcıyı suçlamak değil.
    for (const code of ['23502', '42703', '42P01', '08006']) {
      expect(pgHttpMapping(pgErr(code))).toBeNull();
    }
  });

  it('PG olmayan hata çevrilmez (kod yok) — metin yedeği BİLEREK kullanılmaz', () => {
    expect(pgHttpMapping(new Error('unique constraint diye geçen alakasız bir mesaj'))).toBeNull();
    expect(pgHttpMapping(undefined)).toBeNull();
    expect(pgHttpMapping('düz metin hata')).toBeNull();
  });

  it('mesajlar Türkçe ve ham PG metnini TAŞIMAZ (sır/PII sızmaz)', () => {
    const m = pgHttpMapping(
      pgErr('23505', { detail: 'Key (payload_hash)=(gizli-hash) already exists.' }),
    );
    expect(m?.message).not.toContain('payload_hash');
    expect(m?.message).not.toContain('gizli-hash');
    expect(m?.message.length).toBeGreaterThan(20);
  });
});

describe('pgHttpException', () => {
  it('durum koduna göre standart Nest istisnasını üretir (yanıt gövdesi diğer 4xx ile aynı)', () => {
    expect(pgHttpException({ status: 400, message: 'x' })).toBeInstanceOf(BadRequestException);
    expect(pgHttpException({ status: 404, message: 'x' })).toBeInstanceOf(NotFoundException);
    expect(pgHttpException({ status: 409, message: 'x' })).toBeInstanceOf(ConflictException);
    expect(pgHttpException({ status: 503, message: 'x' })).toBeInstanceOf(ServiceUnavailableException);
  });

  it('mesaj yanıt gövdesine geçer', () => {
    const ex = pgHttpException({ status: 409, message: 'çakışma mesajı' });
    expect(JSON.stringify(ex.getResponse())).toContain('çakışma mesajı');
  });
});
