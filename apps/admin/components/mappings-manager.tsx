'use client';
import { useActionState } from 'react';
import { ArrowRight, Power } from 'lucide-react';
import {
  createMappingAction,
  updateMappingAction,
  type FormState,
} from '../app/stock/actions';
import type { ProductRow, SiteRow } from '../lib/api';
import { Input, Label, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/** GET /v1/admin/mappings yanıt satırı (site domain + ürün adıyla zenginleştirilmiş). */
export interface MappingRow {
  id: string;
  siteId: string;
  siteDomain: string;
  productId: string;
  productName: string;
  remoteProductId: string;
  remoteVariationId: string | null;
  bundleQty: number;
  active: boolean;
  createdAt: string;
}

const initial: FormState = { ok: false };

/**
 * Site-ürün eşleme yönetimi (§3): oluşturma formu (varyasyon + bundle) + mevcut
 * eşleme listesi (remote → panel, pasifleştir/etkinleştir). createMappingAction
 * useActionState uyumlu — duplicate (UNIQUE) hatası yüzeye çıkar.
 */
export function MappingsManager({
  sites,
  products,
  mappings,
}: {
  sites: SiteRow[];
  products: ProductRow[];
  mappings: MappingRow[];
}) {
  const [state, action, pending] = useActionState(createMappingAction, initial);

  return (
    <div className="space-y-4 text-sm">
      <form action={action} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-site">Site</Label>
            <select id="map-site" name="siteId" required className={`w-full ${selectClass}`}>
              <option value="">— site —</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.domain}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-product">Panel ürünü</Label>
            <select id="map-product" name="productId" required className={`w-full ${selectClass}`}>
              <option value="">— ürün —</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-remote">Woo ürün ID</Label>
            <Input id="map-remote" name="remoteProductId" placeholder="ör. 555" required />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-variation">Woo varyasyon ID (opsiyonel)</Label>
            <Input id="map-variation" name="remoteVariationId" placeholder="ör. 556 (yoksa boş)" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="map-bundle">Paket adedi (1 Woo = N key)</Label>
            <Input
              id="map-bundle"
              name="bundleQty"
              type="number"
              min={1}
              placeholder="varsayılan 1"
              className="w-40"
            />
          </div>
        </div>

        <Button type="submit" disabled={pending}>
          {pending ? 'Eşleniyor…' : 'Eşle'}
        </Button>

        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="text-sm text-success">Eşleme eklendi.</p>}
      </form>

      {/* Mevcut eşlemeler: remote → panel, pasifleştir/etkinleştir */}
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Mevcut eşlemeler ({mappings.length})
        </h3>
        {mappings.length === 0 ? (
          <p className="text-xs text-muted-foreground">Henüz eşleme yok.</p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Remote (ürün · varyasyon)</TableHead>
                  <TableHead>Panel ürünü</TableHead>
                  <TableHead className="text-right">Paket</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Aksiyon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-xs text-muted-foreground">{m.siteDomain}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {m.remoteProductId}
                      {m.remoteVariationId ? ` · ${m.remoteVariationId}` : ''}
                    </TableCell>
                    <TableCell className="font-medium text-foreground">
                      <span className="inline-flex items-center gap-1">
                        <ArrowRight className="size-3 text-muted-foreground" />
                        {m.productName}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.bundleQty}</TableCell>
                    <TableCell>
                      <Badge variant={m.active ? 'success' : 'neutral'}>
                        {m.active ? 'aktif' : 'pasif'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <form action={updateMappingAction} className="inline">
                        <input type="hidden" name="id" value={m.id} />
                        <input type="hidden" name="active" value={String(!m.active)} />
                        <Button
                          type="submit"
                          variant="ghost"
                          size="sm"
                          aria-label={m.active ? 'Eşlemeyi pasifleştir' : 'Eşlemeyi etkinleştir'}
                        >
                          <Power /> {m.active ? 'Pasifleştir' : 'Etkinleştir'}
                        </Button>
                      </form>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}
