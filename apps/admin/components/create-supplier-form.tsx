'use client';
import { useActionState, useEffect } from 'react';
import { Save, Plus, X } from 'lucide-react';
import {
  createSupplierAction,
  updateSupplierAction,
  type SupplierFormState,
} from '@/app/suppliers/actions';
import type { SupplierRow } from '@/app/suppliers/queries';
import { Input, Textarea } from './ui/input';
import { Field, FieldRow } from './ui/field';
import { Button } from './ui/button';

/**
 * useActionState başlangıç durumu — 'use server' dosyasından obje export EDİLEMEZ
 * (Next 15 SWC "can only export async functions, found object" ile action chunk'ını
 * patlatır), bu yüzden tüketici istemci bileşeninde yerel sabit olarak durur.
 */
const initialSupplierFormState: SupplierFormState = { ok: false };

/**
 * Tedarikçi formu (§12) — çift modlu:
 * - supplier verilmezse → oluştur (createSupplierAction)
 * - supplier verilirse → düzenle (updateSupplierAction, gizli id ile)
 * Başarıda onDone çağrılır (düzenleme panelini kapatmak için).
 */
export function CreateSupplierForm({
  supplier,
  onDone,
  onCancel,
}: {
  supplier?: SupplierRow;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(supplier);
  const action = editing ? updateSupplierAction : createSupplierAction;
  const [state, formAction, pending] = useActionState<SupplierFormState, FormData>(
    action,
    initialSupplierFormState,
  );

  useEffect(() => {
    if (state.ok) onDone?.();
  }, [state.ok, onDone]);

  return (
    <form action={formAction} className="space-y-3">
      {editing && <input type="hidden" name="id" value={supplier!.id} />}
      <FieldRow className="max-w-lg">
        <Field
          label="Ad"
          htmlFor="sup-name"
          required
          hint="Partilerde, satın alma emirlerinde ve maliyet raporunda bu ad görünür."
        >
          <Input
            id="sup-name"
            name="name"
            defaultValue={supplier?.name ?? ''}
            placeholder="ör. Acme Yazılım"
            required
          />
        </Field>
        <Field
          label="İletişim (opsiyonel)"
          htmlFor="sup-contact"
          hint="Sorun/değişim durumunda kime ulaşacağınız."
        >
          <Input
            id="sup-contact"
            name="contact"
            defaultValue={supplier?.contact ?? ''}
            placeholder="e-posta / telefon"
          />
        </Field>
      </FieldRow>
      <Field
        label="Not (opsiyonel)"
        htmlFor="sup-notes"
        hint="Serbest not — ödeme koşulu, teslim süresi, sözleşme numarası…"
        className="max-w-lg"
      >
        <Textarea
          id="sup-notes"
          name="notes"
          defaultValue={supplier?.notes ?? ''}
          placeholder="Serbest not"
          rows={2}
        />
      </Field>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {editing ? <Save /> : <Plus />}
          {pending ? 'Kaydediliyor…' : editing ? 'Kaydet' : 'Tedarikçi Ekle'}
        </Button>
        {editing && onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            <X /> Vazgeç
          </Button>
        )}
      </div>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
