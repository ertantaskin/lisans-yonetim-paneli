import { describe, expect, it } from 'vitest';
import { compareVersions, highestVersion } from '../app/releases/semver';

/**
 * /releases sürüm sıralaması — DAVRANIŞ KİLİDİ.
 *
 * Bu ekranın iki kararı buna dayanır: (1) "En yeni" rozeti, (2) elle .zip yükleme kapısı
 * ("bu paket sitelere sunulur mu?"). İkisi de sitelere fiilen sunulan sürümle (API
 * `updates.service.latest()` = EN YÜKSEK SEMVER) aynı cevabı vermek ZORUNDA. Panel bir
 * dönem `rows[0]`ı (created_at DESC) "en yeni" sanıyordu; yeniden yayınlama `created_at`i
 * tazelediği için bu, ESKİ bir sürüme "En yeni" damgası basabiliyordu.
 */
describe('releases semver', () => {
  it('sayısal karşılaştırır (leksikografik DEĞİL)', () => {
    // '1.10.0' < '1.9.0' diyen string sıralaması bu ekranda yanlış rozet basardı.
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('1.0.5', '1.1.0')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('geçersiz biçimi EN DÜŞÜK sayar (uydurma "en yeni" basmamak için)', () => {
    expect(compareVersions('sürüm-yok', '0.0.1')).toBe(-1);
    expect(compareVersions('0.0.1', '')).toBe(1);
    expect(compareVersions('a', 'b')).toBe(0);
  });

  it('en yüksek sürümü LİSTE SIRASINDAN bağımsız bulur', () => {
    // Liste created_at DESC gelir: en üstteki satır (yeniden yayınlanan 1.0.5) EN YENİ DEĞİL.
    expect(highestVersion(['1.0.5', '1.1.0', '0.9.9'])).toBe('1.1.0');
    expect(highestVersion(['1.1.0'])).toBe('1.1.0');
    expect(highestVersion([])).toBeNull();
  });

  it('yalnız geçersiz sürümler varsa da null DÖNDÜRMEZ (ekran boş kalmasın)', () => {
    expect(highestVersion(['bozuk', 'yine-bozuk'])).toBe('bozuk');
  });
});
