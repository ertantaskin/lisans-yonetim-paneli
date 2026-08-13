'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Mail,
  MessageCircleQuestion,
  MessageSquare,
  Repeat2,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  TriangleAlert,
  UserRound,
} from 'lucide-react';
import type { ReplacementRow, SupportStatus } from '../../app/support/queries';
import {
  approveReplacementAction,
  rejectReplacementAction,
  requestInfoReplacementAction,
  type ActionState,
} from '../../app/support/actions';
import { aiCategoryLabel, aiPriorityLabel, supportStatusLabel } from '../../lib/labels';
import { formatDate, relativeTime } from '../../lib/utils';
import { useAnnouncer } from '../a11y/announcer';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge, StatusBadge, type BadgeProps } from '../ui/badge';
import { Button } from '../ui/button';
import { Label, Textarea } from '../ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { SupportThread } from './support-thread';

/*
 * Destek talebi DETAY paneli (§13).
 *
 * Kullanıcı şikâyeti: "admin tarafında biraz karışık duruyor, CEVAP VERME GİBİ BİR ŞANSIMIZ
 * OLMUYOR, değişim olayı çok alakasız yerde gibi". Bu panel operatörün kuyruktan ÇIKMADAN
 * tek yerde: (1) talebi okumasını, (2) yanıt/iç not yazmasını, (3) onayla/reddet/bilgi-iste
 * kararını vermesini sağlar.
 *
 * NOT: Aşağıdaki küçük rozet yardımcıları (durum / garanti / suistimal) kuyruk tablosuyla
 * PAYLAŞILIR (components/support-table.tsx buradan import eder) — destek ekranının durum dili
 * tek dosyada tanımlı kalsın.
 */

// ── Paylaşılan rozetler ─────────────────────────────────────────────────────

/**
 * Durum rozeti — panelin TEK rozet bileşenine (StatusBadge) devredilir.
 *
 * Buradaki yerel ton/ikon sözlüğü paylaşılan haritayla BİREBİR aynıydı; iki kopya
 * tutmak yeni bir durum eklendiğinde sessizce ayrışma üretir. Etiket kaynağı da aynı
 * (BADGE_STATUS ve SUPPORT_STATUS bu dört anahtarda aynı Türkçe metni verir).
 */
export function SupportStatusBadge({ status }: { status: SupportStatus }) {
  return <StatusBadge status={status} />;
}

export function WarrantyBadge({ within }: { within: boolean }) {
  return within ? (
    <Badge variant="success">
      <ShieldCheck /> Garanti içi
    </Badge>
  ) : (
    <Badge variant="warning">
      <TriangleAlert /> Garanti dışı
    </Badge>
  );
}

/** Suistimal işareti eşikleri — YALNIZ görsel uyarı, otomatik yaptırım YOK (§15). */
export const ABUSE_WARN = 3;
export const ABUSE_HIGH = 5;

export function abuseText(count: number): string {
  return `Bu müşteri son 90 günde ${count} değişim talebi oluşturdu. Panel otomatik bir kısıt uygulamaz — kararı siz verirsiniz.`;
}

/** Talep açık/işlem alınabilir mi (approved/rejected terminaldir). */
export function isActionable(status: SupportStatus): boolean {
  return status === 'open' || status === 'info_requested';
}

/**
 * Göreli süre + "önce" eki. `relativeTime` sıfıra yakın farkta "az önce" döndürüyor →
 * düz birleştirme "az önce önce" üretiyordu; bu yardımcı o durumu tekilleştirir.
 */
export function agoText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const rel = relativeTime(iso);
  return rel === 'az önce' || rel === '—' ? rel : `${rel} önce`;
}

// ── Detay paneli ────────────────────────────────────────────────────────────

type Mode = 'idle' | 'approve' | 'reject' | 'request-info';

const NOTE_META: Record<
  'reject' | 'request-info',
  { label: string; help: string; cta: string; placeholder: string }
> = {
  reject: {
    label: 'Red gerekçesi',
    help: 'Müşteriye görünür ve mail ile iletilir. Neden değişim yapılmadığını açıkça yazın.',
    cta: 'Reddet',
    placeholder: 'Ör. Lisans farklı bir cihazda aktif edilmiş, garanti kapsamı dışında…',
  },
  'request-info': {
    label: 'İstenen bilgi',
    help: 'Müşteriye görünür ve mail ile iletilir. Talep "Bilgi bekleniyor" durumuna geçer.',
    cta: 'Bilgi İste',
    placeholder: 'Ör. Hata ekran görüntüsünü ve aktivasyon hata kodunu paylaşır mısınız?',
  },
};

export function SupportDetailSheet({
  row,
  open,
  onOpenChange,
}: {
  row: ReplacementRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Erişilebilir ad SheetTitle'dan gelir (Radix aria-labelledby) — ayrıca aria-label VERİLMEZ. */}
      <SheetContent side="right" className="w-full gap-0 p-0 sm:max-w-xl md:max-w-2xl">
        {row ? (
          // key: farklı talebe geçildiğinde yerel durum (not/mod/sonuç) sıfırlansın.
          <SupportDetailBody key={row.id} row={row} />
        ) : (
          <div className="p-6">
            <SheetTitle>Destek talebi</SheetTitle>
            <SheetDescription>Talep bulunamadı.</SheetDescription>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function SupportDetailBody({ row }: { row: ReplacementRow }) {
  const [mode, setMode] = React.useState<Mode>('idle');
  const [note, setNote] = React.useState('');
  const [result, setResult] = React.useState<ActionState | null>(null);
  const [pending, startTransition] = React.useTransition();
  // Durum aksiyonu yazışmaya SİSTEM satırı ekler (API) → panelde de görünsün diye remount.
  const [threadKey, setThreadKey] = React.useState(0);
  const announce = useAnnouncer();
  const noteRef = React.useRef<HTMLTextAreaElement>(null);

  const actionable = isActionable(row.status);

  React.useEffect(() => {
    if (mode === 'reject' || mode === 'request-info') noteRef.current?.focus();
  }, [mode]);

  const run = (fn: () => Promise<ActionState>) => {
    setResult(null);
    startTransition(async () => {
      const res = await fn();
      setResult(res);
      announce(res.ok ? (res.message ?? 'İşlem tamamlandı') : (res.error ?? 'İşlem başarısız'), {
        assertive: !res.ok,
      });
      if (res.ok) {
        setMode('idle');
        setNote('');
        setThreadKey((k) => k + 1);
      }
    });
  };

  const submitNote = () => {
    if (!note.trim()) {
      const msg = mode === 'reject' ? 'Red gerekçesi zorunlu' : 'İstenen bilgi zorunlu';
      setResult({ ok: false, error: msg });
      announce(msg, { assertive: true });
      return;
    }
    run(() =>
      mode === 'reject'
        ? rejectReplacementAction(row.id, note, row.orderId)
        : requestInfoReplacementAction(row.id, note, row.orderId),
    );
  };

  return (
    <>
      <SheetHeader className="border-b border-border px-4 pb-3 pr-12 pt-4">
        <SheetTitle className="flex flex-wrap items-center gap-2 text-base">
          Destek talebi
          <SupportStatusBadge status={row.status} />
          {row.unansweredByAdmin && (
            <Badge variant="warning">
              <MessageSquare /> Yanıt bekliyor
            </Badge>
          )}
        </SheetTitle>
        <SheetDescription>
          Müşterinin bildirdiği arızalı lisans/hesap talebi — okuyun, yanıtlayın, karar verin.
        </SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        {/* Özet */}
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2.5 text-sm sm:grid-cols-2">
          <Row icon={UserRound} label="Müşteri">
            <span className="block truncate" title={row.customerEmail}>
              {row.customerEmail || '—'}
            </span>
          </Row>
          <Row icon={ShoppingBag} label="Sipariş">
            {row.orderId ? (
              <Link
                href={`/orders/${row.orderId}`}
                className="font-medium tabular-nums text-primary underline-offset-2 hover:underline"
                title="Sipariş detayına git"
              >
                {row.remoteOrderId ? `#${row.remoteOrderId}` : 'Siparişi aç'}
              </Link>
            ) : (
              <span className="text-muted-foreground">—</span>
            )}
          </Row>
          {/* MAĞAZA BAĞLAMI: sipariş no'ları sitelere göre çakışabilir — hangi mağaza olduğu
              karar (onayla/reddet) ekranında görünmeli. Alan gelmezse '—' (uydurma değer yok). */}
          <Row icon={Globe} label="Site">
            <span className="block truncate" title={row.siteDomain ?? undefined}>
              {row.siteDomain ?? <span className="text-muted-foreground">—</span>}
            </span>
          </Row>
          <Row icon={ShieldCheck} label="Garanti">
            <WarrantyBadge within={row.withinWarranty} />
          </Row>
          <Row icon={Clock} label="Oluşturma">
            <span className="tabular-nums" title={formatDate(row.createdAt)}>
              {formatDate(row.createdAt)}{' '}
              <span className="text-muted-foreground">({agoText(row.createdAt)})</span>
            </span>
          </Row>
          {/* ÜRÜN: "Onayla" AYNI üründen taze lisans atar → hangi üründe stok gerektiği
              karar ANINDA görünsün (eskiden 409 "stok yok" ile sonradan öğreniliyordu). */}
          <Row icon={KeyRound} label="İlgili lisans">
            {row.productName ? (
              <span className="block min-w-0">
                {row.productId ? (
                  <Link
                    href={`/products/${row.productId}`}
                    className="text-primary underline-offset-2 hover:underline"
                    title="Ürün detayına git (stok durumu)"
                  >
                    {row.productName}
                  </Link>
                ) : (
                  row.productName
                )}
                {row.productSku && (
                  <span className="ml-1.5 text-xs text-muted-foreground">{row.productSku}</span>
                )}
                <span className="block text-xs text-muted-foreground">
                  {row.assignmentId
                    ? 'Siparişteki tek bir lisansa bağlı'
                    : 'Belirli bir lisansa bağlı değil'}
                </span>
              </span>
            ) : row.assignmentId ? (
              <span className="text-muted-foreground">Siparişteki tek bir lisansa bağlı</span>
            ) : (
              <span className="text-muted-foreground">Belirli bir lisansa bağlı değil</span>
            )}
          </Row>
          <Row icon={Repeat2} label="Bu müşteriden 90 günde">
            {/* 0 = API bu alanı döndürmedi (eski sürüm) → uydurma sayı gösterme. */}
            <span className="tabular-nums">
              {row.customerRequestCount90d > 0 ? `${row.customerRequestCount90d} talep` : '—'}
            </span>
          </Row>
        </dl>

        {/* Talep metni */}
        <div className="rounded-lg border border-border bg-muted/20 p-3">
          <h3 className="mb-1 text-xs font-medium text-muted-foreground">Müşterinin bildirimi</h3>
          <p className="whitespace-pre-wrap break-words text-sm text-foreground">
            {row.reason || '—'}
          </p>
        </div>

        {row.resolutionNote && (
          <div className="rounded-lg border border-border p-3">
            <h3 className="mb-1 text-xs font-medium text-muted-foreground">Çözüm / karar notu</h3>
            <p className="whitespace-pre-wrap break-words text-sm text-foreground">
              {row.resolutionNote}
            </p>
          </div>
        )}

        {/* Suistimal İŞARETİ — otomatik yaptırım YOK (§15) */}
        {row.customerRequestCount90d >= ABUSE_WARN && (
          <Alert variant={row.customerRequestCount90d >= ABUSE_HIGH ? 'destructive' : 'warning'}>
            <TriangleAlert />
            <div className="min-w-0 flex-1">
              <AlertTitle>Sık değişim talebi</AlertTitle>
              <AlertDescription>{abuseText(row.customerRequestCount90d)}</AlertDescription>
            </div>
          </Alert>
        )}

        {!row.assignmentId && actionable && (
          <Alert variant="warning">
            <TriangleAlert />
            <div className="min-w-0 flex-1">
              <AlertTitle>Otomatik değişim yapılamaz</AlertTitle>
              <AlertDescription>
                Talep belirli bir lisansa bağlı değil. Onay yerine sipariş detayındaki ilgili
                lisansta “Değiştir” işlemini kullanın.
              </AlertDescription>
            </div>
          </Alert>
        )}

        {/* AI triyaj önerisi — talep numarası artık ELLE kopyalanmıyor (§15: AI önerir, insan onaylar) */}
        <AiSuggestBlock requestId={row.id} />

        {/* Yazışma — cevap + iç not (kullanıcı şikâyetinin ana çözümü) */}
        <SupportThread key={threadKey} requestId={row.id} orderId={row.orderId} compact />
      </div>

      {/* Karar alanı */}
      <div className="space-y-3 border-t border-border bg-card px-4 py-3">
        {result && (
          <p
            className={`flex items-start gap-1.5 text-xs font-medium ${
              result.ok ? 'text-success' : 'text-destructive'
            }`}
            role="status"
          >
            {result.ok ? (
              <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden />
            ) : (
              <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
            )}
            {result.ok ? (result.message ?? 'İşlem tamamlandı') : (result.error ?? 'İşlem başarısız')}
          </p>
        )}

        {!actionable ? (
          <p className="text-xs text-muted-foreground">
            Bu talep kapandı ({supportStatusLabel(row.status)}). Kayıt için yazışmaya hâlâ yanıt
            veya iç not yazabilirsiniz.
          </p>
        ) : mode === 'idle' ? (
          <>
            <p className="text-xs text-muted-foreground">
              <strong className="font-medium text-foreground">Onaylamak</strong> eski lisansı geri
              alır ve aynı üründen TAZE bir lisans atar. Stok yoksa işlem yapılmaz (eski lisans
              korunur).
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => setMode('approve')} disabled={pending}>
                <CheckCircle2 /> Onayla (değişim yap)
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setMode('request-info')}
                disabled={pending}
              >
                <MessageCircleQuestion /> Bilgi İste
              </Button>
              <Button
                variant="danger-outline"
                size="sm"
                onClick={() => setMode('reject')}
                disabled={pending}
              >
                <Ban /> Reddet
              </Button>
            </div>
          </>
        ) : mode === 'approve' ? (
          <div className="space-y-2">
            <p className="text-xs text-foreground">
              Değişim onaylansın mı? Mevcut lisans geri alınır (karantinaya düşer) ve aynı üründen
              taze bir lisans atanıp müşteriye iletilir. Stok yoksa işlem yapılmaz, eski lisans
              korunur. Açıklama eklemek isterseniz önce yazışmadan yanıt yazın.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                onClick={() => run(() => approveReplacementAction(row.id, row.orderId))}
                disabled={pending}
              >
                <CheckCircle2 /> {pending ? 'İşleniyor…' : 'Evet, değişimi onayla'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setMode('idle')} disabled={pending}>
                Vazgeç
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`support-note-${row.id}`}>{NOTE_META[mode].label}</Label>
            <p className="text-xs text-muted-foreground">{NOTE_META[mode].help}</p>
            <Textarea
              id={`support-note-${row.id}`}
              ref={noteRef}
              rows={3}
              maxLength={4000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={NOTE_META[mode].placeholder}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant={mode === 'reject' ? 'danger' : 'default'}
                size="sm"
                onClick={submitNote}
                disabled={pending}
              >
                {mode === 'reject' ? <Ban /> : <MessageCircleQuestion />}
                {pending ? 'İşleniyor…' : NOTE_META[mode].cta}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setMode('idle');
                  setNote('');
                }}
                disabled={pending}
              >
                Vazgeç
              </Button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/* ── AI triyaj önerisi (§15) ────────────────────────────────────────────────
 *
 * Neden burada: /ai ekranındaki triyaj bölümü operatörden "talep numarası" (UUID) istiyordu
 * ama bu numara panelin HİÇBİR ekranında görünmüyordu → özellik pratikte kullanılamıyordu.
 * Triyaj zaten destek ekranından tetiklenmesi gereken bir iş; buton talebin id'sini DOĞRUDAN
 * gönderir. Öneri YALNIZ TASLAKTIR: otomatik gönderim/durum değişikliği YOK — operatör metni
 * kopyalayıp yazışmadan kendi gönderir.
 */
interface AiSuggestion {
  category: string;
  priority: string;
  draftReply: string;
}

const PRIORITY_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  yuksek: 'danger',
  orta: 'warning',
  dusuk: 'neutral',
};

function AiSuggestBlock({ requestId }: { requestId: string }) {
  // null = durum henüz bilinmiyor (fetch sürüyor) → butonu "AI kapalı" diye YANLIŞ etiketleme.
  const [aiEnabled, setAiEnabled] = React.useState<boolean | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [suggestion, setSuggestion] = React.useState<AiSuggestion | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<'draft' | 'id' | null>(null);

  React.useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/ai/status', { cache: 'no-store' });
        const data = (await res.json()) as { enabled?: boolean };
        if (alive) setAiEnabled(data?.enabled === true);
      } catch {
        // Durum okunamadıysa AI'ı KAPALI say: butonu etkin gösterip 503 yedirmek yanıltıcı olur.
        if (alive) setAiEnabled(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const run = () => {
    if (loading) return;
    setLoading(true);
    setError(null);
    setSuggestion(null);
    void (async () => {
      try {
        const res = await fetch(`/api/ai/support/${encodeURIComponent(requestId)}/suggest`, {
          method: 'POST',
        });
        const body = (await res.json().catch(() => null)) as
          | (AiSuggestion & { error?: string })
          | { error?: string; message?: string }
          | null;
        if (!res.ok || !body || !('draftReply' in body)) {
          const msg =
            (body && 'error' in body && typeof body.error === 'string' && body.error) ||
            (body && 'message' in body && typeof body.message === 'string' && body.message) ||
            `Öneri üretilemedi (${res.status}).`;
          setError(msg);
          return;
        }
        setSuggestion(body);
      } catch {
        setError('Ağ hatası — öneri üretilemedi.');
      } finally {
        setLoading(false);
      }
    })();
  };

  const copy = (what: 'draft' | 'id') => {
    const text = what === 'draft' ? suggestion?.draftReply : requestId;
    if (!text) return;
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(what);
        window.setTimeout(() => setCopied(null), 2000);
      })
      // Pano erişimi yoksa sessizce yut — metin zaten ekranda seçilebilir durumda.
      .catch(() => undefined);
  };

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Sparkles className="size-3.5" aria-hidden /> AI triyaj önerisi
        </h3>
        <Button
          variant="outline"
          size="sm"
          onClick={run}
          disabled={loading || aiEnabled !== true}
          title={
            aiEnabled === false
              ? 'AI kapalı — sunucuda AI_ENABLED + ANTHROPIC_API_KEY gerekir'
              : 'Kategori + öncelik belirler ve TASLAK cevap yazar; gönderim yapmaz'
          }
        >
          {loading ? <Loader2 className="animate-spin" /> : <Sparkles />}
          {loading ? 'Öneriliyor…' : 'AI önerisi al'}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {aiEnabled === false
          ? 'AI kapalı — öneri üretilemez. Talebi elle yanıtlayabilirsiniz.'
          : 'Yalnız TASLAK üretir; hiçbir şey gönderilmez ve talebin durumu değişmez.'}
      </p>

      {error && (
        <Alert variant="destructive" className="mt-2">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertDescription>{error}</AlertDescription>
          </div>
        </Alert>
      )}

      {suggestion && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{aiCategoryLabel(suggestion.category)}</Badge>
            <Badge variant={PRIORITY_VARIANT[suggestion.priority] ?? 'neutral'}>
              Öncelik: {aiPriorityLabel(suggestion.priority)}
            </Badge>
          </div>
          <Textarea rows={5} readOnly value={suggestion.draftReply} aria-label="AI taslak cevabı" />
          <Button variant="ghost" size="sm" onClick={() => copy('draft')}>
            {copied === 'draft' ? <CheckCircle2 /> : <Copy />}
            {copied === 'draft' ? 'Kopyalandı' : 'Taslağı kopyala'}
          </Button>
        </div>
      )}

      {/* Talep numarası: /ai ekranındaki "gelişmiş" serbest alan için kopyalanabilir olsun
          (numara başka hiçbir ekranda görünmüyordu — özellik erişilemezdi). */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>Talep numarası:</span>
        <code className="max-w-full truncate font-mono">{requestId}</code>
        <Button variant="ghost" size="sm" onClick={() => copy('id')} aria-label="Talep numarasını kopyala">
          {copied === 'id' ? <CheckCircle2 /> : <Copy />}
          {copied === 'id' ? 'Kopyalandı' : 'Kopyala'}
        </Button>
      </div>
    </div>
  );
}

/** Özet satırı: ikon + etiket + değer (dar panelde iki kolona sığar). */
function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Clock;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {label}
      </dt>
      <dd className="mt-0.5 min-w-0 text-sm text-foreground">{children}</dd>
    </div>
  );
}
