import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Koşullu class birleştirme + Tailwind çakışma çözümü (shadcn deseni). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** ISO tarihi tr-TR biçimler. */
export function formatDate(iso: string | null | undefined, withTime = true): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('tr-TR', {
    dateStyle: 'short',
    ...(withTime ? { timeStyle: 'short' } : {}),
  });
}

/** valid_until geçmiş mi. */
export function isExpired(iso: string | null | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  return !Number.isNaN(d.getTime()) && d.getTime() < Date.now();
}

/** Göreli süre ("3 sa", "2 gün") — bekleme süresi gösterimi (§17). */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - d) / 1000));
  if (s < 60) return 'az önce';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} dk`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} sa`;
  const days = Math.floor(h / 24);
  return `${days} gün`;
}

/** Bekleme süresine göre renk tonu (yeni→ok, yaşlanıyor→amber, eski→kırmızı). */
export function waitTone(iso: string | null | undefined): 'success' | 'warning' | 'danger' | 'muted' {
  if (!iso) return 'muted';
  const h = (Date.now() - new Date(iso).getTime()) / 3_600_000;
  if (h < 2) return 'success';
  if (h < 24) return 'warning';
  return 'danger';
}
