'use client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import { createProductAction, type FormState } from '../app/stock/actions';
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

const createInitial: FormState = { ok: false };

/**
 * "Yeni Ürün" paneli — /stock başlığında birincil aksiyon. Düzenleme sheet'iyle AYNI desen
 * (Sheet + ProductFormFields + useActionState); başarıda kapanır (revalidatePath tabloyu tazeler).
 * Büyük formu (SKU/tip/politika/payloadSchema editörü/…) sayfadan ayrılmadan açar → /stock sade kalır.
 */
export function ProductCreateSheet() {
  const [open, setOpen] = React.useState(false);
  const [state, action, pending] = React.useActionState(createProductAction, createInitial);

  React.useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus /> Yeni Ürün
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Yeni ürün oluştur</SheetTitle>
          <SheetDescription>
            Ürün tipi, teslimat politikası ve (hesap ürünü ise) alan şeması.
          </SheetDescription>
        </SheetHeader>
        {/* key={open}: her açılışta formu temiz başlat. */}
        <form key={String(open)} action={action} className="space-y-3 p-4 pt-0">
          <ProductFormFields />
          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Oluşturuluyor…' : 'Oluştur'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
