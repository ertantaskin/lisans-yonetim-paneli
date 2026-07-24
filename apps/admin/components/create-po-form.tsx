'use client';
import { useActionState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createPurchaseOrderAction, initialPOFormState } from '@/app/purchase-orders/actions';
import type { SupplierOption } from '@/app/purchase-orders/queries';
import type { ProductRow } from '@/lib/api';
import { Input, Textarea, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Field, FormSection, FieldRow } from './ui/field';

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
    <form action={action} className="space-y-6 text-sm">
      <FormSection title="Tedarik" description="Emrin verileceği tedarikçi ve stoklanacak ürün.">
        <FieldRow>
          <Field label="Tedarikçi" htmlFor="po-supplier" required>
            <select id="po-supplier" name="supplierId" required className={`${selectClass} w-full`}>
              <option value="">— tedarikçi —</option>
              {activeSuppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Ürün" htmlFor="po-product" required>
            <select id="po-product" name="productId" required className={`${selectClass} w-full`}>
              <option value="">— ürün —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} · {p.name}
                </option>
              ))}
            </select>
          </Field>
        </FieldRow>
      </FormSection>

      <FormSection title="Miktar & maliyet">
        <FieldRow cols={3}>
          <Field label="Sipariş adedi" htmlFor="po-qty" required>
            <Input
              id="po-qty"
              name="qtyOrdered"
              type="number"
              min={1}
              step={1}
              placeholder="ör. 100"
              required
              className="w-full"
            />
          </Field>
          <Field
            label="Birim maliyet"
            htmlFor="po-cost"
            hint="Kuruş cinsinden (ör. 1000 = 10,00 ₺). Opsiyonel."
          >
            <Input
              id="po-cost"
              name="unitCostCents"
              type="number"
              min={0}
              step={1}
              placeholder="ör. 12000"
              className="w-full"
            />
          </Field>
          <Field label="Para birimi" htmlFor="po-currency">
            <Input id="po-currency" name="currency" defaultValue="TRY" className="w-full" />
          </Field>
        </FieldRow>
      </FormSection>

      <FormSection title="Teslim & durum">
        <FieldRow>
          <Field label="Tahmini teslim (ETA)" htmlFor="po-eta" hint="Opsiyonel.">
            <Input id="po-eta" name="eta" type="date" className="w-full" />
          </Field>
          <Field label="Durum" htmlFor="po-status">
            <select id="po-status" name="status" defaultValue="draft" className={`${selectClass} w-full`}>
              <option value="draft">taslak</option>
              <option value="ordered">sipariş verildi</option>
            </select>
          </Field>
        </FieldRow>
        <Field label="Not" htmlFor="po-notes" hint="Serbest not. Opsiyonel.">
          <Textarea id="po-notes" name="notes" placeholder="Serbest not" rows={2} className="max-w-lg" />
        </Field>
      </FormSection>

      <Button type="submit" disabled={pending}>
        {pending ? 'Oluşturuluyor…' : 'Emir Oluştur'}
      </Button>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
