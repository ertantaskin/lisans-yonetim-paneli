import type { ReactNode } from 'react';

// Durum → renk (§17: yeşil=bitti, amber=aksiyon bekliyor, kırmızı=sorun).
const STATUS_COLOR: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  fulfilled: 'success',
  active: 'success',
  sent: 'success',
  delivered: 'success',
  partial: 'warning',
  pending: 'warning',
  queued: 'warning',
  suspended: 'warning',
  unmapped: 'danger',
  revoked: 'danger',
  failed: 'danger',
  bounced: 'danger',
  quarantined: 'danger',
};

const STATUS_LABEL: Record<string, string> = {
  fulfilled: 'teslim edildi',
  partial: 'kısmi',
  pending: 'bekliyor',
  unmapped: 'eşlenmemiş',
  revoked: 'iptal',
  active: 'aktif',
  suspended: 'askıda',
  sent: 'gönderildi',
  queued: 'kuyrukta',
  failed: 'başarısız',
};

export function StatusPill({ status }: { status: string }) {
  const color = STATUS_COLOR[status] ?? 'neutral';
  const styles: Record<string, string> = {
    success: 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-success',
    warning: 'bg-[color-mix(in_srgb,var(--warning)_16%,transparent)] text-warning',
    danger: 'bg-[color-mix(in_srgb,var(--destructive)_14%,transparent)] text-destructive',
    neutral: 'bg-accent text-accent-foreground',
  };
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${styles[color]}`}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <section
      className={`rounded-xl border border-border bg-card p-5 shadow-sm ${className}`}
    >
      {children}
    </section>
  );
}

export function PageHeader({ title, desc }: { title: string; desc?: string }) {
  return (
    <header className="mb-6">
      <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      {desc && <p className="mt-1 text-sm text-foreground/60">{desc}</p>}
    </header>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
