'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Power, Trash2 } from 'lucide-react';
import {
  createMappingAction,
  updateMappingAction,
  removeMappingAction,
  fetchSiteCatalogAction,
  type FormState,
} from '../app/stock/actions';
import type { CatalogRow, SiteRow } from '../lib/api';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Combobox } from './ui/combobox';
import { Badge } from './ui/badge';
import { Field } from './ui/field';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/** Ürün detayı eşleme satırı (site domain + mağaza ürün adıyla zenginleştirilmiş). */
export interface MappingRow {
  id: string;
  siteId: string;
  siteDomain: string;
  productId: string;
  productName: string;
  remoteProductId: string;
  remoteVariationId: string | null;
  /** Katalogdan öğrenilen mağaza ürün adı (varsa) — ham ID yerine. */
  remoteName: string | null;
  bundleQty: number;
  active: boolean;
  createdAt: string;
}

const initial: FormState = { ok: false };
/** Mağaza ürünü Combobox değer ayracı: `remoteProductId␟varyasyon`. */
const SEP = '␟';

/**
 * Ürün detayı "Site Eşlemeleri" (§3) — ürün-merkezli, KATALOG TABANLI (panel geneli /mappings ile
 * AYNI kullanım): önce site seç → o mağazanın kataloğundan ürünü ADIYLA seç (ham ID YAZMA) → bu panel
 * ürününe eşle. **Otomatik eşleştirme YOK** — operatör seçer. Mevcut eşlemeler: mağaza adıyla listelenir,
 * Pasifleştir/Etkinleştir + Kaldır (onaylı). createMappingAction useActionState uyumlu (409 duplicate yüzeye çıkar).
 */
export function MappingsManager({
  sites,
  mappings,
  productId,
}: {
  sites: SiteRow[];
  mappings: MappingRow[];
  /** Ürün SABİT (ürün detayı) → panel ürünü seçimi yok, hidden gönderilir. */
  productId: string;
}) {
  const [state, action, pending] = useActionState(createMappingAction, initial);
  const [siteId, setSiteId] = React.useState('');
  const [catalog, setCatalog] = React.useState<CatalogRow[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [catErr, setCatErr] = React.useState<string | null>(null);
  const [store, setStore] = React.useState(''); // `remoteProductId␟varyasyon`

  // Site seçilince o sitenin kataloğunu getir → mağaza ürününü ADIYLA seç (sunucu action, token gizli).
  const loadCatalog = React.useCallback((sid: string) => {
    setSiteId(sid);
    setStore('');
    setCatalog([]);
    setCatErr(null);
    if (!sid) return;
    setLoading(true);
    fetchSiteCatalogAction(sid)
      .then((r) => {
        if (r.ok && r.rows) setCatalog(r.rows);
        else setCatErr(r.error ?? 'Katalog alınamadı');
      })
      .catch(() => setCatErr('Katalog alınamadı'))
      .finally(() => setLoading(false));
  }, []);

  // Başarılı eşleme sonrası mağaza seçimini temizle + kataloğu tazele (satır artık "eşli" görünür).
  // Mevcut eşleme listesi zaten revalidatePath('/products/:id') ile sunucudan tazelenir.
  React.useEffect(() => {
    if (state.ok) {
      setStore('');
      if (siteId) loadCatalog(siteId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.ok]);

  const sepIdx = store.indexOf(SEP);
  const remoteProductId = sepIdx >= 0 ? store.slice(0, sepIdx) : '';
  const remoteVariationId = sepIdx >= 0 ? store.slice(sepIdx + 1) : '';

  return (
    <div className="space-y-4 text-sm">
      <form action={action} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Site" htmlFor="map-site" hint="Önce mağazayı seçin (yazarak arayın).">
            <Combobox
              id="map-site"
              value={siteId}
              onValueChange={loadCatalog}
              ariaLabel="Site"
              items={sites.map((s) => ({ value: s.id, label: s.domain }))}
              placeholder="— site seçin —"
              searchPlaceholder="Site alan adı ara…"
              emptyText="Site bulunamadı"
            />
          </Field>
          <Field
            label="Mağaza ürünü"
            htmlFor="map-store"
            hint={
              !siteId
                ? 'Önce site seçin.'
                : loading
                  ? 'Katalog yükleniyor…'
                  : catalog.length === 0
                    ? 'Bu sitenin kataloğu boş — WP’de “Ürünleri Panele Aktar” deyin.'
                    : 'Adıyla arayıp seçin — ID yazmanıza gerek yok.'
            }
          >
            <Combobox
              id="map-store"
              value={store}
              onValueChange={setStore}
              disabled={!siteId || loading || catalog.length === 0}
              ariaLabel="Mağaza ürünü"
              items={catalog.map((c) => ({
                value: `${c.remoteProductId}${SEP}${c.remoteVariationId ?? ''}`,
                label: c.name,
                hint: `#${c.remoteProductId}${c.remoteVariationId ? ` · var ${c.remoteVariationId}` : ''}${
                  c.mapped ? ` · eşli: ${c.mappedProductName ?? ''}` : ''
                }`,
                keywords: [c.sku ?? '', c.remoteProductId],
              }))}
              placeholder="— mağaza ürünü seçin —"
              searchPlaceholder="Ürün adı / SKU / ID ara…"
              emptyText="Ürün bulunamadı"
            />
          </Field>
          <Field
            label="Paket adedi"
            htmlFor="map-bundle"
            hint="1 mağaza siparişi kaç lisans teslim etsin (varsayılan 1)."
          >
            <Input
              id="map-bundle"
              name="bundleQty"
              type="number"
              min={1}
              placeholder="varsayılan 1"
              className="w-40"
            />
          </Field>
        </div>

        {/* Gizli alanlar — operatör ID YAZMAZ; hepsi seçimden gelir (typo riski yok). */}
        <input type="hidden" name="productId" value={productId} />
        <input type="hidden" name="siteId" value={siteId} />
        <input type="hidden" name="remoteProductId" value={remoteProductId} />
        {remoteVariationId && (
          <input type="hidden" name="remoteVariationId" value={remoteVariationId} />
        )}

        <Button type="submit" disabled={pending || !siteId || !store}>
          <Link2 /> {pending ? 'Eşleniyor…' : 'Eşle'}
        </Button>

        {catErr && <p className="text-sm text-destructive">Katalog: {catErr}</p>}
        {state.error && <p className="text-sm text-destructive">{state.error}</p>}
        {state.ok && <p className="text-sm text-success">Eşleme eklendi.</p>}
      </form>

      {/* Mevcut eşlemeler: mağaza ürünü (adıyla) → bu panel ürünü; Pasifleştir + Kaldır. */}
      <div>
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          Mevcut eşlemeler ({mappings.length})
        </h3>
        {mappings.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Henüz eşleme yok. Yukarıdan site + mağaza ürününü seçip bu ürüne eşleyin.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Site</TableHead>
                  <TableHead>Mağaza ürünü</TableHead>
                  <TableHead className="text-right">Paket</TableHead>
                  <TableHead>Durum</TableHead>
                  <TableHead className="text-right">Aksiyon</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mappings.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="text-xs text-muted-foreground">{m.siteDomain}</TableCell>
                    <TableCell>
                      <div className="font-medium text-foreground">
                        {m.remoteName ?? `#${m.remoteProductId}`}
                      </div>
                      <div className="font-mono text-xs text-muted-foreground">
                        #{m.remoteProductId}
                        {m.remoteVariationId ? ` · var ${m.remoteVariationId}` : ''}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{m.bundleQty}</TableCell>
                    <TableCell>
                      <Badge variant={m.active ? 'success' : 'neutral'}>
                        {m.active ? 'aktif' : 'pasif'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <form action={updateMappingAction} className="inline">
                          <input type="hidden" name="id" value={m.id} />
                          <input type="hidden" name="active" value={String(!m.active)} />
                          <input type="hidden" name="productId" value={productId} />
                          <Button
                            type="submit"
                            variant="ghost"
                            size="sm"
                            aria-label={m.active ? 'Eşlemeyi pasifleştir' : 'Eşlemeyi etkinleştir'}
                          >
                            <Power /> {m.active ? 'Pasifleştir' : 'Etkinleştir'}
                          </Button>
                        </form>
                        <RemoveButton
                          mappingId={m.id}
                          productId={productId}
                          label={m.remoteName ?? `#${m.remoteProductId}`}
                        />
                      </div>
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

/** Eşlemeyi KALDIR (onaylı). Ürün detayını tazeler (removeMappingAction productId ile). */
function RemoveButton({
  mappingId,
  productId,
  label,
}: {
  mappingId: string;
  productId: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, start] = React.useTransition();
  return (
    <form
      action={(fd) => {
        if (
          !window.confirm(
            `"${label}" eşlemesini kaldırmak istediğinize emin misiniz?\n\nBu mağaza ürününün yeni siparişleri artık bu ürünü çözemez (beklemede kalır). İstediğinizde yeniden eşleyebilirsiniz.`,
          )
        ) {
          return;
        }
        start(async () => {
          await removeMappingAction(fd);
          router.refresh();
        });
      }}
    >
      <input type="hidden" name="mappingId" value={mappingId} />
      <input type="hidden" name="productId" value={productId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={pending}
        aria-label={`${label} eşlemesini kaldır`}
      >
        <Trash2 /> {pending ? 'Kaldırılıyor…' : 'Kaldır'}
      </Button>
    </form>
  );
}
