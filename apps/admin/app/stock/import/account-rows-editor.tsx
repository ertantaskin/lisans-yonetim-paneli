'use client';
import * as React from 'react';
import { Eraser, Plus, Trash2, TriangleAlert } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Badge } from '../../../components/ui/badge';
import { Input } from '../../../components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { cn } from '../../../lib/utils';
import {
  cleanHiddenChars,
  delimiterLabel,
  hasHiddenChars,
  padRow,
  parseGrid,
  type GridColumn,
} from './parse';

/** Ürünün `payloadSchema` alanı + tablo sunumu için gereken bayraklar. */
export interface AccountColumn extends GridColumn {
  /** Şemada "gizli" işaretli alan (parola vb.). Değer MASKELENMEZ — bkz. aşağıdaki not. */
  secret: boolean;
  required: boolean;
}

/** Boş bir satır üretir (sütun sayısına hizalı). */
export function emptyAccountRow(width: number): string[] {
  return Array.from({ length: Math.max(width, 1) }, () => '');
}

/**
 * Hesap (account) ürünlerinde satır girişi için tablo editörü.
 *
 * TASARIM NOTLARI
 * - **Maskeleme YOK:** `secret` alanlar (parola) burada operatörün AZ ÖNCE yapıştırdığı,
 *   henüz panele girmemiş veridir. Maskelemek doğrulamayı imkânsız kılardı ("yanlış sütuna
 *   mı düştü?"). Alan yalnız "gizli" rozetiyle işaretlenir; teslimat/görüntüleme yollarındaki
 *   maskeleme disiplini (§7) değişmez.
 * - **Yapıştırma:** Excel/Sheets/CSV bloğu herhangi bir hücreye yapıştırılabilir; ayraç
 *   (sekme/`;`/`,`) otomatik seçilir, tırnaklı alan (`"a,b"`) korunur, ilk satır sütun
 *   adlarıyla eşleşiyorsa BAŞLIK sayılıp atlanır.
 * - **Görünmez karakterler:** baştaki/sondaki boşluk ve NBSP sessizce TEMİZLENMEZ (veri
 *   sessizce değiştirilmez) — hücre işaretlenir, tek tıkla toplu temizlenir. Teslimattan
 *   sonra "parola çalışmıyor" olarak dönen en sinsi hata budur.
 */
export function AccountRowsEditor({
  columns,
  rows,
  onRowsChange,
}: {
  columns: AccountColumn[];
  rows: string[][];
  onRowsChange: (rows: string[][]) => void;
}) {
  const width = Math.max(columns.length, 1);
  const [pasteNote, setPasteNote] = React.useState<string | null>(null);

  const hiddenCount = React.useMemo(
    () => rows.reduce((n, row) => n + row.filter((v) => hasHiddenChars(v)).length, 0),
    [rows],
  );
  const filledRows = React.useMemo(
    () => rows.filter((row) => row.some((v) => v.trim() !== '')).length,
    [rows],
  );

  const setCell = (r: number, c: number, value: string) => {
    const next = rows.map((row) => padRow(row, width));
    next[r][c] = value;
    onRowsChange(next);
  };

  const addRow = () => onRowsChange([...rows.map((r) => padRow(r, width)), emptyAccountRow(width)]);

  const removeRow = (r: number) => {
    if (rows.length <= 1) {
      onRowsChange([emptyAccountRow(width)]);
      return;
    }
    onRowsChange(rows.filter((_, i) => i !== r));
  };

  const cleanAll = () =>
    onRowsChange(rows.map((row) => padRow(row, width).map((v) => cleanHiddenChars(v))));

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    // Tek hücrelik yapıştırma tarayıcının normal davranışında kalsın (imleç konumu korunur).
    const looksTabular = /[\n\t;]/.test(text) || (width > 1 && text.includes(','));
    if (!looksTabular) return;
    e.preventDefault();

    const grid = parseGrid(text, columns);
    if (grid.rows.length === 0) return;

    const next = rows.map((row) => padRow(row, width));
    grid.rows.forEach((parsedRow, i) => {
      const target = r + i;
      while (next.length <= target) next.push(emptyAccountRow(width));
      parsedRow.forEach((value, j) => {
        const col = c + j;
        if (col < width) next[target][col] = value;
      });
    });
    onRowsChange(next);
    setPasteNote(
      `${grid.rows.length} satır yapıştırıldı (ayraç: ${delimiterLabel(grid.delimiter)}` +
        `${grid.headerSkipped ? ', başlık satırı atlandı' : ''}).`,
    );
  };

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10 text-right">#</TableHead>
              {columns.map((col) => (
                <TableHead key={col.key}>
                  <span className="inline-flex items-center gap-1.5">
                    {col.label}
                    {col.required && (
                      <span className="text-destructive" aria-hidden>
                        *
                      </span>
                    )}
                    {col.secret && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
                        gizli
                      </Badge>
                    )}
                  </span>
                </TableHead>
              ))}
              <TableHead className="w-10" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row, r) => (
              <TableRow key={r}>
                <TableCell className="py-1 text-right text-xs tabular-nums text-muted-foreground">
                  {r + 1}
                </TableCell>
                {columns.map((col, c) => {
                  const value = row[c] ?? '';
                  const dirty = hasHiddenChars(value);
                  return (
                    <TableCell key={col.key} className="p-1">
                      <div className="relative">
                        <Input
                          value={value}
                          onChange={(e) => setCell(r, c, e.target.value)}
                          onPaste={(e) => handlePaste(e, r, c)}
                          aria-label={`${col.label} — satır ${r + 1}`}
                          aria-invalid={dirty || undefined}
                          className={cn(
                            'h-8 font-mono text-xs',
                            dirty && 'border-warning pr-7 focus-visible:ring-warning/30',
                          )}
                        />
                        {dirty && (
                          <TriangleAlert
                            className="pointer-events-none absolute right-2 top-2 size-4 text-warning"
                            aria-hidden
                          />
                        )}
                      </div>
                    </TableCell>
                  );
                })}
                <TableCell className="p-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => removeRow(r)}
                    aria-label={`${r + 1}. satırı sil`}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={addRow}>
          <Plus /> Satır ekle
        </Button>
        {hiddenCount > 0 && (
          <Button type="button" variant="outline" size="sm" onClick={cleanAll}>
            <Eraser /> Görünmez karakterleri temizle ({hiddenCount})
          </Button>
        )}
        <span className="text-xs text-muted-foreground">
          {filledRows} dolu satır · {rows.length} satır gösteriliyor
        </span>
      </div>

      {pasteNote && <p className="text-xs text-muted-foreground">{pasteNote}</p>}
      {hiddenCount > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-warning">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {hiddenCount} hücrede baştaki/sondaki boşluk ya da görünmez karakter (NBSP) var. Bu
            karakterler anahtarla birlikte teslim edilir ve müşteride &quot;çalışmıyor&quot; olarak
            döner — girmeden önce temizleyin.
          </span>
        </p>
      )}
    </div>
  );
}
