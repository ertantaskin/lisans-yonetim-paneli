'use client';
import { useActionState } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { updateCustomerAction, type UpdateCustomerState } from './actions';
import { Input, Label, Textarea } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';

const initial: UpdateCustomerState = { ok: false };

/** Müşteri etiket/not düzenleme — virgülle ayrık etiketler + serbest not. */
export function CustomerEditForm({
  email,
  tags,
  notes,
}: {
  email: string;
  tags: string[];
  notes: string | null;
}) {
  const [state, action, pending] = useActionState(updateCustomerAction, initial);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="email" value={email} />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cust-tags">Etiketler (virgülle ayır)</Label>
        <Input
          id="cust-tags"
          name="tags"
          defaultValue={tags.join(', ')}
          placeholder="vip, riskli, toptan"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="cust-notes">Not</Label>
        <Textarea
          id="cust-notes"
          name="notes"
          defaultValue={notes ?? ''}
          rows={4}
          placeholder="Müşteriye dair dahili not…"
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
        {state.saved && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success">
            <CheckCircle2 className="size-3.5" /> Kaydedildi
          </span>
        )}
        {state.error && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-destructive">
            <TriangleAlert className="size-3.5" /> {state.error}
          </span>
        )}
      </div>
    </form>
  );
}
