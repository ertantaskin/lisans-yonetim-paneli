'use client';
import { useActionState } from 'react';
import { revealAction, type RevealState } from '../app/orders/[id]/actions';

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
 */
export function AssignmentLicenseCell({ assignmentId, kind, maskedPayload, maskedFields }: Props) {
  const [state, action, pending] = useActionState(revealAction, initial);
  const revealed = state.result && state.assignmentId === assignmentId ? state.result : null;

  return (
    <div className="space-y-1">
      {kind === 'account' ? (
        <div className="space-y-0.5">
          {(revealed?.fields ?? maskedFields ?? []).map((f) => (
            <div key={f.key} className="flex gap-1.5 font-mono text-xs">
              <span className="text-muted-foreground">{f.label}:</span>
              <span className={f.secret && !revealed ? 'text-muted-foreground' : 'text-foreground/80'}>{f.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="font-mono text-foreground/80">{revealed ? revealed.payload : maskedPayload}</div>
      )}

      {!revealed && (
        <form action={action}>
          <input type="hidden" name="assignmentId" value={assignmentId} />
          <button
            type="submit"
            disabled={pending}
            className="text-xs text-primary hover:underline disabled:opacity-50"
          >
            {pending ? 'Gösteriliyor…' : 'Göster'}
          </button>
        </form>
      )}
      {revealed && <span className="text-[11px] text-warning">Gösterildi (audit'e düştü)</span>}
      {state.error && state.assignmentId === assignmentId && (
        <span className="text-[11px] text-destructive">{state.error}</span>
      )}
    </div>
  );
}
