'use client';
import * as React from 'react';
import { Pencil, Save } from 'lucide-react';
import type { ProductRow } from '../lib/api';
import { updateProductAction, type FormState } from '../app/stock/actions';
import { Button } from './ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import { ProductFormFields } from './product-create-form';

const editInitial: FormState = { ok: false };

/**
 * Ürün düzenleme paneli (§11) — Sheet + ön-dolu form; başarıda kapanır. PAYLAŞIMLI: hem /stock
 * ürün tablosu satır aksiyonu hem ürün detay sayfası başlığı kullanır. `product` tipi gevşek:
 * yalnız id/name/sku okunur, gerisi ProductFormFields defaults'a yayılır → ürün detayının
 * ProductRecord'u (availableStock içermez) da kabul edilir. `trigger` verilirse varsayılan
 * ghost "Düzenle" butonu yerine özel tetikleyici kullanılır (ör. detay başlığında outline).
 */
export function ProductEditSheet({
  product,
  trigger,
}: {
  product: Partial<ProductRow> & { id: string; name: string; sku: string };
  trigger?: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const [state, action, pending] = React.useActionState(updateProductAction, editInitial);

  // Başarılı güncellemede paneli kapat (revalidatePath ilgili sayfayı tazeler).
  React.useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        {trigger ?? (
          <Button variant="ghost" size="sm" aria-label={`${product.name} düzenle`}>
            <Pencil /> Düzenle
          </Button>
        )}
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Ürün düzenle</SheetTitle>
          <SheetDescription>
            {product.name} · {product.sku}
          </SheetDescription>
        </SheetHeader>
        {/* key={open}: her açılışta formu ürün varsayılanlarıyla sıfırla. */}
        <form key={String(open)} action={action} className="space-y-3 p-4 pt-0">
          <input type="hidden" name="id" value={product.id} />
          <ProductFormFields defaults={product} />
          {state.error && <p className="text-sm text-destructive">{state.error}</p>}
          <Button type="submit" disabled={pending}>
            <Save /> {pending ? 'Kaydediliyor…' : 'Kaydet'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
