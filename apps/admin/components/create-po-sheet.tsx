'use client';
import * as React from 'react';
import { Plus } from 'lucide-react';
import type { SupplierOption } from '@/app/purchase-orders/queries';
import type { ProductRow } from '@/lib/api';
import { Button } from './ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';
import { CreatePOForm } from './create-po-form';

/**
 * "Yeni Emir" paneli — /purchase-orders başlığında birincil aksiyon. ProductCreateSheet
 * deseniyle aynı: büyük formu (tedarikçi/ürün/miktar/maliyet/teslim) sayfadan ayrılmadan
 * açar → liste ekranı sade ve taranabilir kalır. Form başarıda emrin detayına yönlendirir.
 */
export function CreatePOSheet({
  suppliers,
  products,
}: {
  suppliers: SupplierOption[];
  products: ProductRow[];
}) {
  const [open, setOpen] = React.useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button>
          <Plus /> Yeni Emir
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Yeni satın alma emri</SheetTitle>
          <SheetDescription>
            Tedarikçi ve ürünü seçin, miktar ve maliyeti girin. Emir oluşunca detayına
            yönlendirilirsiniz.
          </SheetDescription>
        </SheetHeader>
        {/* key={open}: her açılışta formu temiz başlat. */}
        <div key={String(open)} className="p-4 pt-0">
          <CreatePOForm suppliers={suppliers} products={products} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
