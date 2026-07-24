import * as React from 'react';
import { cn } from '../../lib/utils';
import { Label } from './input';

/**
 * Field — etiketli form alanı sarmalayıcısı (tasarım sistemi §17). Görünür bir etiket,
 * opsiyonel yardım metni ve zorunluluk işareti ile HERHANGİ bir kontrolü (Input/Textarea/
 * select) sarar. Amaç: "hangi alan ne işe yarıyor" her zaman görünür olsun — placeholder-only
 * alanlar (etiketsiz) yasak. `hint` kontrolün ALTINDA sessiz açıklama olarak görünür.
 *
 *   <Field label="Garanti süresi (gün)" htmlFor="warranty" hint="'Sorun bildir' penceresi. Boş = garanti yok.">
 *     <Input id="warranty" name="warrantyDays" type="number" />
 *   </Field>
 */
export function Field({
  label,
  htmlFor,
  hint,
  required,
  error,
  className,
  children,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  /** Kontrolün altında görünen yardım/açıklama metni (ne işe yaradığını anlatır). */
  hint?: React.ReactNode;
  required?: boolean;
  /** Alan-özel hata (varsa hint yerine kırmızı gösterilir). */
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={htmlFor} className="text-foreground">
        {label}
        {required && (
          <span className="text-destructive" aria-hidden>
            {' '}
            *
          </span>
        )}
      </Label>
      {children}
      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : (
        hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      )}
    </div>
  );
}

/**
 * FormSection — bir formu anlamlı gruplara böler (ör. "Temel bilgiler", "Süre & garanti").
 * Başlık + opsiyonel açıklama; uzun formların "üst üste yığılmış duvar" hissini kırar.
 * Boxed=true → hafif çerçeveli kutu (alt-editörler için, ör. hesap alanları şeması).
 */
export function FormSection({
  title,
  description,
  boxed = false,
  className,
  children,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  boxed?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        'space-y-3',
        boxed && 'rounded-lg border border-border bg-muted/30 p-4',
        className,
      )}
    >
      <div className="space-y-0.5">
        <h4 className="text-sm font-semibold text-foreground">{title}</h4>
        {description && <p className="text-xs leading-relaxed text-muted-foreground">{description}</p>}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/**
 * FieldRow — yan yana (grid) alanlar için hizalı satır. Dar ekranda tek sütuna iner.
 */
export function FieldRow({
  cols = 2,
  className,
  children,
}: {
  cols?: 2 | 3;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid gap-3',
        cols === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3',
        className,
      )}
    >
      {children}
    </div>
  );
}
