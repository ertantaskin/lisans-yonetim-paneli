'use client';
import { useActionState, useEffect, useState } from 'react';
import { CheckCircle2, Info, Plus, TriangleAlert } from 'lucide-react';
import { createStockAdjustmentAction, type StockAdjustState } from './actions';
import {
  fetchLicenseItemsAction,
  type LicenseInventoryRow,
} from '../../stock/license-actions';
import { Input, Textarea, selectClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Combobox } from '../../../components/ui/combobox';
import { Field } from '../../../components/ui/field';
import { adjustmentActionLabel } from '../../../lib/labels';
import { fmtDateTime } from '../../../lib/utils';

// Başlangıç durumu istemcide (server-action dosyası yalnız async fonksiyon export edebilir).
const initialStockAdjustState: StockAdjustState = { ok: false };

/** Kalem seçimi ZORUNLU olan (gerçekten stoktan düşen) işlemler. */
const DESTRUCTIVE = new Set(['void', 'damage']);

/** Seçicide gösterilecek kalem sayısı (API'nin izin verdiği en büyük sayfa boyutu). */
const PICKER_PAGE_SIZE = 100;

/**
 * Bir envanter satırını seçicide okunur tek satıra indirger.
 * key ürününde anahtar değeri (rol maskeliyse maskeli), hesap ürününde ilk GİZLİ OLMAYAN alan
 * (kullanıcı adı vb.) — parola asla etiket olarak kullanılmaz.
 */
function itemLabel(row: LicenseInventoryRow): string {
  if (row.kind === 'account') {
    const visible = (row.fields ?? []).find((f) => !f.secret);
    return visible ? `${visible.label}: ${visible.value}` : 'Hesap kaydı';
  }
  return row.value ?? 'Anahtar';
}

/**
 * Manuel stok düzeltme formu (§12). Aksiyon + adet + (void/damage'de ZORUNLU) lisans kalemi
 * + ZORUNLU sebep. Server action POST /v1/admin/stock-adjustments çağırır.
 *
 * NEDEN kalem seçici (denetim bulgusu): eskiden alan serbest metindi ve operatörden ham UUID
 * bekliyordu; panelin hiçbir ekranı o UUID'yi göstermediği için alan pratikte hep boş kalıyor,
 * backend de yalnız defter kaydı yazıyordu → form "Eklendi" derken satılabilir stok HİÇ
 * düşmüyor, bozuk anahtarlar müşteriye teslim edilmeye devam ediyordu. Artık kalem bu ürünün
 * stoktaki (available) lisanslarından SEÇİLİR ve sonuç mesajı stokun gerçekten değişip
 * değişmediğini dürüstçe söyler.
 */
export function StockAdjustForm({ productId }: { productId: string }) {
  const [state, action, pending] = useActionState(
    createStockAdjustmentAction,
    initialStockAdjustState,
  );

  const [adjAction, setAdjAction] = useState('correct');
  const [licenseItemId, setLicenseItemId] = useState('');
  const [items, setItems] = useState<LicenseInventoryRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [loadingItems, setLoadingItems] = useState(false);

  const needsItem = DESTRUCTIVE.has(adjAction);

  // Seçici yalnız gerektiğinde (void/damage) yüklenir; başarılı kayıttan sonra tazelenir
  // (iptal edilen kalem artık 'available' değildir → listeden düşmeli).
  useEffect(() => {
    if (!needsItem) return;
    let cancelled = false;
    setLoadingItems(true);
    setItemsError(null);
    fetchLicenseItemsAction({
      productId,
      status: 'available',
      pageSize: PICKER_PAGE_SIZE,
      sort: 'created_desc',
    })
      .then((res) => {
        if (cancelled) return;
        if (!res.ok || !res.page) {
          setItems([]);
          setItemsError(res.error ?? 'Stoktaki lisanslar yüklenemedi.');
          return;
        }
        setItems(res.page.rows);
        setTotal(res.page.total);
      })
      .catch(() => {
        if (!cancelled) {
          setItems([]);
          setItemsError('Stoktaki lisanslar yüklenemedi.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingItems(false);
      });
    return () => {
      cancelled = true;
    };
  }, [needsItem, productId, state.saved]);

  // Kayıt sonrası seçim sıfırlanır (aynı kalem ikinci kez seçilemez — zaten iptal edildi).
  useEffect(() => {
    if (state.saved) setLicenseItemId('');
  }, [state.saved]);

  const itemOptions = (items ?? []).map((row) => ({
    value: row.id,
    label: itemLabel(row),
    hint: row.batchCode ? `${row.batchCode} · ${fmtDateTime(row.createdAt)}` : fmtDateTime(row.createdAt),
    keywords: [row.batchCode ?? '', row.supplierName ?? ''].filter(Boolean),
  }));

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="productId" value={productId} />

      <div className="flex flex-wrap gap-3">
        <Field
          label="İşlem türü"
          htmlFor="adj-action"
          hint={
            needsItem
              ? 'Seçilen lisans stoktan düşülür (geri alınamaz).'
              : 'Yalnız defter kaydı — satılabilir stok değişmez.'
          }
        >
          <select
            id="adj-action"
            name="action"
            value={adjAction}
            onChange={(e) => setAdjAction(e.target.value)}
            className={`${selectClass} w-44`}
          >
            <option value="correct">{adjustmentActionLabel('correct')}</option>
            <option value="void">{adjustmentActionLabel('void')}</option>
            <option value="damage">{adjustmentActionLabel('damage')}</option>
            <option value="recall">{adjustmentActionLabel('recall')}</option>
          </select>
        </Field>
        {/* Kalem-kapsamlı iptalde adet FORMDAN değil, yok edilen kalemden türetilir
            (tek kullanımlık=1, MAK=kalan kapasite) → alanı göstermek yanıltıcı olurdu. */}
        {!needsItem && (
          <Field label="Adet" htmlFor="adj-qty" hint="Deftere yazılacak adet (stok değişmez).">
            <Input
              id="adj-qty"
              name="qty"
              type="number"
              min={0}
              step={1}
              defaultValue={0}
              className="w-32"
            />
          </Field>
        )}
      </div>

      {needsItem && (
        <Field
          label="Stoktan düşülecek lisans"
          htmlFor="adj-item"
          required
          hint={
            loadingItems
              ? 'Stoktaki lisanslar yükleniyor…'
              : total > PICKER_PAGE_SIZE
                ? `En yeni ${PICKER_PAGE_SIZE} satılabilir lisans listelendi (toplam ${total}). Aramak için yazın; aradığınız yoksa Lisans Envanteri’nden iptal edin.`
                : 'Yalnız bu ürünün satılabilir (stokta) lisansları listelenir.'
          }
        >
          <Combobox
            id="adj-item"
            name="licenseItemId"
            required
            ariaLabel="Stoktan düşülecek lisans"
            className="max-w-md"
            value={licenseItemId}
            onValueChange={setLicenseItemId}
            items={itemOptions}
            disabled={loadingItems || itemOptions.length === 0}
            placeholder={
              loadingItems
                ? 'Yükleniyor…'
                : itemOptions.length === 0
                  ? '— stokta lisans yok —'
                  : '— lisans seçin —'
            }
            searchPlaceholder="Anahtar, parti veya tedarikçi…"
            emptyText="Eşleşen lisans yok"
          />
        </Field>
      )}
      {needsItem && itemsError && (
        <p className="text-xs text-destructive">{itemsError}</p>
      )}
      {needsItem && !loadingItems && !itemsError && itemOptions.length === 0 && (
        <p className="text-xs text-warning">
          Bu üründe satılabilir lisans yok — geçersiz kılınacak kalem seçilemez.
        </p>
      )}
      {!needsItem && (
        <p className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          “{adjustmentActionLabel(adjAction)}” yalnız denetim defterine yazılır; satılabilir stok
          DEĞİŞMEZ. Bozuk bir anahtarı gerçekten stoktan düşmek için “
          {adjustmentActionLabel('void')}” veya “{adjustmentActionLabel('damage')}” seçip lisansı
          işaretleyin.
        </p>
      )}

      <Field
        label="Sebep"
        htmlFor="adj-reason"
        required
        hint="Denetim (audit) kaydına yazılır."
      >
        <Textarea
          id="adj-reason"
          name="reason"
          required
          rows={2}
          placeholder="ör. tedarikçi partisi bozuk — key kullanılamıyor"
          className="max-w-md"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending || (needsItem && !licenseItemId)}>
          <Plus /> {pending ? 'Kaydediliyor…' : 'Düzeltme Ekle'}
        </Button>
        {/* Dürüstlük: stok değişmediyse YEŞİL "Eklendi" gösterilmez. */}
        {state.saved && state.affectedStock && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" />
            Lisans stoktan düşüldü ({state.qty ?? 0} birim).
          </span>
        )}
        {state.saved && !state.affectedStock && (
          <span className="inline-flex items-start gap-1.5 text-xs font-medium text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Kayıt deftere yazıldı — satılabilir stok DEĞİŞMEDİ.
          </span>
        )}
        {state.error && (
          <span className="inline-flex items-start gap-1.5 text-xs font-medium text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
