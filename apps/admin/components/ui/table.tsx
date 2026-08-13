import * as React from 'react';
import { cn } from '../../lib/utils';

/** Yoğun operasyon tablosu (§17 "scan edilir, okunmaz"). */
export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn('w-full caption-bottom text-sm', className)} {...props} />
    </div>
  );
}

export function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <thead className={cn('[&_tr]:border-b [&_tr]:border-border', className)} {...props} />;
}

export function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={cn('[&_tr:last-child]:border-0', className)} {...props} />;
}

export function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
  return (
    <tr
      className={cn(
        'border-b border-border/70 transition-colors hover:bg-accent/40 data-[state=selected]:bg-accent/60',
        className,
      )}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      className={cn(
        // Referans (ölçüldü): `h-11 text-sm font-semibold` + KOYU metin (muted DEĞİL) ve
        // büyük-harf YOK. Başlık satırı böylece bir "etiket şeridi" değil, tablonun ilk
        // satırı gibi okunur — shadcnspace'in tipografik imzası.
        // `whitespace-nowrap`: h-11 SABİT yükseklik tek satır varsayar; uzun başlıklar
        // ("Lisans / hesap değeri") ikiye bölünüp şeridi kabartıyordu. Ayrıca sıralanabilir
        // başlık bir <Button> içinde (buton tabanı zaten nowrap) → sarma davranışı da
        // kolondan kolona çelişiyordu.
        'h-11 whitespace-nowrap px-4 text-left align-middle text-sm font-semibold text-foreground',
        // NOT: burada eskiden `[&:has([role=checkbox])]:pr-0` vardı — ÖLÜ kuraldı: bu panelde
        // seçim kutusu NATIVE `<input type="checkbox">` (bkz. ui/checkbox.tsx gerekçesi) ve
        // native input `role` ÖZNİTELİĞİ taşımaz, dolayısıyla seçici hiç eşleşmiyordu. Üstelik
        // yalnız th'de daraltmak kolonu daraltmazdı (td tam px-4 alıyor → min-content değişmez).
        // Silindi: mevcut simetrik 16px dolgu zaten ölçülen referans sözleşmesiyle uyumlu.
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
  // Referansta hücre dolgusu 24px'e kadar çıkıyor; burada 12px'te tutuldu — bu panelin
  // tabloları 8-12 kolonlu operasyon tabloları, satır başına 95px ekranı kullanılamaz kılardı.
  // Yatay dolgu başlıkla hizalı (px-4).
  //
  // `whitespace-nowrap` ŞART (ölçüldü, /stock 375px): `width:100%` + `table-layout:auto` olan
  // bir tablonun kullanılan genişliği max(kap, tablonun MIN-CONTENT genişliği)'dir. Hücreler
  // sarabildiğinde min-content "kolonun en uzun KELİMESİ" kadar küçülür → tablo daima kaba
  // sığar, sarmalayıcıdaki `overflow-x-auto` HİÇ tetiklenmez ve metin kelime kelime alt satıra
  // dökülür (kap 341px, tablo 862px, hücre 4 satır, satır yüksekliği 85px). Nowrap ile hücre
  // tek satır kalır, kap gerçekten yatay kaydırılır — referansın davranışı budur.
  //
  // Uzun serbest metin taşıyan HÜCRELER bundan muaf tutulur: iç elemana `whitespace-normal`
  // (+ `line-clamp-*`/`max-w-*`) verilir — bkz. security/dead-letter/notifications tabloları.
  return (
    <td
      className={cn('whitespace-nowrap px-4 py-3 align-middle text-foreground/90', className)}
      {...props}
    />
  );
}
