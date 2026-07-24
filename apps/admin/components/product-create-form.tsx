'use client';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProductRow } from '../lib/api';
import { Input, Label, selectClass } from './ui/input';
import { Button } from './ui/button';

type SchemaField = { key: string; label: string; secret: boolean };

const DEFAULT_ACCOUNT_FIELDS: SchemaField[] = [
  { key: 'username', label: 'Kullanıcı adı', secret: false },
  { key: 'password', label: 'Parola', secret: true },
];

/**
 * Ürün form alanları — create + edit ortak (§11). kind'e göre koşullu alanlar:
 * - account → payloadSchema editörü (alanlar: key/label/secret)
 * - multi → maxUses (zorunlu, >1)
 * - süreli → validityDays + onExpiry
 * - stoksuz/ön-sipariş → stockless + releaseAt
 * payloadSchema gizli input'a JSON olarak serialize edilir; server action iletir.
 * `defaults` verilirse (düzenleme) alanlar ön-dolu gelir.
 */
export function ProductFormFields({ defaults }: { defaults?: Partial<ProductRow> }) {
  const [kind, setKind] = useState(defaults?.kind ?? 'key');
  const [usageMode, setUsageMode] = useState(defaults?.usageMode ?? 'single');
  const [fields, setFields] = useState<SchemaField[]>(
    defaults?.payloadSchema && defaults.payloadSchema.length > 0
      ? defaults.payloadSchema.map((f) => ({ key: f.key, label: f.label, secret: f.secret }))
      : DEFAULT_ACCOUNT_FIELDS,
  );

  const setField = (i: number, patch: Partial<SchemaField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, { key: '', label: '', secret: false }]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, j) => j !== i));

  const schemaJson =
    kind === 'account' ? JSON.stringify(fields.filter((f) => f.key.trim() && f.label.trim())) : '';

  return (
    <div className="space-y-3 text-sm">
      <Input name="sku" aria-label="SKU" placeholder="SKU (win11-pro)" defaultValue={defaults?.sku} required />
      <Input name="name" aria-label="Ürün adı" placeholder="Ürün adı" defaultValue={defaults?.name} required />

      <div className="flex flex-wrap gap-2">
        <select
          name="kind"
          aria-label="Ürün tipi"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={selectClass}
        >
          <option value="key">key (lisans anahtarı)</option>
          <option value="account">account (hesap)</option>
          <option value="code">code (kod/hediye çeki)</option>
          <option value="custom">custom</option>
        </select>
        <select
          name="usageMode"
          aria-label="Kullanım modu"
          value={usageMode}
          onChange={(e) => setUsageMode(e.target.value)}
          className={selectClass}
        >
          <option value="single">tek kullanımlık</option>
          <option value="multi">çok kullanımlık (MAK)</option>
        </select>
        <select
          name="fulfillmentPolicy"
          aria-label="Teslimat politikası"
          defaultValue={defaults?.fulfillmentPolicy ?? 'partial-auto'}
          className={selectClass}
        >
          <option value="partial-auto">partial-auto</option>
          <option value="partial-approval">partial-approval</option>
          <option value="all-or-nothing">all-or-nothing</option>
        </select>
      </div>

      {/* multi → maxUses zorunlu */}
      {usageMode === 'multi' && (
        <Input
          name="maxUses"
          type="number"
          min={2}
          aria-label="Maksimum kullanım"
          placeholder="max kullanım (>1, ör. 500)"
          defaultValue={defaults?.maxUses ?? undefined}
          required
        />
      )}

      {/* account → payloadSchema editörü */}
      {kind === 'account' && (
        <div className="rounded-md border border-border bg-muted/40 p-3">
          <div className="mb-2 text-xs font-medium text-muted-foreground">Hesap alanları (payloadSchema)</div>
          <input type="hidden" name="payloadSchema" value={schemaJson} />
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  value={f.key}
                  onChange={(e) => setField(i, { key: e.target.value })}
                  aria-label={`Alan ${i + 1} anahtarı`}
                  placeholder="anahtar (username)"
                  className="h-8 w-36"
                />
                <Input
                  value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  aria-label={`Alan ${i + 1} etiketi`}
                  placeholder="etiket (Kullanıcı adı)"
                  className="h-8 w-44"
                />
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={f.secret}
                    onChange={(e) => setField(i, { secret: e.target.checked })}
                    className="accent-primary"
                  />
                  gizli
                </label>
                <Button
                  type="button"
                  onClick={() => removeField(i)}
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Alanı sil"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <Button type="button" onClick={addField} variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs">
            <Plus className="size-3.5" /> alan ekle
          </Button>
        </div>
      )}

      {/* süreli (validityDays) + onExpiry */}
      <div className="flex flex-wrap gap-2">
        <Input
          name="validityDays"
          type="number"
          min={1}
          aria-label="Geçerlilik (gün)"
          placeholder="geçerlilik (gün, süreli hesap)"
          defaultValue={defaults?.validityDays ?? undefined}
          className="w-52"
        />
        <select
          name="onExpiry"
          aria-label="Süre bitince davranış"
          defaultValue={defaults?.onExpiry ?? 'hide'}
          className={selectClass}
          title="süre bitince"
        >
          <option value="hide">süre bitince gizle</option>
          <option value="keep">süre bitince göster</option>
        </select>
      </div>

      {/* garanti + düşük stok eşiği */}
      <div className="flex flex-wrap gap-2">
        <Input
          name="warrantyDays"
          type="number"
          min={0}
          aria-label="Garanti (gün)"
          placeholder="garanti (gün, ör. 30)"
          defaultValue={defaults?.warrantyDays ?? undefined}
          className="w-44"
        />
        <Input
          name="lowStockThreshold"
          type="number"
          min={0}
          aria-label="Düşük stok eşiği"
          placeholder="düşük stok eşiği (boş=kapalı)"
          defaultValue={defaults?.lowStockThreshold ?? undefined}
          className="w-56"
          title="boş bırakılırsa düşük stok uyarısı kapalı"
        />
      </div>

      {/* stoksuz / ön-sipariş */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <input
            type="checkbox"
            name="stockless"
            value="on"
            defaultChecked={defaults?.stockless ?? false}
            className="accent-primary"
          />
          stoksuz / ön-sipariş
        </label>
        <div className="flex flex-col gap-1">
          <Label htmlFor="releaseAt">Yayın tarihi (release_at)</Label>
          <Input
            id="releaseAt"
            name="releaseAt"
            type="datetime-local"
            aria-label="Yayın tarihi"
            className="w-56"
          />
        </div>
      </div>

      <Input
        name="keyFormat"
        aria-label="Key format regex"
        placeholder="key_format regex (opsiyonel, ör. ^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$)"
        defaultValue={defaults?.keyFormat ?? undefined}
        className="font-mono text-xs"
      />
    </div>
  );
}
// NOT: ProductCreateForm kaldırıldı → oluşturma artık product-create-sheet.tsx (Sheet). Bu dosya
// yalnız paylaşımlı ProductFormFields'ı export eder (create-sheet + edit-sheet + [gelecek] kullanır).
