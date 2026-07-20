import * as React from 'react';

export function PageHeader({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-2">{children}</div>}
    </header>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-14 text-center">
      {Icon && (
        <span className="mb-1 flex size-11 items-center justify-center rounded-full bg-ink/[0.05] text-muted">
          <Icon className="size-5" />
        </span>
      )}
      <div className="text-sm font-medium text-ink">{title}</div>
      {description && <div className="max-w-sm text-xs text-muted">{description}</div>}
    </div>
  );
}
