import { describe, expect, it } from 'vitest';
import {
  buildTableUrlQuery,
  parseTableUrlState,
  TABLE_FILTER_PREFIX,
  TABLE_SEARCH_KEY,
  TABLE_SORT_KEY,
  // Saf modül `components/` altında yaşıyor; test `lib/` altında (vitest include: 'lib/**').
  // Başka yere konsaydı `passWithNoTests` yüzünden SIFIR test koşar, yeşil görünürdü.
} from '../components/data-table/url-state';

const SEARCH_COL = 'remoteOrderId';
const FACETS = ['status', 'siteId'] as const;

const parse = (s: string) => parseTableUrlState(s, SEARCH_COL, FACETS);
const build = (current: string, state: Parameters<typeof buildTableUrlQuery>[1]) =>
  buildTableUrlQuery(current, state, SEARCH_COL, FACETS);

describe('DataTable URL durumu', () => {
  it('boş query boş durum verir', () => {
    expect(parse('')).toEqual({ sorting: [], columnFilters: [] });
  });

  it('arama + facet + sıralama okur', () => {
    const st = parse(`?${TABLE_SEARCH_KEY}=1042&${TABLE_FILTER_PREFIX}status=pending,partial&${TABLE_SORT_KEY}=createdAt:desc`);
    expect(st.columnFilters).toEqual([
      { id: SEARCH_COL, value: '1042' },
      { id: 'status', value: ['pending', 'partial'] },
    ]);
    expect(st.sorting).toEqual([{ id: 'createdAt', desc: true }]);
  });

  it('yön verilmezse artan kabul edilir', () => {
    expect(parse(`?${TABLE_SORT_KEY}=name`)).toMatchObject({ sorting: [{ id: 'name', desc: false }] });
  });

  /**
   * GÜVENLİK/DOĞRULUK: adres çubuğu kullanıcı tarafından düzenlenebilir. Facet listesinde
   * OLMAYAN bir kolon için `tf.*` verilmesi tabloya filtre enjekte etmemeli.
   */
  it('bilinmeyen facet kolonunu yok sayar', () => {
    expect(parse(`?${TABLE_FILTER_PREFIX}gizliKolon=x`).columnFilters).toEqual([]);
  });

  it('bozuk/boş değerler ekranı boşaltmaz', () => {
    expect(parse(`?${TABLE_FILTER_PREFIX}status=&${TABLE_SEARCH_KEY}=&${TABLE_SORT_KEY}=`)).toEqual({
      sorting: [],
      columnFilters: [],
    });
  });

  it('durumu geri yazar (round-trip)', () => {
    const state = {
      sorting: [{ id: 'createdAt', desc: true }],
      columnFilters: [
        { id: SEARCH_COL, value: 'acme' },
        { id: 'status', value: ['fulfilled'] },
      ],
    };
    const qs = build('', state);
    expect(parse(qs)).toEqual(state);
  });

  /**
   * EN KRİTİK DAVRANIŞ: sayfanın KENDİ sunucu parametreleri (ör. /customers `?site=`) tablo
   * yazımında KORUNMALI. Ezilseydi sunucu süzgeci sessizce değişir, operatör daralttığını
   * sandığı listede başka veri görürdü.
   */
  it('sayfanın kendi parametrelerini korur', () => {
    const qs = build('?site=abc&q=ali', {
      sorting: [],
      columnFilters: [{ id: 'status', value: ['pending'] }],
    });
    const params = new URLSearchParams(qs);
    expect(params.get('site')).toBe('abc');
    expect(params.get('q')).toBe('ali');
    expect(params.get(`${TABLE_FILTER_PREFIX}status`)).toBe('pending');
  });

  it('süzgeç temizlenince kendi anahtarlarını siler, diğerlerine dokunmaz', () => {
    const qs = build(`?site=abc&${TABLE_SEARCH_KEY}=x&${TABLE_FILTER_PREFIX}status=pending&${TABLE_SORT_KEY}=a:asc`, {
      sorting: [],
      columnFilters: [],
    });
    expect(qs).toBe('?site=abc');
  });

  it('yalnız boşluktan oluşan arama yazılmaz', () => {
    expect(build('', { sorting: [], columnFilters: [{ id: SEARCH_COL, value: '   ' }] })).toBe('');
  });

  it('hepsi boşsa query tamamen boşalır', () => {
    expect(build(`?${TABLE_SEARCH_KEY}=x`, { sorting: [], columnFilters: [] })).toBe('');
  });
});
