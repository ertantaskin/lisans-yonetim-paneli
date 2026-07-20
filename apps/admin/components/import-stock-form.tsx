'use client';
import { useActionState, useState } from 'react';
import { importStockAction, type ImportState } from '../app/stock/actions';
import type { ProductRow } from '../lib/api';

const initial: ImportState = { ok: false };

export function ImportStockForm({ products }: { products: ProductRow[] }) {
  const [state, action, pending] = useActionState(importStockAction, initial);
  const [productId, setProductId] = useState('');
  const selected = products.find((p) => p.id === productId);
  const isAccount = selected?.kind === 'account';
  const schemaKeys = (selected?.payloadSchema ?? []).map((f) => f.key);

  // Hesap ürününde her satır bir JSON nesne (backend JSON string'i şemaya göre çözer).
  const accountExample =
    schemaKeys.length > 0
      ? JSON.stringify(Object.fromEntries(schemaKeys.map((k) => [k, '…'])))
      : '{"username":"…","password":"…"}';

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink/60">Ürün</span>
          <select
            name="productId"
            required
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            className="rounded-md border border-ink/15 bg-surface px-3 py-1.5 text-sm outline-none focus:border-accent"
          >
            <option value="">— seçin —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.sku}) · {p.kind}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-ink/60">
          {isAccount ? 'Hesaplar (her satır bir JSON nesne)' : "Key'ler (her satır bir key)"}
        </span>
        {isAccount && (
          <span className="text-xs text-ink/50">
            Alanlar: {schemaKeys.join(', ') || '(şema tanımsız)'} — örn:{' '}
            <code className="text-ink/70">{accountExample}</code>
          </span>
        )}
        <textarea
          name="keys"
          rows={5}
          placeholder={
            isAccount
              ? `${accountExample}\n${accountExample}`
              : 'XXXXX-XXXXX-XXXXX-XXXXX-11111\nXXXXX-XXXXX-XXXXX-XXXXX-22222'
          }
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
        <div className="space-y-1 text-sm">
          {/* imported=0 ise başarı DEĞİL — hiçbir şey girmedi (ör. hepsi reddedildi). */}
          <p className={state.result.imported > 0 ? 'text-success' : 'text-warning'}>
            {state.result.imported > 0 ? '✓ ' : '⚠ '}
            {state.result.imported} girdi, {state.result.duplicates} mükerrer atlandı
            {state.result.autoCompleted > 0
              ? `, ${state.result.autoCompleted} bekleyen sipariş tamamlandı`
              : ''}
            .
          </p>
          {state.result.rejected > 0 && (
            <p className="text-warning">
              ⚠ {state.result.rejected} girdi doğrulamadan geçemedi (
              {state.result.requested} istendi).
              {state.result.rejections && state.result.rejections.length > 0
                ? ` İlk hata: satır ${state.result.rejections[0].index + 1} — ${state.result.rejections[0].reason}`
                : ''}
            </p>
          )}
        </div>
      )}
    </form>
  );
}
