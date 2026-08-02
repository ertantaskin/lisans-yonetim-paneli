import { describe, expect, it } from 'vitest';
import { canRevealPlaintext } from './admin-role.decorator';

/**
 * BİRİM — canRevealPlaintext (denetim A1): düz-metin sır (lisans/parola) yalnız owner'a.
 * owner ve başlık-yok (auth kapalı / tek-operatör) → izin; owner-olmayan 'admin' → RED (maskeli).
 */
describe('canRevealPlaintext', () => {
  it("'owner' → true", () => {
    expect(canRevealPlaintext('owner')).toBe(true);
  });
  it("başlık yok ('' — auth kapalı) → true (panel tasarımca açık)", () => {
    expect(canRevealPlaintext('')).toBe(true);
  });
  it("'admin' (owner-olmayan) → false (maskeli görür)", () => {
    expect(canRevealPlaintext('admin')).toBe(false);
  });
  it('bilinmeyen rol → false (güvenli varsayılan)', () => {
    expect(canRevealPlaintext('viewer')).toBe(false);
  });
});
