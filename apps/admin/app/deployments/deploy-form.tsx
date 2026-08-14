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
 *
 * `busy` (denetim bulgusu U6): dağıtım ve yedek AYNI kuyruğu paylaşır — aynı anda tek iş
 * çalışır. Kardeş form (`backup-form.tsx`) aktif iş varken düğmelerini kapatıp gerekçesini
 * yazıyordu; bu form `busy`yi hiç almadığı için düğme tıklanabiliyor ve istek 409 hata
 * kutusuyla geri dönüyordu. Aynı kısıt, aynı davranış: baştan kapat + nedenini söyle.
 */
export function DeployForm({ busy = false }: { busy?: boolean }) {
  const [state, action, pending] = useActionState(requestDeploy, initial);
  const disabled = pending || busy;
  return (
    <form action={action} className="space-y-4">
      <Field
        label="Ne dağıtılsın?"
        htmlFor="target"
        hint="Kod değişikliği hangi uygulamadaysa onu seçin. Emin değilseniz 'API + Admin'."
      >
        <select
          id="target"
          name="target"
          defaultValue="api admin"
          disabled={disabled}
          className={`${selectClass} w-full`}
        >
          <option value="api admin">API + Admin (ikisi birden)</option>
          <option value="api">Yalnız API</option>
          <option value="admin">Yalnız Admin</option>
        </select>
      </Field>
      {busy && (
        <p className="text-xs text-muted-foreground">
          Kuyrukta bekleyen/çalışan bir iş var — aynı anda yalnız tek iş çalışır (yedek dahil).
        </p>
      )}
      {state.message && (
        <Alert variant={state.ok ? 'success' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={disabled}>
        <CloudUpload />
        {pending ? 'İstek kaydediliyor…' : "Prod'a dağıt"}
      </Button>
    </form>
  );
}
