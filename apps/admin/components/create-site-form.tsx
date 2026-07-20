'use client';
import { useActionState } from 'react';
import { createSiteAction, type CreateSiteState } from '../app/sites/actions';

const initial: CreateSiteState = { ok: false };

export function CreateSiteForm() {
  const [state, action, pending] = useActionState(createSiteAction, initial);

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-foreground/60">Domain</span>
          <input
            name="domain"
            placeholder="magazam.com"
            required
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-foreground/60">Gönderen e-posta (ops.)</span>
          <input
            name="senderEmail"
            type="email"
            placeholder="satis@magazam.com"
            className="rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Oluşturuluyor…' : 'Site Oluştur'}
        </button>
      </form>

      {state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}

      {state.ok && state.site && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] p-4 text-sm">
          <p className="mb-2 font-medium text-warning">
            ⚠ Bu bilgiler yalnız bir kez gösterilir — güvenli saklayın:
          </p>
          <div className="space-y-1 font-mono text-xs text-foreground/80">
            <div>
              <span className="text-muted-foreground">API Key:</span> {state.site.apiKey}
            </div>
            <div>
              <span className="text-muted-foreground">HMAC Secret:</span> {state.site.hmacSecret}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
