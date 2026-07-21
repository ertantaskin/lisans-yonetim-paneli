'use client';
import { useActionState } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import {
  createStockAdjustmentAction,
  initialStockAdjustState,
} from './actions';
import { Input, Label, Textarea, selectClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';

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
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adj-action">Aksiyon</Label>
          <select id="adj-action" name="action" defaultValue="correct" className={`${selectClass} w-44`}>
            <option value="correct">düzeltme</option>
            <option value="void">iptal (void)</option>
            <option value="damage">hasar</option>
            <option value="recall">geri çekme</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="adj-qty">Adet</Label>
          <Input
            id="adj-qty"
            name="qty"
            type="number"
            min={0}
            step={1}
            defaultValue={0}
            className="w-32"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="adj-item">Lisans satırı id (ops. — void/hasar için)</Label>
        <Input
          id="adj-item"
          name="licenseItemId"
          placeholder="satılabilir lisans satırının UUID'i"
          className="max-w-md font-mono text-xs"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="adj-reason">Sebep (zorunlu)</Label>
        <Textarea
          id="adj-reason"
          name="reason"
          required
          rows={2}
          placeholder="ör. tedarikçi partisi bozuk — 3 key kullanılamaz"
          className="max-w-md"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Düzeltme Ekle'}
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
