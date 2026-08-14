'use client';
import * as React from 'react';
import Link from 'next/link';
import { ArrowRight, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  createCategoryAction,
  deleteCategoryAction,
  updateCategoryAction,
  type CategoryFormState,
} from '@/app/categories/actions';
import { UNCATEGORIZED, type CategoryRow } from '@/lib/categories';
import { Button } from './ui/button';
import { CollapsiblePanel } from './ui/collapsible-panel';
import { useConfirm } from './ui/confirm';
import { Field, FieldRow } from './ui/field';
import { Input, Textarea } from './ui/input';
import { EmptyState } from './ui/page-header';

/** 'use server' dosyasından obje export EDİLEMEZ → başlangıç durumu burada yerel sabit. */
const initialState: CategoryFormState = { ok: false };

/**
 * Kategori yönetimi (§17) — ekle / yeniden adlandır / açıklama / sıra / sil.
 *
 * Ürün formunda kategori SERBEST YAZILAMAZ, yalnız buradan seçilir: kullanıcı kararı
 * "ad tek yerden yönetilsin" idi. İkiz kategori ("Office" / "office") API'de
 * büyük/küçük harf duyarsız unique index ile zaten reddedilir.
 *
 * Silme ÜRÜN SİLMEZ — ürünler "Kategorisiz" olur; onay kutusunda kaç ürünün etkileneceği
 * YAZILI (sessiz yan etki bırakmamak bu panelin kuralı).
 */
export function CategoriesManager({ categories }: { categories: CategoryRow[] }) {
  // `dialog` render edilmezse onay modali HİÇ görünmez ve söz asla çözülmez (donmuş handler).
  const { confirm, dialog } = useConfirm();
  // Kategorisiz kova gerçek bir kayıt değil → yönetim listesinde görünmez.
  const rows = categories.filter((c) => c.id !== UNCATEGORIZED);
  const [editing, setEditing] = React.useState<string | null>(null);

  const onDelete = async (row: CategoryRow) => {
    const ok = await confirm({
      title: `“${row.name}” kategorisi silinsin mi?`,
      description:
        row.productCount > 0
          ? `Bu kategorideki ${row.productCount} ürün SİLİNMEZ, “Kategorisiz” olur ve stokları/siparişleri etkilenmez.`
          : 'Bu kategoride ürün yok.',
      confirmLabel: 'Sil',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await deleteCategoryAction(row.id);
    if (res.ok) toast.success(res.message ?? 'Kategori silindi.');
    else toast.error(res.error ?? 'Silinemedi');
  };

  return (
    <div className="space-y-4">
      {dialog}
      <CollapsiblePanel
        title="Yeni kategori"
        icon={<Plus className="size-3.5" />}
        openLabel="Yeni Kategori"
        description="Örn. “Windows lisansları”, “Office lisansları”, “Yapay zekâ abonelikleri”, “Oyun hesapları”."
      >
        <CategoryForm key="create" onDone={() => undefined} />
      </CollapsiblePanel>

      {rows.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="Henüz kategori yok"
          description="Kategoriler ürünleri gruplar: Stok & Ürünler ekranı bu gruplara göre açılır. Ürünleri kategorisiz de bırakabilirsiniz — “Kategorisiz” kartında görünürler."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {rows.map((row) => (
            <li key={row.id} className="p-4">
              {editing === row.id ? (
                <CategoryForm
                  category={row}
                  onDone={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">{row.name}</p>
                    {row.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{row.description}</p>
                    )}
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="tabular-nums">{row.productCount}</span> ürün ·{' '}
                      <span className="tabular-nums">
                        {row.availableStock.toLocaleString('tr-TR')}
                      </span>{' '}
                      atanabilir stok · sıra{' '}
                      <span className="tabular-nums">{row.sortOrder}</span>
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/stock?category=${encodeURIComponent(row.id)}`}>
                        Ürünleri <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditing(row.id)}>
                      <Pencil className="size-3.5" /> Düzenle
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void onDelete(row)}>
                      <Trash2 className="size-3.5" /> Sil
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Çift modlu form: `category` verilmezse oluşturur, verilirse günceller (gizli id ile). */
function CategoryForm({
  category,
  onDone,
  onCancel,
}: {
  category?: CategoryRow;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(category);
  const [state, formAction, pending] = React.useActionState<CategoryFormState, FormData>(
    editing ? updateCategoryAction : createCategoryAction,
    initialState,
  );

  React.useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone?.();
    }
  }, [state.ok, state.message, onDone]);

  return (
    <form action={formAction} className="space-y-3">
      {editing && <input type="hidden" name="id" value={category!.id} />}
      <FieldRow>
        <Field
          label="Kategori adı"
          htmlFor={`cat-name-${category?.id ?? 'new'}`}
          required
          hint="Stok & Ürünler ekranındaki kartın başlığı olur."
        >
          <Input
            id={`cat-name-${category?.id ?? 'new'}`}
            name="name"
            defaultValue={category?.name ?? ''}
            required
            maxLength={80}
            placeholder="ör. Windows lisansları"
          />
        </Field>
        <Field
          label="Sıra"
          htmlFor={`cat-sort-${category?.id ?? 'new'}`}
          hint="Küçük sayı önce gelir. Eşitlikte ada göre sıralanır."
        >
          <Input
            id={`cat-sort-${category?.id ?? 'new'}`}
            name="sortOrder"
            type="number"
            min={0}
            max={9999}
            defaultValue={category?.sortOrder ?? 0}
            className="sm:w-28"
          />
        </Field>
      </FieldRow>
      <Field
        label="Açıklama"
        htmlFor={`cat-desc-${category?.id ?? 'new'}`}
        hint="Kartın altında görünür — bu kategoriye hangi ürünlerin gireceğini bir cümleyle anlatın (opsiyonel)."
      >
        <Textarea
          id={`cat-desc-${category?.id ?? 'new'}`}
          name="description"
          rows={2}
          maxLength={200}
          defaultValue={category?.description ?? ''}
          placeholder="ör. Windows 10/11 Pro ve Home perakende anahtarları"
        />
      </Field>
      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending}>
          <Save className="size-3.5" /> {pending ? 'Kaydediliyor…' : editing ? 'Kaydet' : 'Ekle'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X className="size-3.5" /> Vazgeç
          </Button>
        )}
      </div>
    </form>
  );
}
