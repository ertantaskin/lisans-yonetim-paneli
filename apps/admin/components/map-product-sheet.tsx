'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Replace } from 'lucide-react';
import {
  createMappingAction,
  changeMappingAction,
  type FormState,
} from '../app/stock/actions';
import type { ProductRow } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { Field } from './ui/field';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';

const initial: FormState = { ok: false };

/**
 * Paylaşılan tek-tıkla eşleme Sheet'i (§3). İKİ mod:
 *  - **create** (varsayılan): mağaza ürününü panel ürününe İLK KEZ eşle ("Eşlenmemiş Gelen Ürünler"
 *    reaktif + "Site Kataloğu" proaktif). Gizli: siteId/remoteProductId/remoteVariationId.
 *  - **edit**: VAR OLAN eşlemenin HEDEF panel ürününü DEĞİŞTİR (remap). Gizli: mappingId. Mağaza
 *    ürünü/site/varyasyon değişmez; yalnız hangi panel ürününün teslim edeceği değişir.
 * Her iki modda da mağaza ürünü + site SALT-OKUNUR gösterilir (operatör NEYİ eşlediğini doğrular),
 * mağaza ID'si gerçek veriden gizli input ile gider — operatör ID YAZMAZ (typo riski yok). Eşleme
 * HER ZAMAN elle; otomatik eşleştirme YOK. Başarıda sheet kapanır + router.refresh() ile liste tazelenir.
 */
export function MapProductSheet({
  mode = 'create',
  siteId,
  siteDomain,
  remoteProductId,
  remoteVariationId,
  productName,
  products,
  mappingId,
  currentProductId,
  currentBundleQty,
}: {
  mode?: 'create' | 'edit';
  siteId: string;
  siteDomain: string;
  remoteProductId: string;
  remoteVariationId: string | null;
  /** Mağaza ürününün görünen adı (eşlenmemişte "(ad yok)" olabilir, katalogda gerçek ad). */
  productName: string;
  products: ProductRow[];
  /** edit modunda ZORUNLU: değiştirilecek eşleme kaydının id'si. */
  mappingId?: string;
  /** edit modunda: mevcut hedef panel ürünü (Combobox varsayılanı). */
  currentProductId?: string | null;
  /** edit modunda: mevcut paket adedi. */
  currentBundleQty?: number | null;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const isEdit = mode === 'edit';
  const [state, action, pending] = React.useActionState(
    isEdit ? changeMappingAction : createMappingAction,
    initial,
  );

  React.useEffect(() => {
    if (state.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state.ok, router]);

  // site+ürün+varyasyon → benzersiz; colon vb. HTML id/htmlFor için sadeleştirilir
  // (etiket–kontrol bağı bozulmasın).
  const uid = `${siteId}:${remoteProductId}:${remoteVariationId ?? ''}`.replace(
    /[^a-zA-Z0-9]/g,
    '-',
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          aria-label={
            isEdit
              ? `${productName} eşlemesini başka panel ürünüyle değiştir`
              : `${productName} mağaza ürününü panel ürününe eşle`
          }
        >
          {isEdit ? (
            <>
              <Replace /> Değiştir
            </>
          ) : (
            <>
              <Link2 /> Eşle
            </>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? 'Eşlemeyi değiştir' : 'Mağaza ürününü eşle'}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? 'Bu mağaza ürününü artık hangi panel ürünü teslim etsin? Mağaza bilgileri değişmez, yalnız hedef panel ürünü değişir.'
              : 'Bu mağaza ürününü hangi panel ürünü teslim etsin? Mağaza bilgileri gerçek katalog/sipariş verisinden gelir — değiştiremezsiniz.'}
          </SheetDescription>
        </SheetHeader>

        {/* key={open}: her açılışta formu (Combobox/adet) temiz başlat. */}
        <form key={String(open)} action={action} className="space-y-4 p-4 pt-0">
          {/* SALT-OKUNUR özet — operatör NEYİ eşlediğini doğrular (ekranın asıl değeri). */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div>
              <div className="text-xs text-muted-foreground">Mağaza ürünü</div>
              <div className="text-sm font-medium text-foreground">{productName}</div>
              <div className="font-mono text-xs text-muted-foreground">
                #{remoteProductId}
                {remoteVariationId ? ` · varyasyon ${remoteVariationId}` : ''}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Site</div>
              <div className="text-sm text-foreground">{siteDomain}</div>
            </div>
          </div>

          {/* Sabit alanlar — modda göre gizli anahtar. create: gerçek katalog/sipariş verisi;
              edit: değiştirilecek eşleme id'si. Operatör hiçbirini YAZMAZ. */}
          {isEdit ? (
            <input type="hidden" name="mappingId" value={mappingId} />
          ) : (
            <>
              <input type="hidden" name="siteId" value={siteId} />
              <input type="hidden" name="remoteProductId" value={remoteProductId} />
              {remoteVariationId && (
                <input type="hidden" name="remoteVariationId" value={remoteVariationId} />
              )}
            </>
          )}

          <Field
            label={isEdit ? 'Yeni panel ürünü' : 'Panel ürünü'}
            htmlFor={`map-product-${uid}`}
            hint="Bu mağaza ürününü teslim edecek panel ürünü. Ada veya SKU'ya göre arayın."
            required
          >
            <Combobox
              id={`map-product-${uid}`}
              name="productId"
              required
              defaultValue={isEdit ? (currentProductId ?? '') : ''}
              ariaLabel={isEdit ? 'Yeni panel ürünü' : 'Panel ürünü'}
              items={products.map((p) => ({
                value: p.id,
                label: p.name,
                hint: p.sku,
                keywords: [p.sku],
              }))}
              placeholder="— ürün seçin —"
              searchPlaceholder="Ürün adı veya SKU…"
              emptyText="Ürün bulunamadı"
            />
          </Field>

          <Field
            label="Paket adedi"
            htmlFor={`map-bundle-${uid}`}
            hint="1 mağaza siparişi kaç lisans teslim etsin (varsayılan 1)."
          >
            <Input
              id={`map-bundle-${uid}`}
              name="bundleQty"
              type="number"
              min={1}
              defaultValue={currentBundleQty && currentBundleQty > 0 ? currentBundleQty : 1}
              className="w-40"
            />
          </Field>

          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}

          <Button type="submit" disabled={pending}>
            {isEdit ? <Replace /> : <Link2 />}{' '}
            {pending ? 'Kaydediliyor…' : isEdit ? 'Değişikliği kaydet' : 'Eşle'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
