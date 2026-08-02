import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { OwnerGuard } from './owner.guard';

/**
 * BİRİM — OwnerGuard (denetim H1/P7 savunma-derinliği). AdminGuard'dan SONRA çalışır; Next YAZMA
 * çağrılarında ilettiği `x-admin-role` başlığına göre owner-only uçları korur. Başlık YOKSA geçirir
 * (auth kapalı panel / rol iletmeyen okuma yolu; AdminGuard'ın ADMIN_TOKEN kapısı zaten geçilmiş).
 */
function ctxFor(headers: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('OwnerGuard', () => {
  const guard = new OwnerGuard();

  it("role 'owner' → geçer", () => {
    expect(guard.canActivate(ctxFor({ 'x-admin-role': 'owner' }))).toBe(true);
  });

  it("role 'admin' → 403 (owner-only uca yükselemez)", () => {
    expect(() => guard.canActivate(ctxFor({ 'x-admin-role': 'admin' }))).toThrow(ForbiddenException);
  });

  it('başlık YOK → geçer (auth kapalı / okuma yolu / eski istemci)', () => {
    expect(guard.canActivate(ctxFor({}))).toBe(true);
  });

  it('boş string rol → geçer (rol iletilmemiş sayılır, fallback)', () => {
    expect(guard.canActivate(ctxFor({ 'x-admin-role': '' }))).toBe(true);
  });
});
