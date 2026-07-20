'use client';
import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createPurchaseOrderAction, initialPOFormState } from '@/app/purchase-orders/actions';
import type { SupplierOption } from '@/app/purchase-orders/queries';
import type { ProductRow } from '@/lib/api';
import { Input, Textarea, Label, selectClass } from './ui/input';
import { Button } from './ui/button';

/**
 * Satın alma emri oluşturma formu (§12). Tedarikçi + ürün seçimi, adet, birim maliyet,
 * ETA, durum (draft/ordered). Başarıda yeni emrin detayına yönlendirir.
 */
export function CreatePOForm({
  suppliers,
  products,
}: {
  suppliers: SupplierOption[];
  products: ProductRow[];
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState(createPurchaseOrderAction, initialPOFormState);

  useEffect(() => {
    if (state.ok && state.id) router.push(`/purchase-orders/${state.id}`);
  }, [state.ok, state.id, router]);

  const activeSuppliers = suppliers.filter((s) => s.active);

  return (
    <form action={action} className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-supplier">Tedarikçi</Label>
          <select id="po-supplier" name="supplierId" required className={`${selectClass} w-56`}>
            <option value="">— tedarikçi —</option>
            {activeSuppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-product">Ürün</Label>
          <select id="po-product" name="productId" required className={`${selectClass} w-64`}>
            <option value="">— ürün —</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.sku} · {p.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-qty">Sipariş adedi</Label>
          <Input
            id="po-qty"
            name="qtyOrdered"
            type="number"
            min={1}
            step={1}
            placeholder="ör. 100"
            required
            className="w-40"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-cost">Birim maliyet (kuruş, ops.)</Label>
          <Input
            id="po-cost"
            name="unitCostCents"
            type="number"
            min={0}
            step={1}
            placeholder="ör. 12000"
            className="w-48"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-currency">Para birimi</Label>
          <Input id="po-currency" name="currency" defaultValue="TRY" className="w-28" />
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-eta">ETA (ops.)</Label>
          <Input id="po-eta" name="eta" type="date" className="w-44" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="po-status">Durum</Label>
          <select id="po-status" name="status" defaultValue="draft" className={`${selectClass} w-44`}>
            <option value="draft">taslak</option>
            <option value="ordered">sipariş verildi</option>
          </select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="po-notes">Not (ops.)</Label>
        <Textarea id="po-notes" name="notes" placeholder="Serbest not" rows={2} className="max-w-lg" />
      </div>

      <Button type="submit" disabled={pending}>
        {pending ? 'Oluşturuluyor…' : 'Emir Oluştur'}
      </Button>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
