import type { ColumnFiltersState, SortingState } from '@tanstack/react-table';

/**
 * DATATABLE SÜZGEÇLERİNİ ADRES ÇUBUĞUNA YAZMA — serileştirme sözleşmesi.
 *
 * NEDEN VAR: `DataTable` süzgeçlerini (arama / facet / sıralama) yalnız istemci state'inde
 * tutuyordu. İki gerçek sonucu vardı:
 *   1. Kayıtlı görünümler (§14) URL query string'ini saklar → bu tablolarda kaydedilen görünüm
 *      BOŞ oluyordu. Menü bunu dürüstçe uyarıyordu ama özellik o ekranlarda fiilen yoktu.
 *   2. Rehberin "sık kullandığınız görünümü yer imlerine ekleyin" vaadi bu ekranlarda YANLIŞTI:
 *      süzgeçli bir adres kopyalanıp paylaşıldığında karşı taraf süzgeçsiz listeyi görüyordu.
 *
 * ANAHTAR ADLARI dar ve öneklidir (`tq`, `tf.<kolon>`, `tsort`) → sayfanın KENDİ sunucu-taraflı
 * parametreleriyle (`?site=`, `?q=`, `?status=`…) ÇAKIŞMAZ. Bu ayrım şart: `/customers`
 * ekranında `q` sunucu aramasıdır ve tablo yazımı onu ezseydi sunucu süzgeci sessizce değişirdi.
 *
 * SAYFA NUMARASI BİLEREK YAZILMAZ: kaydedilen/paylaşılan bir görünümün "3. sayfa"da açılması
 * neredeyse hiç istenmez; süzgeç değişince sayfa zaten başa döner.
 */

/** Tablo durumunun yazdığı anahtarlar — geri kalan tüm query parametreleri KORUNUR. */
export const TABLE_SEARCH_KEY = 'tq';
export const TABLE_FILTER_PREFIX = 'tf.';
export const TABLE_SORT_KEY = 'tsort';

/** Facet değerlerinde ayraç. Değerler enum/slug olduğu için virgül güvenli. */
const VALUE_SEP = ',';

export interface TableUrlState {
  sorting: SortingState;
  columnFilters: ColumnFiltersState;
}

/**
 * Query string → tablo durumu. Bilinmeyen/bozuk değerler SESSİZCE atlanır: adres çubuğu
 * kullanıcı tarafından düzenlenebilir bir yüzeydir, hatalı bir parça tüm ekranı boşaltmamalı.
 *
 * @param searchColumnId serbest arama kolonu (yoksa `tq` yok sayılır)
 * @param facetColumnIds facet kolonları — YALNIZ bunlar dizi filtre olarak okunur; keyfi bir
 *   `tf.<kolon>` parametresinin tabloya filtre enjekte etmesi böylece engellenir.
 */
export function parseTableUrlState(
  search: string,
  searchColumnId: string | undefined,
  facetColumnIds: readonly string[],
): TableUrlState {
  const params = new URLSearchParams(search);
  const columnFilters: ColumnFiltersState = [];

  if (searchColumnId) {
    const q = params.get(TABLE_SEARCH_KEY);
    if (q) columnFilters.push({ id: searchColumnId, value: q });
  }

  for (const id of facetColumnIds) {
    const raw = params.get(`${TABLE_FILTER_PREFIX}${id}`);
    if (!raw) continue;
    const values = raw.split(VALUE_SEP).filter(Boolean);
    if (values.length > 0) columnFilters.push({ id, value: values });
  }

  const sorting: SortingState = [];
  const sortRaw = params.get(TABLE_SORT_KEY);
  if (sortRaw) {
    // `<kolon>:asc|desc`. Kolonun var olup olmadığını TanStack zaten yok sayarak karşılar.
    const sep = sortRaw.lastIndexOf(':');
    const id = sep > 0 ? sortRaw.slice(0, sep) : sortRaw;
    const dir = sep > 0 ? sortRaw.slice(sep + 1) : 'asc';
    if (id) sorting.push({ id, desc: dir === 'desc' });
  }

  return { sorting, columnFilters };
}

/**
 * Tablo durumu → query string (mevcut parametreler KORUNARAK).
 * Dönen değer '' ya da '?...' biçimindedir (kayıtlı görünümlerin sakladığı biçimin aynısı).
 */
export function buildTableUrlQuery(
  currentSearch: string,
  state: TableUrlState,
  searchColumnId: string | undefined,
  facetColumnIds: readonly string[],
): string {
  const params = new URLSearchParams(currentSearch);

  // Önce BU tablonun yazdığı anahtarları temizle — kalanlar sayfanın kendi parametreleridir.
  params.delete(TABLE_SEARCH_KEY);
  params.delete(TABLE_SORT_KEY);
  for (const id of facetColumnIds) params.delete(`${TABLE_FILTER_PREFIX}${id}`);

  for (const f of state.columnFilters) {
    if (searchColumnId && f.id === searchColumnId) {
      const v = typeof f.value === 'string' ? f.value.trim() : '';
      if (v) params.set(TABLE_SEARCH_KEY, v);
      continue;
    }
    if (!facetColumnIds.includes(f.id)) continue;
    const values = Array.isArray(f.value) ? f.value.map(String).filter(Boolean) : [];
    if (values.length > 0) params.set(`${TABLE_FILTER_PREFIX}${f.id}`, values.join(VALUE_SEP));
  }

  const s = state.sorting[0];
  if (s) params.set(TABLE_SORT_KEY, `${s.id}:${s.desc ? 'desc' : 'asc'}`);

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
