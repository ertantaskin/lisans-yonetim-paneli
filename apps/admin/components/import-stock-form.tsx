'use client';
import { useActionState, useState } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { importStockAction, type ImportState } from '../app/stock/actions';
import type { ProductRow } from '../lib/api';
import { Label, Textarea, selectClass } from './ui/input';
import { Button } from './ui/button';

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
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="is-product">Ürün</Label>
        <select
          id="is-product"
          name="productId"
          required
          value={productId}
          onChange={(e) => setProductId(e.target.value)}
          className={`w-full max-w-md ${selectClass}`}
        >
          <option value="">— seçin —</option>
          {products.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.sku}) · {p.kind}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="is-keys">
          {isAccount ? 'Hesaplar (her satır bir JSON nesne)' : "Key'ler (her satır bir key)"}
        </Label>
        {isAccount && (
          <span className="text-xs text-muted-foreground">
            Alanlar: {schemaKeys.join(', ') || '(şema tanımsız)'} — örn:{' '}
            <code className="text-foreground">{accountExample}</code>
          </span>
        )}
        <Textarea
          id="is-keys"
          name="keys"
          rows={5}
          className="font-mono text-xs"
          placeholder={
            isAccount
              ? `${accountExample}\n${accountExample}`
              : 'XXXXX-XXXXX-XXXXX-XXXXX-11111\nXXXXX-XXXXX-XXXXX-XXXXX-22222'
          }
        />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'İçe aktarılıyor…' : 'Onayla ve Dağıt'}
      </Button>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
      {state.ok && state.result && (
        <div className="space-y-1 text-sm">
          {/* imported=0 ise başarı DEĞİL — hiçbir şey girmedi (ör. hepsi reddedildi). */}
          <p
            className={`flex items-center gap-1.5 ${
              state.result.imported > 0 ? 'text-success' : 'text-warning'
            }`}
          >
            {state.result.imported > 0 ? (
              <CheckCircle2 className="size-4" />
            ) : (
              <TriangleAlert className="size-4" />
            )}
            {state.result.imported} girdi, {state.result.duplicates} mükerrer atlandı
            {state.result.autoCompleted > 0
              ? `, ${state.result.autoCompleted} bekleyen sipariş tamamlandı`
              : ''}
            .
          </p>
          {state.result.rejected > 0 && (
            <p className="flex items-center gap-1.5 text-warning">
              <TriangleAlert className="size-4" />
              {state.result.rejected} girdi doğrulamadan geçemedi ({state.result.requested} istendi).
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
