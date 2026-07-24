'use client';
import * as React from 'react';
import {
  Sparkles,
  Bot,
  Loader2,
  TriangleAlert,
  Play,
  Copy,
  Check,
  LifeBuoy,
  Database,
  ShoppingCart,
  PackageOpen,
  ShieldAlert,
  MailWarning,
  Boxes,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { Input, Textarea, Label } from '../../components/ui/input';
import { Badge, type BadgeProps } from '../../components/ui/badge';
import { aiCategoryLabel, aiPriorityLabel } from '../../lib/labels';
import { StatTile } from '../../components/ui/stat-tile';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../components/ui/table';

// ── Uç yanıt tipleri (API sözleşmesi, §15) ──────────────────────────────────
interface AiStatus {
  enabled: boolean;
  model: string | null;
}
interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}
type ReportResult =
  | { sql: string; ok: true; result: SqlResult }
  | { sql: string; ok: false; error: string };
interface DailyMetrics {
  todayOrders: number;
  openReplacements: number;
  securityEvents24h: number;
  failedOutbox: number;
  availableStock: number;
}
interface DailySummary {
  metrics: DailyMetrics;
  paragraph: string | null;
  aiEnabled: boolean;
}
interface SupportSuggestion {
  category: string;
  priority: string;
  draftReply: string;
}

/** Hata gövdesinden okunabilir bir mesaj çıkarır (proxy {error} veya Nest {message}). */
function errText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: unknown; message?: unknown };
    if (typeof b.error === 'string') return b.error;
    if (typeof b.message === 'string') return b.message;
  }
  return fallback;
}

/** Ham SQL sonucu hücresini güvenle metne çevirir (null/obje dahil). Sır göstermez —
 *  payload_enc şifreli kolonlar sorguya dahil edilmez (§15, sunucu şema özeti). */
function cellText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function AiPanel() {
  const [status, setStatus] = React.useState<AiStatus | null>(null);
  const [statusLoading, setStatusLoading] = React.useState(true);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/ai/status', { cache: 'no-store' });
        const data = (await res.json()) as AiStatus;
        if (alive) setStatus(data);
      } catch {
        if (alive) setStatus({ enabled: false, model: null });
      } finally {
        if (alive) setStatusLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const enabled = status?.enabled ?? false;

  return (
    <div className="flex flex-col gap-6">
      {/* Durum bandı */}
      {statusLoading ? (
        <Alert variant="info">
          <Loader2 className="animate-spin" />
          <AlertDescription>AI durumu kontrol ediliyor…</AlertDescription>
        </Alert>
      ) : enabled ? (
        <Alert variant="success">
          <Sparkles />
          <div>
            <AlertTitle>AI aktif</AlertTitle>
            <AlertDescription>
              Aktif model: <span className="font-mono">{status?.model ?? '—'}</span>. Öneriler
              danışma amaçlıdır; her eylemi bir yönetici onaylar (§15).
            </AlertDescription>
          </div>
        </Alert>
      ) : (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>AI kapalı</AlertTitle>
            <AlertDescription>
              Aktive etmek için sunucuda{' '}
              <span className="font-mono">AI_ENABLED=true</span> +{' '}
              <span className="font-mono">ANTHROPIC_API_KEY</span> ayarlayın. Aşağıdaki bölümler
              metrikleri gösterir ancak AI önerileri üretmez.
            </AlertDescription>
          </div>
        </Alert>
      )}

      <ReportSection enabled={enabled} />
      <DailySummarySection />
      <TriageSection enabled={enabled} />
    </div>
  );
}

// ── (a) NL → Rapor ──────────────────────────────────────────────────────────
function ReportSection({ enabled }: { enabled: boolean }) {
  const [question, setQuestion] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ReportResult | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    const q = question.trim();
    if (q.length < 3 || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/ai/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: q }),
      });
      const data = (await res.json().catch(() => null)) as ReportResult | { error?: string } | null;
      if (!res.ok || !data || !('sql' in data)) {
        setError(errText(data, `Rapor üretilemedi (${res.status}).`));
        return;
      }
      setResult(data);
    } catch {
      setError('Ağ hatası — rapor üretilemedi.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="size-4 text-muted-foreground" />
          Doğal dilde rapor
        </CardTitle>
        <CardDescription>
          Türkçe bir soru sorun; AI salt-okunur bir SELECT üretir ve güvenle çalıştırır. Üretilen
          SQL her zaman gösterilir; yalnız salt-okunur sorgular çalışır.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-report-q">Soru</Label>
          <Textarea
            id="ai-report-q"
            rows={2}
            placeholder="Örn: Bugün oluşturulan siparişleri duruma göre say."
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={loading}
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            onClick={() => void run()}
            disabled={!enabled || loading || question.trim().length < 3}
          >
            {loading ? <Loader2 className="animate-spin" /> : <Play />}
            {loading ? 'Çalışıyor…' : 'Raporu çalıştır'}
          </Button>
          {!enabled && (
            <span className="text-xs text-muted-foreground">AI kapalıyken sorgu üretilemez.</span>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            <div>
              <div className="mb-1.5 text-xs font-medium text-foreground/70">Üretilen SQL</div>
              <pre className="overflow-x-auto rounded-md border border-border bg-muted/50 p-3 text-xs">
                <code className="font-mono text-foreground">{result.sql}</code>
              </pre>
            </div>

            {result.ok ? (
              <ResultTable result={result.result} />
            ) : (
              <Alert variant="destructive">
                <TriangleAlert />
                <div>
                  <AlertTitle>Sorgu çalıştırılamadı</AlertTitle>
                  <AlertDescription className="font-mono">{result.error}</AlertDescription>
                </div>
              </Alert>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ResultTable({ result }: { result: SqlResult }) {
  if (result.columns.length === 0 || result.rowCount === 0) {
    return <p className="text-sm text-muted-foreground">Sorgu sonuç döndürmedi.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-md border border-border">
        <Table>
          <TableHeader>
            <TableRow>
              {result.columns.map((c) => (
                <TableHead key={c}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.map((row, i) => (
              <TableRow key={i}>
                {result.columns.map((c) => (
                  <TableCell key={c} className="font-mono text-xs">
                    {cellText(row[c])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <p className="text-xs text-muted-foreground">
        {result.rowCount} satır{result.truncated && ' (kısaltıldı — daha fazlası var)'}
      </p>
    </div>
  );
}

// ── (b) Günlük anomali özeti ────────────────────────────────────────────────
const METRIC_TILES: Array<{
  key: keyof DailyMetrics;
  label: string;
  icon: LucideIcon;
  tone: 'accent' | 'success' | 'warning' | 'danger' | 'neutral';
}> = [
  { key: 'todayOrders', label: 'Bugünkü sipariş', icon: ShoppingCart, tone: 'accent' },
  { key: 'openReplacements', label: 'Açık talep', icon: LifeBuoy, tone: 'warning' },
  { key: 'securityEvents24h', label: 'Güvenlik (24s)', icon: ShieldAlert, tone: 'warning' },
  { key: 'failedOutbox', label: 'Başarısız webhook', icon: MailWarning, tone: 'danger' },
  { key: 'availableStock', label: 'Atanabilir stok', icon: Boxes, tone: 'neutral' },
];

function DailySummarySection() {
  const [data, setData] = React.useState<DailySummary | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/ai/daily-summary', { cache: 'no-store' });
        const body = (await res.json().catch(() => null)) as DailySummary | { error?: string } | null;
        if (!res.ok || !body || !('metrics' in body)) {
          if (alive) setError(errText(body, `Özet alınamadı (${res.status}).`));
          return;
        }
        if (alive) setData(body);
      } catch {
        if (alive) setError('Ağ hatası — günlük özet alınamadı.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-muted-foreground" />
          Günlük anomali özeti
        </CardTitle>
        <CardDescription>
          Operasyon metrikleri her zaman gösterilir; AI açıksa sapmaları yorumlayan kısa bir
          paragraf eklenir.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Özet yükleniyor…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : data ? (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              {METRIC_TILES.map((t) => (
                <StatTile
                  key={t.key}
                  label={t.label}
                  value={data.metrics[t.key]}
                  icon={t.icon}
                  tone={t.tone}
                />
              ))}
            </div>
            {data.paragraph ? (
              <Alert variant="info">
                <Sparkles />
                <div>
                  <AlertTitle>AI yorumu</AlertTitle>
                  <AlertDescription>{data.paragraph}</AlertDescription>
                </div>
              </Alert>
            ) : (
              <p className="text-sm text-muted-foreground">
                {data.aiEnabled
                  ? 'AI yorumu bu sefer üretilemedi — metrikler yukarıda.'
                  : 'AI kapalı — yalnız metrikler gösteriliyor.'}
              </p>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ── (c) Destek triyaj demosu ────────────────────────────────────────────────
const PRIORITY_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  yuksek: 'danger',
  orta: 'warning',
  dusuk: 'neutral',
};

function TriageSection({ enabled }: { enabled: boolean }) {
  const [id, setId] = React.useState('');
  const [loading, setLoading] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<SupportSuggestion | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  const run = async () => {
    const val = id.trim();
    if (val.length === 0 || loading) return;
    setLoading(true);
    setError(null);
    setSuggestion(null);
    setCopied(false);
    try {
      const res = await fetch(`/api/ai/support/${encodeURIComponent(val)}/suggest`, {
        method: 'POST',
      });
      const data = (await res.json().catch(() => null)) as
        | SupportSuggestion
        | { error?: string }
        | null;
      if (!res.ok || !data || !('draftReply' in data)) {
        setError(errText(data, `Öneri üretilemedi (${res.status}).`));
        return;
      }
      setSuggestion(data);
    } catch {
      setError('Ağ hatası — öneri üretilemedi.');
    } finally {
      setLoading(false);
    }
  };

  const copy = async () => {
    if (!suggestion) return;
    try {
      await navigator.clipboard.writeText(suggestion.draftReply);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* pano erişimi yoksa sessizce yut — metin zaten seçilebilir */
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Destek triyaj önerisi
        </CardTitle>
        <CardDescription>
          Bir değişim/garanti talebinin kimliğini girin; AI kategori + öncelik belirler ve müşteriye
          bir TASLAK cevap yazar. Otomatik gönderim yok — bir yönetici düzenler ve gönderir.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ai-triage-id">Talep kimliği (replacement id)</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="ai-triage-id"
              placeholder="örn. 3f2a…-uuid"
              value={id}
              onChange={(e) => setId(e.target.value)}
              disabled={loading}
              className="font-mono sm:max-w-md"
            />
            <Button
              onClick={() => void run()}
              disabled={!enabled || loading || id.trim().length === 0}
              className="shrink-0"
            >
              {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
              {loading ? 'Öneriliyor…' : 'Öneri üret'}
            </Button>
          </div>
          {!enabled && (
            <span className="text-xs text-muted-foreground">AI kapalıyken öneri üretilemez.</span>
          )}
        </div>

        {error && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {suggestion && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline">{aiCategoryLabel(suggestion.category)}</Badge>
              <Badge variant={PRIORITY_VARIANT[suggestion.priority] ?? 'neutral'}>
                Öncelik: {aiPriorityLabel(suggestion.priority)}
              </Badge>
            </div>
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="ai-triage-draft">Taslak cevap</Label>
                <Button variant="ghost" size="sm" onClick={() => void copy()}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Kopyalandı' : 'Kopyala'}
                </Button>
              </div>
              <Textarea id="ai-triage-draft" rows={6} readOnly value={suggestion.draftReply} />
            </div>
          </div>
        )}

        {!suggestion && !error && !loading && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <PackageOpen className="size-4" />
            Bir talep kimliği girip öneri üretin.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
