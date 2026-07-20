'use client';
import { useActionState, useEffect } from 'react';
import {
  createSupplierAction,
  updateSupplierAction,
  initialSupplierFormState,
  type SupplierFormState,
} from '@/app/suppliers/actions';
import type { SupplierRow } from '@/app/suppliers/queries';
import { Input, Textarea, Label } from './ui/input';
import { Button } from './ui/button';

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
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sup-name">Ad</Label>
          <Input
            id="sup-name"
            name="name"
            defaultValue={supplier?.name ?? ''}
            placeholder="Tedarikçi adı"
            required
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sup-contact">İletişim (ops.)</Label>
          <Input
            id="sup-contact"
            name="contact"
            defaultValue={supplier?.contact ?? ''}
            placeholder="e-posta / telefon"
            className="w-56"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="sup-notes">Not (ops.)</Label>
        <Textarea
          id="sup-notes"
          name="notes"
          defaultValue={supplier?.notes ?? ''}
          placeholder="Serbest not"
          rows={2}
          className="max-w-lg"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : editing ? 'Kaydet' : 'Tedarikçi Ekle'}
        </Button>
        {editing && onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>
            Vazgeç
          </Button>
        )}
      </div>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
