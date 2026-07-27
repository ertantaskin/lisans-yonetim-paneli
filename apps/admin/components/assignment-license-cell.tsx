'use client';
import { useActionState } from 'react';
import { Eye } from 'lucide-react';
import { revealAction, type RevealState } from '../app/orders/[id]/actions';
import { Button } from './ui/button';

type MaskedField = { key: string; label: string; value: string; secret: boolean };

interface Props {
  assignmentId: string;
  kind: string;
  maskedPayload: string;
  maskedFields: MaskedField[] | null;
}

const initial: RevealState = {};

/**
 * Atama lisans hücresi: varsayılan MASKELİ; "Göster" ile loglu reveal (audit'e düşer).
 * Hesap ürününde alan-alan (Kullanıcı adı açık / Parola maskeli→reveal'de tam).
 * "Göster" butonu anahtarın YANINDA (yer tasarrufu) ve kompakt.
 */
export function AssignmentLicenseCell({ assignmentId, kind, maskedPayload, maskedFields }: Props) {
  const [state, action, pending] = useActionState(revealAction, initial);
  const revealed = state.result && state.assignmentId === assignmentId ? state.result : null;

  const revealBtn = !revealed && (
    <form action={action} className="shrink-0">
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        title="Lisansı göster (audit kaydına düşer)"
        className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
      >
        <Eye className="size-3.5" />
        {pending ? '…' : 'Göster'}
      </Button>
    </form>
  );

  return (
    <div className="min-w-0 space-y-0.5">
      {kind === 'account' ? (
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 space-y-0.5">
            {(revealed?.fields ?? maskedFields ?? []).map((f) => (
              <div key={f.key} className="flex gap-1.5 font-mono text-xs">
                <span className="text-muted-foreground">{f.label}:</span>
                <span className={f.secret && !revealed ? 'text-muted-foreground' : 'text-foreground/80'}>
                  {f.value}
                </span>
              </div>
            ))}
          </div>
          {revealBtn}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 break-all font-mono text-sm text-foreground/80">
            {revealed ? revealed.payload : maskedPayload}
          </code>
          {revealBtn}
        </div>
      )}
      {revealed && <span className="text-[11px] text-warning">Gösterildi (audit'e düştü)</span>}
      {state.error && state.assignmentId === assignmentId && (
        <span className="text-[11px] text-destructive">{state.error}</span>
      )}
    </div>
  );
}
