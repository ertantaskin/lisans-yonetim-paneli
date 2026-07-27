'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Link2 } from 'lucide-react';
import { createMappingAction, type FormState } from '../app/stock/actions';
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
 * Paylaşılan tek-tıkla eşleme Sheet'i (§3). Hem "Eşlenmemiş Gelen Ürünler" (reaktif — bir
 * siparişte GELMİŞ ürün) hem "Site Kataloğu" (proaktif — sipariş beklemeden mağaza kataloğu)
 * ekranları AYNI akışı kullanır: mağaza ürünü + site SALT-OKUNUR gösterilir (operatör NEYİ
 * eşlediğini doğrular), yalnız Panel ürünü (aranabilir Combobox) + Paket adedi sorulur.
 * `siteId`/`remoteProductId`/`remoteVariationId` gizli input ile GERÇEK satır/katalog verisinden
 * gider — operatör ID YAZMAZ (elle-ID typo riski yok). Başarıda sheet kapanır + `router.refresh()`
 * ile mevcut liste tazelenir (eşlenen ürün "eşli" olur / listeden düşer).
 */
export function MapProductSheet({
  siteId,
  siteDomain,
  remoteProductId,
  remoteVariationId,
  productName,
  products,
}: {
  siteId: string;
  siteDomain: string;
  remoteProductId: string;
  remoteVariationId: string | null;
  /** Mağaza ürününün görünen adı (eşlenmemişte "(ad yok)" olabilir, katalogda gerçek ad). */
  productName: string;
  products: ProductRow[];
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, action, pending] = React.useActionState(createMappingAction, initial);

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
          aria-label={`${productName} mağaza ürününü panel ürününe eşle`}
        >
          <Link2 /> Eşle
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Mağaza ürününü eşle</SheetTitle>
          <SheetDescription>
            Bu mağaza ürününü hangi panel ürünü teslim etsin? Mağaza bilgileri gerçek katalog/sipariş
            verisinden gelir — değiştiremezsiniz.
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

          {/* Sabit alanlar — gerçek satır/katalog verisinden, operatör YAZMAZ (typo riski yok). */}
          <input type="hidden" name="siteId" value={siteId} />
          <input type="hidden" name="remoteProductId" value={remoteProductId} />
          {remoteVariationId && (
            <input type="hidden" name="remoteVariationId" value={remoteVariationId} />
          )}

          <Field
            label="Panel ürünü"
            htmlFor={`map-product-${uid}`}
            hint="Bu mağaza ürününü teslim edecek panel ürünü. Ada veya SKU'ya göre arayın."
            required
          >
            <Combobox
              id={`map-product-${uid}`}
              name="productId"
              required
              ariaLabel="Panel ürünü"
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
              defaultValue={1}
              className="w-40"
            />
          </Field>

          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}

          <Button type="submit" disabled={pending}>
            <Link2 /> {pending ? 'Eşleniyor…' : 'Eşle'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}
