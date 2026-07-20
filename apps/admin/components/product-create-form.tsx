'use client';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { createProductAction } from '../app/stock/actions';
import { Input, selectClass } from './ui/input';
import { Button } from './ui/button';

type SchemaField = { key: string; label: string; secret: boolean };

/**
 * Ürün oluşturma — kind'e göre koşullu alanlar (§11):
 * - account → payloadSchema editörü (alanlar: key/label/secret)
 * - multi → maxUses (zorunlu, >1)
 * - süreli → validityDays + onExpiry
 * payloadSchema gizli input'a JSON olarak serialize edilir; server action iletir.
 */
export function ProductCreateForm() {
  const [kind, setKind] = useState('key');
  const [usageMode, setUsageMode] = useState('single');
  const [fields, setFields] = useState<SchemaField[]>([
    { key: 'username', label: 'Kullanıcı adı', secret: false },
    { key: 'password', label: 'Parola', secret: true },
  ]);

  const setField = (i: number, patch: Partial<SchemaField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((fs) => [...fs, { key: '', label: '', secret: false }]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, j) => j !== i));

  const schemaJson =
    kind === 'account' ? JSON.stringify(fields.filter((f) => f.key.trim() && f.label.trim())) : '';

  return (
    <form action={createProductAction} className="space-y-3 text-sm">
      <Input name="sku" aria-label="SKU" placeholder="SKU (win11-pro)" required />
      <Input name="name" aria-label="Ürün adı" placeholder="Ürün adı" required />

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
        <select name="fulfillmentPolicy" aria-label="Teslimat politikası" className={selectClass}>
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
          className="w-52"
        />
        <select name="onExpiry" aria-label="Süre bitince davranış" className={selectClass} title="süre bitince">
          <option value="hide">süre bitince gizle</option>
          <option value="keep">süre bitince göster</option>
        </select>
      </div>

      <Input
        name="keyFormat"
        aria-label="Key format regex"
        placeholder="key_format regex (opsiyonel, ör. ^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$)"
        className="font-mono text-xs"
      />

      <Button type="submit">Oluştur</Button>
    </form>
  );
}
