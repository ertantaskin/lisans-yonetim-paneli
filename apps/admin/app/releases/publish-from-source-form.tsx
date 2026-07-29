'use client';
import { useActionState } from 'react';
import { Rocket } from 'lucide-react';
import { requestPluginRelease, type PublishState } from './actions';
import { Field } from '../../components/ui/field';
import { Textarea } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';

const initial: PublishState = { ok: false, message: '' };

/**
 * "Kaynaktan yayınla" formu — dosya yüklemeden, tek tuşla eklenti sürümü yayınlar.
 * Sürüm alanı YOKTUR: yayınlanan sürüm depodaki eklenti kaynağının sürümüdür (bkz. actions.ts).
 */
export function PublishFromSourceForm() {
  const [state, action, pending] = useActionState(requestPluginRelease, initial);
  return (
    <form action={action} className="space-y-4">
      <Field
        label="Değişiklik notu"
        htmlFor="note"
        hint="Bu sürümde ne değiştiğini müşteri sitelerinin güncelleme ekranında gösterir (opsiyonel)."
      >
        <Textarea
          id="note"
          name="note"
          rows={3}
          placeholder="Sipariş iletimi hızlandırıldı, klon koruması güncellemede de kuruluyor…"
        />
      </Field>
      {state.message && (
        <Alert variant={state.ok ? 'success' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        <Rocket />
        {pending ? 'İstek kaydediliyor…' : 'Kaynaktan yayınla'}
      </Button>
    </form>
  );
}
