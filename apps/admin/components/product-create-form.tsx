'use client';
import { useState } from 'react';
import { createProductAction } from '../app/stock/actions';

const inputCls =
  'rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring';

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
    kind === 'account'
      ? JSON.stringify(fields.filter((f) => f.key.trim() && f.label.trim()))
      : '';

  return (
    <form action={createProductAction} className="space-y-3 text-sm">
      <input name="sku" placeholder="SKU (win11-pro)" required className={`w-full ${inputCls}`} />
      <input name="name" placeholder="Ürün adı" required className={`w-full ${inputCls}`} />

      <div className="flex flex-wrap gap-2">
        <select
          name="kind"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          className={inputCls}
        >
          <option value="key">key (lisans anahtarı)</option>
          <option value="account">account (hesap)</option>
          <option value="code">code (kod/hediye çeki)</option>
          <option value="custom">custom</option>
        </select>
        <select
          name="usageMode"
          value={usageMode}
          onChange={(e) => setUsageMode(e.target.value)}
          className={inputCls}
        >
          <option value="single">tek kullanımlık</option>
          <option value="multi">çok kullanımlık (MAK)</option>
        </select>
        <select name="fulfillmentPolicy" className={inputCls}>
          <option value="partial-auto">partial-auto</option>
          <option value="partial-approval">partial-approval</option>
          <option value="all-or-nothing">all-or-nothing</option>
        </select>
      </div>

      {/* multi → maxUses zorunlu */}
      {usageMode === 'multi' && (
        <input
          name="maxUses"
          type="number"
          min={2}
          placeholder="max kullanım (>1, ör. 500)"
          required
          className={`w-full ${inputCls}`}
        />
      )}

      {/* account → payloadSchema editörü */}
      {kind === 'account' && (
        <div className="rounded-md border border-border bg-background/50 p-3">
          <div className="mb-2 text-xs font-medium text-foreground/60">Hesap alanları (payloadSchema)</div>
          <input type="hidden" name="payloadSchema" value={schemaJson} />
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  value={f.key}
                  onChange={(e) => setField(i, { key: e.target.value })}
                  placeholder="anahtar (username)"
                  className={`${inputCls} w-36`}
                />
                <input
                  value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  placeholder="etiket (Kullanıcı adı)"
                  className={`${inputCls} w-44`}
                />
                <label className="flex items-center gap-1 text-xs text-foreground/60">
                  <input
                    type="checkbox"
                    checked={f.secret}
                    onChange={(e) => setField(i, { secret: e.target.checked })}
                  />
                  gizli
                </label>
                <button
                  type="button"
                  onClick={() => removeField(i)}
                  className="text-xs text-destructive hover:underline"
                >
                  sil
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addField}
            className="mt-2 text-xs text-primary hover:underline"
          >
            + alan ekle
          </button>
        </div>
      )}

      {/* süreli (validityDays) + onExpiry */}
      <div className="flex flex-wrap gap-2">
        <input
          name="validityDays"
          type="number"
          min={1}
          placeholder="geçerlilik (gün, süreli hesap)"
          className={`${inputCls} w-52`}
        />
        <select name="onExpiry" className={inputCls} title="süre bitince">
          <option value="hide">süre bitince gizle</option>
          <option value="keep">süre bitince göster</option>
        </select>
      </div>

      <input
        name="keyFormat"
        placeholder="key_format regex (opsiyonel, ör. ^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$)"
        className={`w-full font-mono text-xs ${inputCls}`}
      />

      <button
        type="submit"
        className="rounded-md bg-primary px-4 py-1.5 font-medium text-primary-foreground hover:opacity-90"
      >
        Oluştur
      </button>
    </form>
  );
}
