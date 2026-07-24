'use client';
import { useActionState, useMemo, useState } from 'react';
import { CheckCircle2, Eye, TriangleAlert, Upload } from 'lucide-react';
import {
  importStockAction,
  previewStockAction,
  type ImportState,
  type PreviewState,
} from '../app/stock/actions';
import type { ProductRow } from '../lib/api';
import { Input, Textarea, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Field } from './ui/field';

const initial: ImportState = { ok: false };
const previewInitial: PreviewState = { ok: false };

export function ImportStockForm({
  products,
  defaultBatchId,
  fixedProductId,
}: {
  products: ProductRow[];
  /** URL ?batchId= ile gelen parti (recall/toplu-değiştir akışı ön-doldurur). */
  defaultBatchId?: string;
  /** Ürün-merkezli kullanım (ürün detayı): ürün SABİT → dropdown gizlenir, hidden input gönderilir. */
  fixedProductId?: string;
}) {
  const [state, action, pending] = useActionState(importStockAction, initial);
  const [previewState, previewAction, previewPending] = useActionState(
    previewStockAction,
    previewInitial,
  );
  const [productId, setProductId] = useState(fixedProductId ?? '');
  // keys textarea'yı kontrol altına al ki satır sayısını önizlemeye taşıyabilelim.
  const [keys, setKeys] = useState('');
  // Önizleme adedi (tahmini giriş) — kullanıcı elle değişmediyse satır sayısını izler.
  const [count, setCount] = useState('');
  const [countTouched, setCountTouched] = useState(false);

  const selected = products.find((p) => p.id === productId);
  const isAccount = selected?.kind === 'account';
  const schemaKeys = (selected?.payloadSchema ?? []).map((f) => f.key);

  // Boş olmayan satır sayısı = import edilecek yaklaşık kalem sayısı.
  const lineCount = useMemo(
    () => keys.split('\n').map((l) => l.trim()).filter(Boolean).length,
    [keys],
  );
  // Kullanıcı count alanına dokunmadıysa satır sayısını göster; dokunduysa girdisini koru.
  const effectiveCount = countTouched ? count : String(lineCount);

  // Hesap ürününde her satır bir JSON nesne (backend JSON string'i şemaya göre çözer).
  const accountExample =
    schemaKeys.length > 0
      ? JSON.stringify(Object.fromEntries(schemaKeys.map((k) => [k, '…'])))
      : '{"username":"…","password":"…"}';

  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        {fixedProductId ? (
          // Ürün-merkezli: ürün zaten belli → dropdown yok, yalnız gizli alan.
          <input type="hidden" name="productId" value={fixedProductId} />
        ) : (
          <Field label="Ürün" htmlFor="is-product">
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
          </Field>
        )}

        <Field
          label={isAccount ? 'Hesaplar (her satır bir JSON nesne)' : "Key'ler (her satır bir key)"}
          htmlFor="is-keys"
          hint={
            isAccount ? (
              <>
                Alanlar: {schemaKeys.join(', ') || '(şema tanımsız)'} — örn:{' '}
                <code className="text-foreground">{accountExample}</code>
              </>
            ) : undefined
          }
        >
          <Textarea
            id="is-keys"
            name="keys"
            rows={5}
            value={keys}
            onChange={(e) => setKeys(e.target.value)}
            className="font-mono text-xs"
            placeholder={
              isAccount
                ? `${accountExample}\n${accountExample}`
                : 'XXXXX-XXXXX-XXXXX-XXXXX-11111\nXXXXX-XXXXX-XXXXX-XXXXX-22222'
            }
          />
        </Field>

        <Field
          label="Parti (batch)"
          htmlFor="is-batch"
          hint="Opsiyonel — geri çekme / toplu değişim için. Normalde boş bırakın."
        >
          <Input
            id="is-batch"
            name="batchId"
            defaultValue={defaultBatchId}
            className="max-w-md font-mono text-xs"
            placeholder="ör. parti kimliği (boş bırakılabilir)"
          />
        </Field>
        {defaultBatchId && (
          <p className="text-xs text-muted-foreground">
            Bu giriş <code className="text-foreground">{defaultBatchId}</code> partisine bağlanacak.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {/* Gerçek import: name=dryRun value=false → server action commit eder. */}
          <Button type="submit" name="dryRun" value="false" disabled={pending}>
            <Upload className="size-4" />
            {pending ? 'İşleniyor…' : 'Onayla ve Dağıt'}
          </Button>
          {/* Kuru çalıştırma (§7): name=dryRun value=true → yalnız doğrula, hiçbir şey kaydetme. */}
          <Button type="submit" name="dryRun" value="true" variant="outline" disabled={pending}>
            <Eye className="size-4" />
            Kuru Çalıştır (Önizleme)
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          <strong className="font-medium text-foreground">Kuru Çalıştır (Önizleme):</strong>{' '}
          Hiçbir şey kaydetmeden doğrular.
        </p>

        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state.ok && state.result && state.result.dryRun && (
          <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
            {/* Kuru çalıştırma: hiçbir şey commit edilmedi; yalnız kabul/ret önizlemesi. */}
            <p className="flex items-center gap-1.5 text-foreground">
              <Eye className="size-4" />
              Kuru çalıştırma — <strong>hiçbir şey kaydedilmedi</strong>.{' '}
              {state.result.wouldImport ?? 0} kabul edilecek, {state.result.duplicates} mükerrer
              atlanacak, {state.result.rejected} reddedilecek ({state.result.requested} istendi).
            </p>
            {state.result.rejected > 0 && state.result.rejections
              && state.result.rejections.length > 0 && (
              <p className="text-warning">
                İlk hata: satır {state.result.rejections[0].index + 1} —{' '}
                {state.result.rejections[0].reason}
              </p>
            )}
          </div>
        )}
        {state.ok && state.result && !state.result.dryRun && (
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
                {state.result.rejected} girdi doğrulamadan geçemedi ({state.result.requested}{' '}
                istendi).
                {state.result.rejections && state.result.rejections.length > 0
                  ? ` İlk hata: satır ${state.result.rejections[0].index + 1} — ${state.result.rejections[0].reason}`
                  : ''}
              </p>
            )}
          </div>
        )}
      </form>

      {/* Akıllı önizleme (§13) — salt-okunur; import mantığını tetiklemez. */}
      <form
        action={previewAction}
        className="space-y-2 rounded-md border border-border bg-muted/30 p-3"
      >
        <input type="hidden" name="productId" value={productId} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Tahmini giriş adedi" htmlFor="is-count">
            <Input
              id="is-count"
              name="count"
              type="number"
              min={0}
              value={effectiveCount}
              onChange={(e) => {
                setCountTouched(true);
                setCount(e.target.value);
              }}
              className="w-32"
              placeholder="0"
            />
          </Field>
          <Button type="submit" variant="outline" disabled={previewPending || !productId}>
            <Eye className="size-4" />
            {previewPending ? 'Hesaplanıyor…' : 'Bekleyen talebi önizle'}
          </Button>
          {!countTouched && lineCount > 0 && (
            <span className="pb-2 text-xs text-muted-foreground">
              (yukarıdaki {lineCount} satırdan)
            </span>
          )}
        </div>

        {previewState.error && (
          <p className="text-sm text-destructive">{previewState.error}</p>
        )}
        {previewState.ok && previewState.result && (
          <p className="text-sm text-foreground">
            Bu giriş{' '}
            <strong>{previewState.result.wouldFill}</strong> bekleyen birimi tamamlar (
            {previewState.result.pendingLines} bekleyen satır,{' '}
            {previewState.result.pendingUnits} birim).
            {previewState.result.remainingAfter > 0
              ? ` Ardından ${previewState.result.remainingAfter} birim stok artar.`
              : previewState.result.pendingUnits > previewState.result.count
                ? ` ${previewState.result.pendingUnits - previewState.result.count} birim talep açık kalır.`
                : ''}
          </p>
        )}
      </form>
    </div>
  );
}
