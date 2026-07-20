'use client';
import { useActionState } from 'react';
import { importStockAction, type ImportState } from '../app/stock/actions';
import type { ProductRow } from '../lib/api';

const initial: ImportState = { ok: false };

export function ImportStockForm({ products }: { products: ProductRow[] }) {
  const [state, action, pending] = useActionState(importStockAction, initial);

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink/60">Ürün</span>
          <select
            name="productId"
            required
            className="rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
          >
            <option value="">— seçin —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku})
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink/60">Key'ler (her satır bir key)</span>
        <textarea
          name="keys"
          rows={5}
          placeholder={'XXXXX-XXXXX-XXXXX-XXXXX-11111\nXXXXX-XXXXX-XXXXX-XXXXX-22222'}
          className="w-full rounded-md border border-ink/15 bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-accent"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {pending ? 'İçe aktarılıyor…' : 'Onayla ve Dağıt'}
      </button>

      {state.error && <p className="text-sm text-danger">{state.error}</p>}
      {state.ok && state.result && (
        <p className="text-sm text-success">
          ✓ {state.result.imported} girdi, {state.result.duplicates} mükerrer atlandı
          {state.result.autoCompleted > 0
            ? `, ${state.result.autoCompleted} bekleyen sipariş tamamlandı`
            : ''}
          .
        </p>
      )}
    </form>
  );
}
