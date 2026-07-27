'use client';
import { useActionState } from 'react';
import { CloudUpload } from 'lucide-react';
import { requestDeploy, type DeployState } from './actions';
import { Field } from '../../components/ui/field';
import { selectClass } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';

const initial: DeployState = { ok: false, message: '' };

/**
 * "Prod'a dağıt" formu — hedef seç + isteği kaydet. Buton yalnız kayıt yapar; gerçek
 * dağıtımı host runner çalıştırır. Sonuç durumu sayfadaki geçmiş tablosunda görünür.
 */
export function DeployForm() {
  const [state, action, pending] = useActionState(requestDeploy, initial);
  return (
    <form action={action} className="space-y-4">
      <Field
        label="Ne dağıtılsın?"
        htmlFor="target"
        hint="Kod değişikliği hangi uygulamadaysa onu seçin. Emin değilseniz 'API + Admin'."
      >
        <select id="target" name="target" defaultValue="api admin" className={`${selectClass} w-full`}>
          <option value="api admin">API + Admin (ikisi birden)</option>
          <option value="api">Yalnız API</option>
          <option value="admin">Yalnız Admin</option>
        </select>
      </Field>
      {state.message && (
        <Alert variant={state.ok ? 'success' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        <CloudUpload />
        {pending ? 'İstek kaydediliyor…' : "Prod'a dağıt"}
      </Button>
    </form>
  );
}
