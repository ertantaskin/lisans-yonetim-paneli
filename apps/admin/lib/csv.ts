/**
 * Tarayıcı-içi dışa aktarma (§17) — sunucuya ekstra uç açmadan, ekrandaki veriyi doğrudan
 * dosyaya çevirir. İki biçim desteklenir:
 *
 *  - **CSV**: Excel/Numbers ile açılmak için (tablo hâlinde arşivleme, filtreleme).
 *  - **Düz metin (.txt)**: tedarikçiye e-posta/mesajda YAPIŞTIRMAK için sade satır listesi.
 *
 * Excel uyumluluğu (Türkçe Windows):
 *  - Ayraç `;` — TR yerel ayarında Excel virgülü ayraç saymaz, her şeyi tek sütuna basar.
 *  - UTF-8 BOM — BOM olmadan Excel (ve Not Defteri) "ş/ğ/İ" karakterlerini bozuk gösterir.
 *  - CRLF satır sonu — Not Defteri dahil tüm Windows araçlarında satırlar ayrı görünsün.
 *  - Formül enjeksiyonu (CSV injection) koruması: `=`, `+`, `-`, `@`, TAB veya CR ile başlayan
 *    hücrelerin başına tek tırnak eklenir; aksi halde Excel hücreyi FORMÜL olarak çalıştırabilir
 *    (dışa aktarılan dosya tedarikçiye/3. tarafa gönderilecek — bu gerçek bir risk).
 *  - KVKK uyarısı (`toCsv(..., notice)`): kişisel veri içeren varyantlarda dosyanın İLK satırına
 *    tek hücrelik uyarı yazılır (bkz. `toCsv` notu).
 */

/** UTF-8 BOM: Excel + Not Defteri'nin kodlamayı doğru saptaması için dosya başına yazılır. */
const BOM = '﻿';
/** Windows araçlarıyla uyum için satır sonu (LF tek başına Not Defteri'nde tek satır görünür). */
const EOL = '\r\n';

/**
 * Formül enjeksiyonu koruması — hücre değeri Excel'de FORMÜL olarak yorumlanabilecek bir
 * karakterle başlıyorsa tek tırnakla kaçırılır. Değeri bozmaz: Excel tek tırnağı "bu bir
 * metindir" işareti olarak yorumlar ve hücrede göstermez.
 */
function guardFormula(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = guardFormula(String(value));
  // Ayraç, tırnak veya satır sonu içeren hücre tırnaklanır; içteki tırnak ikilenir.
  if (/[";\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => unknown;
}

/**
 * Satırları CSV metnine çevirir.
 *
 * `notice` verilirse dosyanın İLK satırına TEK HÜCRELİK uyarı yazılır (başlık satırı 2. satıra
 * kayar; Excel ragged satırı sorunsuz okur, sütun yapısı bozulmaz). Neden gerekli: kişisel veri
 * içeren dışa aktarmalarda (ör. karantina "iç denetim" seti) uyarı yalnız DOSYA ADINDA vardı —
 * dosya yeniden adlandırılıp/iletilip açıldığında uyarı yok oluyordu. Düz metin (.txt) sürümünde
 * uyarı zaten başlıkta yazılıyor; bu, CSV dalındaki simetriyi kurar (KVKK).
 *
 * Uyarı hücresi de `cell()`ten geçer → formül enjeksiyonu koruması ve tırnaklama aynen uygulanır.
 * Kişisel veri İÇERMEYEN varyantlarda (ör. tedarikçi bildirimi) `notice` VERİLMEZ.
 */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[], notice?: string): string {
  const head = columns.map((c) => cell(c.header)).join(';');
  const body = rows.map((r) => columns.map((c) => cell(c.value(r))).join(';'));
  const lead = notice ? [cell(notice)] : [];
  return [...lead, head, ...body].join(EOL);
}

/**
 * Düz metin satır listesi — "tedarikçiye yapıştırılacak" dosya biçimi. Sütun/ayraç YOK;
 * her kayıt tek okunabilir satır. `header` verilirse dosyanın başına (boş satırla ayrılmış)
 * bilgi satırları yazılır: ne olduğu, kaç kayıt, ne zaman üretildiği.
 *
 * "BİR KAYIT = BİR SATIR" garantisi burada verilir: serbest metin alanları (ör. iptal sebebi
 * bir textarea'dan gelir) satır sonu içerebilir; bunlar tek boşluğa indirgenir. Aksi halde
 * numaralı liste kayar ve tedarikçiye yapıştırılan metin okunmaz hale gelir.
 */
export function toTextList<T>(
  rows: T[],
  line: (row: T, index: number) => string,
  header: string[] = [],
): string {
  const out = header.length ? [...header, ''] : [];
  rows.forEach((r, i) => out.push(line(r, i).replace(/\s*[\r\n]+\s*/g, ' ').trim()));
  return out.join(EOL);
}

/** Dosya adına güvenli zaman damgası: 2026-07-28_0142 */
export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/** Metni BOM'lu UTF-8 dosyaya çevirip indirmeyi başlatır (ortak indirme yolu). */
function save(filename: string, text: string, mime: string): void {
  const blob = new Blob([BOM + text], { type: `${mime};charset=utf-8;` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Bellek sızıntısını önle (Blob URL'i serbest bırak).
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** CSV metnini indirilebilir dosyaya çevirip indirmeyi başlatır (BOM'lu UTF-8). */
export function downloadCsv(filename: string, csv: string): void {
  save(filename.endsWith('.csv') ? filename : `${filename}.csv`, csv, 'text/csv');
}

/** Düz metni indirilebilir .txt dosyasına çevirip indirmeyi başlatır (BOM'lu UTF-8). */
export function downloadText(filename: string, text: string): void {
  save(filename.endsWith('.txt') ? filename : `${filename}.txt`, text, 'text/plain');
}
