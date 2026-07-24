'use client';
import { useActionState } from 'react';
import { CheckCircle2, Plus, TriangleAlert } from 'lucide-react';
import {
  createStockAdjustmentAction,
  initialStockAdjustState,
} from './actions';
import { Input, Textarea, selectClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { adjustmentActionLabel } from '../../../lib/labels';

/**
 * Manuel stok düzeltme formu (§12). Aksiyon + adet + (ops.) lisans satırı id + ZORUNLU sebep.
 * Server action POST /v1/admin/stock-adjustments çağırır; başarıda liste revalidate edilir.
 */
export function StockAdjustForm({ productId }: { productId: string }) {
  const [state, action, pending] = useActionState(
    createStockAdjustmentAction,
    initialStockAdjustState,
  );

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="productId" value={productId} />

      <div className="flex flex-wrap gap-3">
        <Field label="İşlem türü" htmlFor="adj-action">
          <select id="adj-action" name="action" defaultValue="correct" className={`${selectClass} w-44`}>
            <option value="correct">{adjustmentActionLabel('correct')}</option>
            <option value="void">{adjustmentActionLabel('void')} (void)</option>
            <option value="damage">{adjustmentActionLabel('damage')}</option>
            <option value="recall">{adjustmentActionLabel('recall')}</option>
          </select>
        </Field>
        <Field label="Adet" htmlFor="adj-qty">
          <Input
            id="adj-qty"
            name="qty"
            type="number"
            min={0}
            step={1}
            defaultValue={0}
            className="w-32"
          />
        </Field>
      </div>

      <Field
        label="Lisans satırı (opsiyonel)"
        htmlFor="adj-item"
        hint="Void/hasar için ilgili key satırının kimliği. Genel düzeltmede boş bırakın."
      >
        <Input
          id="adj-item"
          name="licenseItemId"
          placeholder="ör. lisans satırı kimliği"
          className="max-w-md font-mono text-xs"
        />
      </Field>

      <Field
        label="Sebep"
        htmlFor="adj-reason"
        required
        hint="Denetim (audit) kaydına yazılır."
      >
        <Textarea
          id="adj-reason"
          name="reason"
          required
          rows={2}
          placeholder="ör. tedarikçi partisi bozuk — 3 key kullanılamaz"
          className="max-w-md"
        />
      </Field>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Plus /> {pending ? 'Kaydediliyor…' : 'Düzeltme Ekle'}
        </Button>
        {state.saved && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" /> Eklendi
          </span>
        )}
        {state.error && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
            <TriangleAlert className="size-3.5" /> {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
