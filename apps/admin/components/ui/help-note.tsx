import * as React from 'react';
import { ChevronRight, HelpCircle } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * EKRAN İÇİ REHBER PRİMİTİFLERİ.
 *
 * NEDEN (kullanıcı geri bildirimi): "ekran çok karışık, ne işe yaradığı anlaşılmıyor;
 * rehber niteliğinde açıklamalar olsun". Panelde ayrı bir `/guide` sayfası var ama operatör
 * iş yaparken oraya gitmiyor — açıklama İŞİN YANINDA olmalı.
 *
 * İki ayrı ihtiyaç, iki ayrı bileşen:
 *  - `HowItWorks` → sürecin AKIŞINI 3-4 adımda özetler (hep görünür, çok kısa).
 *  - `HelpNote`   → uzun/ayrıntılı açıklamayı KATLAR (varsayılan kapalı, yer kaplamaz).
 *
 * İkisi de SUNUCU bileşenidir (`'use client'` YOK) ve JavaScript gerektirmez: `HelpNote`
 * native `<details>` kullanır. Böylece sayfanın istemci paketine hiç yük binmez ve JS
 * yüklenmeden önce de açılıp kapanabilir.
 */

export interface HowItWorksStep {
  /** Kısa başlık — "ne oluyor". */
  title: string;
  /** Tek cümle — "operatör ne yapıyor / sistem ne yapıyor". */
  text: React.ReactNode;
}

/**
 * Numaralı akış şeridi. Geniş ekranda yan yana (süreç soldan sağa okunur), dar ekranda alt alta.
 * Adım sayısı 3-4'ü geçmemeli; geçiyorsa süreç zaten fazla karmaşıktır.
 *
 * `compact` (kullanıcı geri bildirimi: "çok yer kaplıyor, daha sade minimal olmalı"):
 * varsayılan olarak YALNIZ tek satırlık adım başlıkları görünür (ör. "1 Panel ürünü →
 * 2 Stok girişi → 3 Mağaza eşlemesi"); cümleler native `<details>` altında durur ve
 * isteyen açar. Rehber ekranda KALIR (öğrenilebilirlik kaybolmaz) ama üç kutuluk dikey
 * yer yerine tek satır harcar. Ekranın esas işi listedir, rehber onu itmemelidir.
 */
export function HowItWorks({
  steps,
  className,
  compact = false,
  detailsLabel = 'Nasıl çalışır?',
}: {
  steps: HowItWorksStep[];
  className?: string;
  compact?: boolean;
  /** `compact` modda açma bağlantısının metni. */
  detailsLabel?: string;
}) {
  if (compact) {
    return (
      <details className={cn('rounded-lg border border-border bg-card', className)}>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
          {steps.map((s, i) => (
            <span key={s.title} className="inline-flex items-center gap-1.5">
              {i > 0 && <span aria-hidden className="text-border">›</span>}
              <span
                aria-hidden
                className="flex size-4 items-center justify-center rounded-full bg-secondary text-[10px] font-semibold tabular-nums text-secondary-foreground"
              >
                {i + 1}
              </span>
              <span className="font-medium text-foreground">{s.title}</span>
            </span>
          ))}
          <span className="ml-auto shrink-0 underline underline-offset-2">{detailsLabel}</span>
        </summary>
        <ol className="grid gap-px border-t border-border bg-border sm:grid-cols-3">
          {steps.map((s) => (
            <li key={s.title} className="bg-card px-3 py-2">
              <p className="text-xs font-medium leading-tight text-foreground">{s.title}</p>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{s.text}</p>
            </li>
          ))}
        </ol>
      </details>
    );
  }

  return (
    <ol
      className={cn(
        'grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3',
        className,
      )}
    >
      {steps.map((s, i) => (
        <li key={s.title} className="flex gap-2.5 bg-card p-3">
          <span
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold tabular-nums text-secondary-foreground"
            aria-hidden
          >
            {i + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium leading-tight text-foreground">{s.title}</p>
            <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{s.text}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

/**
 * Katlanır ayrıntı kutusu. Uzun kural/istisna metinleri ekranı doldurmasın diye kapalı başlar.
 *
 * `<details>` seçilmesinin sebebi yalnız basitlik değil: bu panelin doğrulama tarayıcısında
 * CSS animasyonları ve klavye olayları çalışmıyor (belgelenmiş sınır) — native disclosure
 * hem orada hem gerçek tarayıcıda tıklamayla açılır, test edilebilir kalır.
 */
export function HelpNote({
  title = 'Bu ekran nasıl çalışır?',
  children,
  className,
  defaultOpen = false,
}: {
  title?: string;
  children: React.ReactNode;
  className?: string;
  defaultOpen?: boolean;
}) {
  return (
    <details
      open={defaultOpen}
      className={cn('group rounded-lg border border-border bg-card', className)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <HelpCircle className="size-3.5 shrink-0" aria-hidden />
        {title}
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
      </summary>
      <div className="space-y-2 border-t border-border px-3 py-2.5 text-xs leading-relaxed text-muted-foreground [&_strong]:font-medium [&_strong]:text-foreground">
        {children}
      </div>
    </details>
  );
}

/**
 * Terim → anlam listesi (rozet/durum sözlüğü). Operatör "bu rozet ne demek" diye
 * sormasın diye ekranın kendi içinde durur.
 */
export function LegendList({
  items,
  className,
}: {
  items: Array<{ term: React.ReactNode; text: React.ReactNode }>;
  className?: string;
}) {
  return (
    <dl className={cn('grid gap-1.5 sm:grid-cols-2', className)}>
      {items.map((it, i) => (
        <div key={i} className="flex items-start gap-2">
          <dt className="shrink-0">{it.term}</dt>
          <dd className="min-w-0 text-xs leading-snug text-muted-foreground">{it.text}</dd>
        </div>
      ))}
    </dl>
  );
}
