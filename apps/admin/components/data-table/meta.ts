import type { RowData } from '@tanstack/react-table';

/** ColumnMeta genişletmesi — kolon görünürlüğü/başlık etiketleri için. */
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Görünüm menüsü + faceted filtre başlığı. */
    title?: string;
  }
}
