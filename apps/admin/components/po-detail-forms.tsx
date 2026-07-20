'use client';
import { useActionState } from 'react';
import { PackageCheck, Save, TriangleAlert, CheckCircle2 } from 'lucide-react';
import {
  receivePurchaseOrderAction,
  updatePurchaseOrderAction,
  initialPOFormState,
} from '@/app/purchase-orders/actions';
import type { PurchaseOrderRow } from '@/app/purchase-orders/queries';
import { Input, Textarea, Label, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';

/** yyyy-mm-dd (input[type=date]) için ISO tarihi kırpar. */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Teslim al — kısmi teslim destekli; parti etiketi zorunlu. */
export function POReceiveForm({ po }: { po: PurchaseOrderRow }) {
  const [state, action, pending] = useActionState(receivePurchaseOrderAction, initialPOFormState);
  const remaining = Math.max(0, po.qtyOrdered - po.qtyReceived);
  const done = remaining === 0;

  if (done) {
    return (
      <Alert variant="success">
        <CheckCircle2 />
        <div className="min-w-0 flex-1">
          <AlertTitle>Tamamı teslim alındı</AlertTitle>
          <AlertDescription>
            {po.qtyReceived}/{po.qtyOrdered} adet teslim alındı.
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="id" value={po.id} />
      <p className="text-xs text-muted-foreground">
        Kalan: <span className="font-medium tabular-nums text-foreground">{remaining}</span> adet.
        Teslim alınca yeni parti oluşur (gerçek key girişi ayrıdır: Stok Import).
      </p>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rc-qty">Teslim adedi</Label>
          <Input
            id="rc-qty"
            name="qty"
            type="number"
            min={1}
            max={remaining}
            step={1}
            defaultValue={remaining}
            required
            className="w-36"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="rc-label">Parti etiketi</Label>
          <Input id="rc-label" name="batchLabel" placeholder="ör. 2026-07-A" required className="w-48" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="rc-notes">Not (ops.)</Label>
        <Textarea id="rc-notes" name="notes" rows={2} className="max-w-lg" />
      </div>
      <Button type="submit" disabled={pending}>
        <PackageCheck /> {pending ? 'İşleniyor…' : 'Teslim Al'}
      </Button>
      {state.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Teslim alınamadı</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </div>
        </Alert>
      )}
    </form>
  );
}

/** Emir güncelle — durum/ETA/not. */
export function POUpdateForm({ po }: { po: PurchaseOrderRow }) {
  const [state, action, pending] = useActionState(updatePurchaseOrderAction, initialPOFormState);

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="id" value={po.id} />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="up-status">Durum</Label>
          <select id="up-status" name="status" defaultValue={po.status} className={`${selectClass} w-48`}>
            <option value="draft">taslak</option>
            <option value="ordered">sipariş verildi</option>
            <option value="partial">kısmi teslim</option>
            <option value="received">teslim alındı</option>
            <option value="cancelled">iptal</option>
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="up-eta">ETA</Label>
          <Input id="up-eta" name="eta" type="date" defaultValue={toDateInput(po.eta)} className="w-44" />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="up-notes">Not</Label>
        <Textarea id="up-notes" name="notes" defaultValue={po.notes ?? ''} rows={2} className="max-w-lg" />
      </div>
      <Button type="submit" variant="outline" disabled={pending}>
        <Save /> {pending ? 'Kaydediliyor…' : 'Güncelle'}
      </Button>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
