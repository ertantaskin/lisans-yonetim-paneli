'use client';

import * as React from 'react';
import { ShieldAlert, ChevronDown, Loader2 } from 'lucide-react';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';

/**
 * Müşteri risk skoru rozeti (§13, advisory). `/api/risk/<email>` proxy'sinden skoru çeker;
 * band → renk (low=neutral, medium=warning, high=danger). Genişletilince faktör kırılımını
 * (contribution + detail) listeler. TAMAMEN GÖRÜNTÜ: hiçbir otomatik askı/blok aksiyonu YOK —
 * yalnızca operatörü bilgilendirir ("AI/skor önerir, insan karar verir"). API erişilemez veya
 * skor hesaplanamamışsa kibarca "risk verisi yok" durumunu gösterir.
 */

interface RiskFactor {
  key: string;
  label: string;
  contribution: number;
  detail: string;
}
interface CustomerRisk {
  email: string;
  score: number | null;
  band: 'low' | 'medium' | 'high' | null;
  factors: RiskFactor[];
  generatedAt: string | null;
}

const BAND: Record<
  'low' | 'medium' | 'high',
  { variant: 'neutral' | 'warning' | 'danger'; label: string }
> = {
  low: { variant: 'neutral', label: 'düşük risk' },
  medium: { variant: 'warning', label: 'orta risk' },
  high: { variant: 'danger', label: 'yüksek risk' },
};

export function RiskBadge({ email }: { email: string }) {
  const [data, setData] = React.useState<CustomerRisk | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    fetch(`/api/risk/${encodeURIComponent(email)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('http'))))
      .then((d: CustomerRisk) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [email]);

  if (loading) {
    return (
      <Badge variant="outline">
        <Loader2 className="animate-spin" />
        risk hesaplanıyor
      </Badge>
    );
  }

  // Hata / API erişilemez / skor hesaplanamadı → sessizce nötr "veri yok" (aksiyon yok).
  if (error || !data || data.band === null || data.score === null) {
    return (
      <Badge variant="outline">
        <ShieldAlert />
        risk verisi yok
      </Badge>
    );
  }

  const meta = BAND[data.band];
  const hasFactors = data.factors.length > 0;

  return (
    <div className="inline-flex flex-col items-start gap-2">
      <button
        type="button"
        onClick={() => hasFactors && setOpen((v) => !v)}
        disabled={!hasFactors}
        aria-expanded={hasFactors ? open : undefined}
        className={cn('inline-flex', hasFactors ? 'cursor-pointer' : 'cursor-default')}
      >
        <Badge variant={meta.variant}>
          <ShieldAlert />
          {meta.label} · {data.score}
          {hasFactors && (
            <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
          )}
        </Badge>
      </button>

      {open && hasFactors && (
        <div className="w-full min-w-64 rounded-lg border border-border bg-card p-3 shadow-sm">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Risk faktörleri
          </div>
          <ul className="space-y-2">
            {data.factors.map((f) => (
              <li key={f.key} className="flex items-start justify-between gap-3 text-sm">
                <div className="min-w-0">
                  <div className="font-medium text-foreground">{f.label}</div>
                  <div className="text-xs text-muted-foreground">{f.detail}</div>
                </div>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {f.contribution > 0 ? '+' : ''}
                  {f.contribution}
                </span>
              </li>
            ))}
          </ul>
          {data.generatedAt && (
            <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted-foreground">
              {new Date(data.generatedAt).toLocaleString('tr-TR', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </div>
          )}
          <div className="mt-2 text-[11px] text-muted-foreground">
            Yalnız bilgilendirme — otomatik askı/blok yok.
          </div>
        </div>
      )}
    </div>
  );
}
