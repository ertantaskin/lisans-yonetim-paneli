import { describe, expect, it } from 'vitest';
import { savedViewSaveNotice } from './saved-views';

describe('savedViewSaveNotice', () => {
  it('süzgeçlerin hepsi adreste ise ek uyarı basmaz', () => {
    const n = savedViewSaveNotice({ hasQuery: true });
    expect(n.details).toEqual([]);
    expect(n.description).toContain('bu adla kaydedilir');
  });

  it('adres boşsa "süzgeçsiz açar" uyarısı verir', () => {
    const n = savedViewSaveNotice({ hasQuery: false });
    expect(n.description).toContain('hiçbir süzgeç yok');
  });

  /**
   * BULGU U1'İN TAM HÂLİ: adres DOLU (`?site=X`) ama tablo içi süzgeçler yazılmıyor.
   * Eski kod uyarıyı yalnız boş-query dalında basıyordu → burada SESSİZ kalıyordu.
   */
  it('adres dolu olsa bile yazılmayan süzgeçleri uyarır', () => {
    const n = savedViewSaveNotice({
      hasQuery: true,
      unsyncedFilters: 'tablo içi hızlı süzgeçler',
    });
    expect(n.details).toHaveLength(1);
    expect(n.details[0]).toContain('tablo içi hızlı süzgeçler');
    expect(n.details[0]).toContain('GİRMEZ');
  });

  it('adres boş + yazılmayan süzgeç: iki bilgi birden verilir', () => {
    const n = savedViewSaveNotice({ hasQuery: false, unsyncedFilters: 'katalog araması' });
    expect(n.description).toContain('hiçbir süzgeç yok');
    expect(n.details[0]).toContain('katalog araması');
  });
});
