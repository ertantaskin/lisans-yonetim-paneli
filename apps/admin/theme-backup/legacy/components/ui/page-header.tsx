import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * PageHeader — her sayfanın üst başlığı. Opsiyonel `icon` (o sayfanın sol-menü ikonuyla
 * AYNI olmalı) başlığın soluna yuvarlak bir ikon rozeti koyar → kullanıcı bir bakışta
 * "hangi ekrandayım" görür (sol menü ↔ başlık görsel bağı). Sağdaki `children` = eylemler.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  children,
}: {
  title: string;
  description?: string;
  icon?: LucideIcon;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="flex items-start gap-3">
        {Icon && (
          <span
            className="hidden size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-foreground shadow-sm sm:flex"
            aria-hidden
          >
            <Icon className="size-5" />
          </span>
        )}
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-1 max-w-2xl text-sm text-muted-foreground">{description}</p>}
        </div>
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  /** Opsiyonel eylem (ör. "Yeni Ürün" butonu) — boş durumdan çıkışı kolaylaştırır. */
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {Icon && (
        <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <Icon className="size-5" />
        </span>
      )}
      <div className="text-sm font-medium text-foreground">{title}</div>
      {description && <div className="max-w-sm text-xs text-muted-foreground">{description}</div>}
      {children && <div className="mt-2">{children}</div>}
    </div>
  );
}
