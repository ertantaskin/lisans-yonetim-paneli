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
          <span className="text-ink/60">Domain</span>
          <input
            name="domain"
            placeholder="magazam.com"
            required
            className="rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink/60">Gönderen e-posta (ops.)</span>
          <input
            name="senderEmail"
            type="email"
            placeholder="satis@magazam.com"
            className="rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
          />
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {pending ? 'Oluşturuluyor…' : 'Site Oluştur'}
        </button>
      </form>

      {state.error && <p className="mt-3 text-sm text-danger">{state.error}</p>}

      {state.ok && state.site && (
        <div className="mt-4 rounded-lg border border-warning/40 bg-[color-mix(in_srgb,var(--color-warning)_8%,transparent)] p-4 text-sm">
          <p className="mb-2 font-medium text-warning">
            ⚠ Bu bilgiler yalnız bir kez gösterilir — güvenli saklayın:
          </p>
          <div className="space-y-1 font-mono text-xs text-ink/80">
            <div>
              <span className="text-ink/50">API Key:</span> {state.site.apiKey}
            </div>
            <div>
              <span className="text-ink/50">HMAC Secret:</span> {state.site.hmacSecret}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
