'use client';
import * as React from 'react';
import { ChevronDown, Plus, X, type LucideIcon } from 'lucide-react';
import { Button } from './button';
import { Card, CardContent } from './card';
import { cn } from '../../lib/utils';

/**
 * "Butonla açılan form" kabuğu (disclosure).
 *
 * NEDEN (kullanıcı geri bildirimi): liste ekranlarındaki "Yeni …" oluşturma formları HEP
 * AÇIK duruyordu; ekranın üstünde sürekli yer kaplayıp asıl içeriği (listeyi) aşağı itiyordu.
 * Oysa oluşturma seyrek bir iş — varsayılan KAPALI, istenince açılır.
 *
 * Gövde açıkken DOM'a girer (kapalıyken hiç render edilmez): form durumu her kapanışta
 * sıfırlanır ve kapalı formdaki alanlar sekme sırasına GİRMEZ (a11y). Alt bileşen sunucudan
 * gelen bir form olabilir — `children` olarak alınır, bu kabuk yalnız açılıp kapanmayı bilir.
 */
export function CollapsiblePanel({
  title,
  icon: Icon = Plus,
  openLabel,
  closeLabel = 'Kapat',
  description,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  icon?: LucideIcon;
  /** Kapalıyken düğmenin metni (varsayılan: başlığın kendisi). */
  openLabel?: string;
  closeLabel?: string;
  description?: string;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();

  if (!open) {
    return (
      <div className={cn('mb-5', className)}>
        <Button variant="outline" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={bodyId}>
          <Icon aria-hidden /> {openLabel ?? title}
        </Button>
        {description && <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  }

  return (
    <Card className={cn('mb-5 max-w-2xl', className)}>
      <CardContent className="p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Icon className="size-4 text-muted-foreground" aria-hidden /> {title}
            </h2>
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setOpen(false)}
            aria-expanded
            aria-controls={bodyId}
          >
            <X aria-hidden /> {closeLabel}
          </Button>
        </div>
        <div id={bodyId}>{children}</div>
      </CardContent>
    </Card>
  );
}

/** Kapalı/açık okunu gerektiren yerler için küçük yardımcı (şu an yalnız tip uyumu). */
export const CollapsibleChevron = ChevronDown;
