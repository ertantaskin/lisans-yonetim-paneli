'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Link2, PackageSearch } from 'lucide-react';
import { createMappingAction, type FormState } from '../app/stock/actions';
import type { ProductRow, UnmappedRow } from '../lib/api';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { Field } from './ui/field';
import { Card } from './ui/card';
import { EmptyState } from './ui/page-header';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';

const initial: FormState = { ok: false };

/** ISO tarih → tr-TR gün/ay/yıl (geçersizse em-dash). */
function trDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

/** Ad yoksa (eski sipariş) tutarlı yer tutucu — hem tabloda hem sheet'te aynı metin. */
function displayName(row: UnmappedRow): string {
  return row.remoteName ?? '(ad yok — eski sipariş)';
}

/** Aynı remoteProductId farklı sitelerde olabilir → site+ürün+varyasyon ile benzersiz anahtar. */
function rowKey(row: UnmappedRow): string {
  return `${row.siteId}:${row.remoteProductId}:${row.remoteVariationId ?? ''}`;
}

/**
 * Tek-tıkla eşleme aksiyonu. Sheet açar; mağaza ürünü + site SALT-OKUNUR gösterilir (operatör
 * NEYİ eşlediğini görür), yalnız Panel ürünü (aranabilir Combobox) + Paket adedi sorulur.
 * `remoteProductId`/`remoteVariationId` gizli input ile GERÇEK satır verisinden gider (yazma yok).
 * Başarıda sheet kapanır + `router.refresh()` ile liste tazelenir (eşlenen ürün listeden düşer).
 */
function MapAction({ row, products }: { row: UnmappedRow; products: ProductRow[] }) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [state, action, pending] = React.useActionState(createMappingAction, initial);

  React.useEffect(() => {
    if (state.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state.ok, router]);

  const name = displayName(row);
  // Colon içeren rowKey HTML id/htmlFor için sadeleştirilir (etiket–kontrol bağı bozulmasın).
  const uid = rowKey(row).replace(/[^a-zA-Z0-9]/g, '-');

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button size="sm" variant="outline" aria-label={`${name} mağaza ürününü panel ürününe eşle`}>
          <Link2 /> Eşle
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Mağaza ürününü eşle</SheetTitle>
          <SheetDescription>
            Bu mağaza ürününü hangi panel ürünü teslim etsin? Mağaza bilgileri gerçek sipariş
            verisinden gelir — değiştiremezsiniz.
          </SheetDescription>
        </SheetHeader>

        {/* key={open}: her açılışta formu (Combobox/adet) temiz başlat. */}
        <form key={String(open)} action={action} className="space-y-4 p-4 pt-0">
          {/* SALT-OKUNUR özet — operatör NEYİ eşlediğini doğrular (ekranın asıl değeri). */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div>
              <div className="text-xs text-muted-foreground">Mağaza ürünü</div>
              <div className="text-sm font-medium text-foreground">{name}</div>
              <div className="font-mono text-xs text-muted-foreground">
                #{row.remoteProductId}
                {row.remoteVariationId ? ` · varyasyon ${row.remoteVariationId}` : ''}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Site</div>
              <div className="text-sm text-foreground">{row.siteDomain}</div>
            </div>
          </div>

          {/* Sabit alanlar — gerçek satır verisinden, operatör YAZMAZ (typo riski yok). */}
          <input type="hidden" name="siteId" value={row.siteId} />
          <input type="hidden" name="remoteProductId" value={row.remoteProductId} />
          {row.remoteVariationId && (
            <input type="hidden" name="remoteVariationId" value={row.remoteVariationId} />
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

/**
 * Eşlenmemiş gelen ürünler tablosu (§3). Her satır: site + mağaza ürünü (ad + #id + varyasyon) +
 * sipariş/kalem sayısı + son görülme + tek-tıkla "Eşle". Boşsa: tüm gelen siparişler eşli.
 */
export function UnmappedTable({ rows, products }: { rows: UnmappedRow[]; products: ProductRow[] }) {
  if (rows.length === 0) {
    return (
      <Card className="p-0">
        <EmptyState
          icon={PackageSearch}
          title="Eşlenmemiş gelen ürün yok"
          description="Tüm gelen siparişler bir panel ürününe eşli. Yeni bir mağaza ürünü sipariş edildiğinde burada görünür."
        />
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {rows.length} eşlenmemiş mağaza ürünü — her biri gerçek bir siparişte geldi ama panelde bir
        ürüne bağlı değil.
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-sm">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Site</TableHead>
              <TableHead>Mağaza ürünü</TableHead>
              <TableHead className="text-right">Sipariş / Adet</TableHead>
              <TableHead>Son görülme</TableHead>
              <TableHead className="text-right">Aksiyon</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                <TableCell className="text-xs text-muted-foreground">{row.siteDomain}</TableCell>
                <TableCell>
                  <div className="font-medium text-foreground">{displayName(row)}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    #{row.remoteProductId}
                    {row.remoteVariationId ? ` · varyasyon ${row.remoteVariationId}` : ''}
                  </div>
                </TableCell>
                <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                  {row.orderCount} sipariş · {row.lineCount} kalem
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{trDate(row.lastSeen)}</TableCell>
                <TableCell className="text-right">
                  <MapAction row={row} products={products} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
