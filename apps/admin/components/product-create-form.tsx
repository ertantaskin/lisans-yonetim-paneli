'use client';
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import type { ProductRow } from '../lib/api';
import { Input, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Field, FormSection, FieldRow } from './ui/field';

type SchemaField = { key: string; label: string; secret: boolean; required: boolean };

const DEFAULT_ACCOUNT_FIELDS: SchemaField[] = [
  { key: 'username', label: 'Kullanıcı adı', secret: false, required: true },
  { key: 'password', label: 'Parola', secret: true, required: true },
];

/**
 * Saklanan ISO tarihi → <input type="datetime-local"> için YEREL `yyyy-MM-ddTHH:mm`.
 * Input yerel saat bekler; UTC ISO'yu doğrudan basmak saati kaydırır.
 */
function toLocalDatetime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

/**
 * Ürün form alanları — create + edit ortak (§11). kind'e göre koşullu alanlar:
 * - account → payloadSchema editörü (alanlar: key/label/secret)
 * - multi → maxUses (zorunlu, >1)
 * - süreli → validityDays + onExpiry
 * - stoksuz/ön-sipariş → stockless + releaseAt
 * payloadSchema gizli input'a JSON olarak serialize edilir; server action iletir.
 * `defaults` verilirse (düzenleme) alanlar ön-dolu gelir.
 *
 * Sunum: her alan görünür Türkçe etiket + yardım metni ile `Field` içinde sarılır
 * ve anlamlı `FormSection` bloklarına gruplanır (placeholder-only / ham enum yok).
 */
export function ProductFormFields({ defaults }: { defaults?: Partial<ProductRow> }) {
  const [kind, setKind] = useState(defaults?.kind ?? 'key');
  const [usageMode, setUsageMode] = useState(defaults?.usageMode ?? 'single');
  const [fields, setFields] = useState<SchemaField[]>(
    defaults?.payloadSchema && defaults.payloadSchema.length > 0
      ? defaults.payloadSchema.map((f) => ({
          key: f.key,
          label: f.label,
          secret: f.secret,
          required: f.required ?? true,
        }))
      : DEFAULT_ACCOUNT_FIELDS,
  );

  const setField = (i: number, patch: Partial<SchemaField>) =>
    setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const addField = () =>
    setFields((fs) => [...fs, { key: '', label: '', secret: false, required: true }]);
  const removeField = (i: number) => setFields((fs) => fs.filter((_, j) => j !== i));

  const schemaJson =
    kind === 'account' ? JSON.stringify(fields.filter((f) => f.key.trim() && f.label.trim())) : '';

  return (
    <div className="space-y-6 text-sm">
      {/* 1 ── Temel bilgiler ─────────────────────────────────────────────── */}
      <FormSection title="Temel bilgiler" description="Ürünü tanımlayan temel alanlar.">
        <FieldRow>
          <Field label="SKU (stok kodu)" htmlFor="p-sku" hint="Benzersiz ürün kodu." required>
            <Input
              id="p-sku"
              name="sku"
              placeholder="ör. win11-pro"
              defaultValue={defaults?.sku}
              required
            />
          </Field>
          <Field
            label="Ürün adı"
            htmlFor="p-name"
            hint="Panelde ve teslimatta görünen ad."
            required
          >
            <Input
              id="p-name"
              name="name"
              placeholder="ör. Windows 11 Pro"
              defaultValue={defaults?.name}
              required
            />
          </Field>
        </FieldRow>

        <FieldRow>
          <Field label="Ürün tipi" htmlFor="p-kind" hint="Teslim edilen içeriğin türü.">
            <select
              id="p-kind"
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              className={`w-full ${selectClass}`}
            >
              <option value="key">Lisans anahtarı (key)</option>
              <option value="account">Hesap (kullanıcı adı/parola)</option>
              <option value="code">Kod / hediye çeki</option>
              <option value="custom">Özel</option>
            </select>
          </Field>
          <Field
            label="Kullanım modu"
            htmlFor="p-usage-mode"
            hint="Bir key'in kaç müşteriye teslim edileceği."
          >
            <select
              id="p-usage-mode"
              name="usageMode"
              value={usageMode}
              onChange={(e) => setUsageMode(e.target.value)}
              className={`w-full ${selectClass}`}
            >
              <option value="single">Tek kullanımlık (1 key = 1 müşteri)</option>
              <option value="multi">Çok kullanımlık — MAK (1 key = N teslim)</option>
            </select>
          </Field>
        </FieldRow>

        <Field
          label="Teslimat politikası"
          htmlFor="p-fulfillment-policy"
          hint="Stok siparişe yetmezse ne olsun."
        >
          <select
            id="p-fulfillment-policy"
            name="fulfillmentPolicy"
            defaultValue={defaults?.fulfillmentPolicy ?? 'partial-auto'}
            className={`w-full ${selectClass}`}
          >
            <option value="partial-auto">Kısmi — otomatik</option>
            <option value="partial-approval">Kısmi — onaylı</option>
            <option value="all-or-nothing">Ya hep ya hiç</option>
          </select>
        </Field>

        {/* multi → maxUses zorunlu */}
        {usageMode === 'multi' && (
          <Field
            label="Maksimum kullanım (kapasite)"
            htmlFor="p-max-uses"
            hint="1 key kaç müşteriye teslim edilebilir (>1)."
            required
          >
            <Input
              id="p-max-uses"
              name="maxUses"
              type="number"
              min={2}
              placeholder="ör. 500"
              defaultValue={defaults?.maxUses ?? undefined}
              required
            />
          </Field>
        )}
      </FormSection>

      {/* 2 ── Hesap alanları (yalnız kind=account) ───────────────────────── */}
      {kind === 'account' && (
        <FormSection
          boxed
          title="Hesap alanları"
          description="Müşteriye teslim edilen alanlar. 'Gizli' işaretli alanlar panelde maskelenir."
        >
          <input type="hidden" name="payloadSchema" value={schemaJson} />
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  id={`p-af-key-${i}`}
                  value={f.key}
                  onChange={(e) => setField(i, { key: e.target.value })}
                  aria-label="Alan anahtarı"
                  placeholder="anahtar (username)"
                  className="h-8 w-36"
                />
                <Input
                  id={`p-af-label-${i}`}
                  value={f.label}
                  onChange={(e) => setField(i, { label: e.target.value })}
                  aria-label="Görünen etiket"
                  placeholder="etiket (Kullanıcı adı)"
                  className="h-8 w-44"
                />
                <label
                  htmlFor={`p-af-secret-${i}`}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <input
                    id={`p-af-secret-${i}`}
                    type="checkbox"
                    checked={f.secret}
                    onChange={(e) => setField(i, { secret: e.target.checked })}
                    className="size-4 accent-primary"
                  />
                  Gizli
                </label>
                <label
                  htmlFor={`p-af-required-${i}`}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <input
                    id={`p-af-required-${i}`}
                    type="checkbox"
                    checked={f.required}
                    onChange={(e) => setField(i, { required: e.target.checked })}
                    className="size-4 accent-primary"
                  />
                  Zorunlu
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
          <p className="text-xs leading-relaxed text-muted-foreground">
            “Gizli” işaretli alanlar (ör. parola) panelde maskelenir, çıplak gösterilmez.
            “Zorunlu” işaretini kaldırmak alanı içe aktarımda opsiyonel yapar (boş bırakılabilir).
          </p>
          <Button type="button" onClick={addField} variant="ghost" size="sm" className="mt-1 h-7 px-2 text-xs">
            <Plus className="size-3.5" /> Alan ekle
          </Button>
        </FormSection>
      )}

      {/* 3 ── Süre & garanti ─────────────────────────────────────────────── */}
      <FormSection
        title="Süre & garanti"
        description="Süreli hesaplar, 'Sorun bildir' penceresi ve stok uyarısı."
      >
        <FieldRow>
          <Field
            label="Geçerlilik süresi (gün)"
            htmlFor="p-validity-days"
            hint="Süreli hesap için; teslimatla başlar. Boş = süresiz."
          >
            <Input
              id="p-validity-days"
              name="validityDays"
              type="number"
              min={1}
              placeholder="ör. 365"
              defaultValue={defaults?.validityDays ?? undefined}
            />
          </Field>
          <Field
            label="Süre bitince"
            htmlFor="p-on-expiry"
            hint="Süre dolunca müşteri erişimi."
          >
            <select
              id="p-on-expiry"
              name="onExpiry"
              defaultValue={defaults?.onExpiry ?? 'hide'}
              className={`w-full ${selectClass}`}
            >
              <option value="hide">Erişimi gizle</option>
              <option value="keep">Erişimi koru</option>
            </select>
          </Field>
        </FieldRow>

        <FieldRow>
          <Field
            label="Garanti süresi (gün)"
            htmlFor="p-warranty-days"
            hint="'Sorun bildir' penceresi. Boş = garanti yok."
          >
            <Input
              id="p-warranty-days"
              name="warrantyDays"
              type="number"
              min={0}
              placeholder="ör. 30"
              defaultValue={defaults?.warrantyDays ?? undefined}
            />
          </Field>
          <Field
            label="Düşük stok eşiği"
            htmlFor="p-low-stock"
            hint="Kalan bu değere düşünce uyarı. Boş = kapalı."
          >
            <Input
              id="p-low-stock"
              name="lowStockThreshold"
              type="number"
              min={0}
              placeholder="ör. 10"
              defaultValue={defaults?.lowStockThreshold ?? undefined}
            />
          </Field>
        </FieldRow>
      </FormSection>

      {/* 4 ── Stok & gelişmiş ────────────────────────────────────────────── */}
      <FormSection
        title="Stok & gelişmiş"
        description="Ön sipariş ve içe aktarma sırasında format doğrulaması."
      >
        <FieldRow>
          <Field
            label="Stoksuz / ön sipariş"
            htmlFor="p-stockless"
            hint="Stok olmadan satışa açık; yayın tarihinde teslim."
          >
            <div className="flex h-9 items-center gap-2">
              <input
                id="p-stockless"
                type="checkbox"
                name="stockless"
                value="on"
                defaultChecked={defaults?.stockless ?? false}
                className="size-4 accent-primary"
              />
              <span className="text-sm text-muted-foreground">Stok gelmeden satışa aç</span>
            </div>
          </Field>
          <Field
            label="Yayın tarihi"
            htmlFor="p-release-at"
            hint="Ön sipariş bu tarihte teslim edilir."
          >
            <Input
              id="p-release-at"
              name="releaseAt"
              type="datetime-local"
              defaultValue={defaults?.releaseAt ? toLocalDatetime(defaults.releaseAt) : undefined}
            />
          </Field>
        </FieldRow>

        <Field
          label="Key format doğrulaması (regex)"
          htmlFor="p-key-format"
          hint="Opsiyonel. Import sırasında formatı denetler. Ör. ^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$"
        >
          <Input
            id="p-key-format"
            name="keyFormat"
            placeholder="^[A-Z0-9]{5}(-[A-Z0-9]{5}){4}$"
            defaultValue={defaults?.keyFormat ?? undefined}
            className="font-mono text-xs"
          />
        </Field>
      </FormSection>
    </div>
  );
}
// NOT: ProductCreateForm kaldırıldı → oluşturma artık product-create-sheet.tsx (Sheet). Bu dosya
// yalnız paylaşımlı ProductFormFields'ı export eder (create-sheet + edit-sheet + [gelecek] kullanır).
