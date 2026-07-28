/**
 * Tarayıcı-içi CSV dışa aktarma (§17) — sunucuya ekstra uç açmadan, ekrandaki veriyi
 * doğrudan dosyaya çevirir.
 *
 * Excel uyumluluğu (Türkçe Windows):
 *  - Ayraç `;` — TR yerel ayarında Excel virgülü ayraç saymaz, her şeyi tek sütuna basar.
 *  - UTF-8 BOM — BOM olmadan Excel "ş/ğ/İ" karakterlerini bozuk gösterir.
 *  - Formül enjeksiyonu (CSV injection) koruması: `=`, `+`, `-`, `@`, TAB veya CR ile başlayan
 *    hücrelerin başına tek tırnak eklenir; aksi halde Excel hücreyi FORMÜL olarak çalıştırabilir
 *    (dışa aktarılan dosya tedarikçiye/3. tarafa gönderilecek — bu gerçek bir risk).
 */

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  // Ayraç, tırnak veya satır sonu içeren hücre tırnaklanır; içteki tırnak ikilenir.
  if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => cell(c.header)).join(';');
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(';'));
  return [head, ...body].join('\r\n');
}

/** Dosya adına güvenli zaman damgası: 2026-07-28_0142 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** CSV metnini indirilebilir dosyaya çevirip indirmeyi başlatır (BOM'lu UTF-8). */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.csv') ? filename : `${filename}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Bellek sızıntısını önle (Blob URL'i serbest bırak).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
