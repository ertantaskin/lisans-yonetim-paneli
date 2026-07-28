'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { Lock, MessageSquare, RefreshCw, Send, TriangleAlert } from 'lucide-react';
import {
  fetchThreadAction,
  sendThreadMessageAction,
  type ThreadMessage,
  type ThreadState,
} from '../../app/support/thread-actions';
import { Button } from '../ui/button';
import { Textarea, checkboxClass } from '../ui/input';
import { Badge } from '../ui/badge';
import { messageAuthorLabel } from '../../lib/labels';
import { cn } from '../../lib/utils';

const initialThreadState: ThreadState = { ok: false };

/**
 * SupportThread — destek/değişim talebinin YAZIŞMASI (§13).
 *
 * Kullanıcı geri bildirimi: "admin tarafında cevap verme gibi bir şansımız olmuyor; değişim
 * olayı çok alakasız yerde, siparişin içinde olsa daha iyi". Bu bileşen İKİ yerde kullanılır:
 *  - /support (destek kuyruğu satırı açılınca)
 *  - /orders/[id] (siparişin kendi destek kartı)
 * Böylece aynı yazışma, operatörün bulunduğu yerde görünür.
 *
 * İÇ NOT (internal): yalnız panelde görünür, müşteriye GİTMEZ, mail tetiklemez — kilit ikonuyla
 * ve ayrı arka planla işaretlenir (yanlışlıkla müşteriye yazma riskini görsel olarak kapatır).
 * Mesaj yazmak talebin DURUMUNU değiştirmez (Onayla/Reddet ayrı aksiyondur) — form altında yazar.
 */
export function SupportThread({
  requestId,
  orderId,
  /** Sunucudan ön-yüklenmiş mesajlar (varsa) — ilk render boş görünmesin. */
  initialMessages,
  /** Kompakt mod: sipariş detayı gibi dar sütunlarda daha az boşluk. */
  compact = false,
  className,
}: {
  requestId: string;
  orderId?: string;
  initialMessages?: ThreadMessage[];
  compact?: boolean;
  className?: string;
}) {
  const [messages, setMessages] = React.useState<ThreadMessage[]>(initialMessages ?? []);
  const [loading, setLoading] = React.useState(!initialMessages);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [internal, setInternal] = React.useState(false);
  const [state, action, pending] = useActionState(sendThreadMessageAction, initialThreadState);
  const formRef = React.useRef<HTMLFormElement>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setLoadError(null);
    fetchThreadAction(requestId)
      .then((r) => {
        if (r.ok && r.messages) setMessages(r.messages);
        else setLoadError(r.error ?? 'Yazışma alınamadı');
      })
      .catch(() => setLoadError('Yazışma alınamadı'))
      .finally(() => setLoading(false));
  }, [requestId]);

  React.useEffect(() => {
    if (!initialMessages) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  // Gönderim başarılıysa formu temizle + yazışmayı tazele (yeni mesaj hemen görünsün).
  React.useEffect(() => {
    if (state.sent) {
      formRef.current?.reset();
      setInternal(false);
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sent]);

  return (
    <div className={cn('space-y-3 text-sm', className)}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquare className="size-3.5" aria-hidden /> Yazışma ({messages.length})
        </h3>
        <Button type="button" variant="ghost" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />
          Yenile
        </Button>
      </div>

      {loadError && (
        <p className="flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5" aria-hidden /> {loadError}
        </p>
      )}

      <div
        className={cn(
          'space-y-2 overflow-y-auto rounded-md border border-border bg-muted/20 p-2',
          compact ? 'max-h-64' : 'max-h-96',
        )}
      >
        {loading && messages.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">Yükleniyor…</p>
        ) : messages.length === 0 ? (
          <p className="px-1 py-3 text-center text-xs text-muted-foreground">
            Henüz mesaj yok. Aşağıdan müşteriye yanıt yazabilir veya iç not bırakabilirsiniz.
          </p>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      <form ref={formRef} action={action} className="space-y-2">
        <input type="hidden" name="requestId" value={requestId} />
        {orderId && <input type="hidden" name="orderId" value={orderId} />}
        <input type="hidden" name="internal" value={String(internal)} />

        <Textarea
          name="body"
          rows={compact ? 2 : 3}
          required
          maxLength={4000}
          placeholder={
            internal
              ? 'İç not — yalnız panelde görünür, müşteriye gitmez…'
              : 'Müşteriye yanıt yazın…'
          }
          aria-label={internal ? 'İç not' : 'Müşteriye yanıt'}
          className={internal ? 'border-warning/60 bg-warning/5' : undefined}
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className={checkboxClass}
            />
            <Lock className="size-3" aria-hidden />
            İç not (müşteriye gönderilmez)
          </label>

          <Button type="submit" size="sm" disabled={pending}>
            <Send className="size-3.5" aria-hidden />
            {pending ? 'Gönderiliyor…' : internal ? 'Notu Kaydet' : 'Yanıtı Gönder'}
          </Button>
        </div>

        {state.error && <p className="text-xs text-destructive">{state.error}</p>}
        {state.sent && <p className="text-xs text-success">Mesaj kaydedildi.</p>}
        <p className="text-xs text-muted-foreground">
          Mesaj yazmak talebin durumunu değiştirmez — değişim için “Onayla”, kapatmak için
          “Reddet” işlemini kullanın.
        </p>
      </form>
    </div>
  );
}

function MessageBubble({ message: m }: { message: ThreadMessage }) {
  const mine = m.authorType === 'admin';
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-2',
        m.internal
          ? 'border-warning/40 bg-warning/10'
          : mine
            ? 'border-border bg-background'
            : 'border-border bg-accent/40',
      )}
    >
      <div className="mb-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{m.authorName || messageAuthorLabel(m.authorType)}</span>
        <Badge variant={mine ? 'neutral' : 'success'} className="px-1 py-0 text-[10px]">
          {messageAuthorLabel(m.authorType)}
        </Badge>
        {m.internal && (
          <Badge variant="warning" className="px-1 py-0 text-[10px]">
            <Lock className="size-2.5" aria-hidden /> İç not
          </Badge>
        )}
        <time dateTime={m.createdAt} className="ml-auto tabular-nums">
          {new Date(m.createdAt).toLocaleString('tr-TR')}
        </time>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-foreground">{m.body}</p>
    </div>
  );
}
