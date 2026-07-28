'use client';
import { useActionState } from 'react';
import { UploadCloud } from 'lucide-react';
import { publishRelease, type PublishState } from './actions';
import { MAX_ZIP_LABEL } from './zip-limit';
import { Field } from '../../components/ui/field';
import { Input, Textarea } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';

const initial: PublishState = { ok: false, message: '' };

/**
 * Yeni eklenti sürümü yayınlama formu. Zip yükle → sunucu action base64'leyip API'ye
 * gönderir. CLI alternatifi: scripts/release-plugin.sh (sürüm artır + zip + yayınla).
 */
export function PublishForm() {
  const [state, action, pending] = useActionState(publishRelease, initial);
  return (
    <form action={action} className="space-y-4">
      <Field label="Sürüm" htmlFor="version" hint="SemVer — ör. 0.2.0. Mevcut sürümden büyük olmalı.">
        <Input id="version" name="version" placeholder="0.2.0" required />
      </Field>
      <Field
        label="Değişiklik notu"
        htmlFor="changelog"
        hint="Bu sürümde ne değişti. Sürüm geçmişinde görünür (opsiyonel)."
      >
        <Textarea id="changelog" name="changelog" rows={3} placeholder="Klon guard düzeltmesi, marka güncellemesi…" />
      </Field>
      {/*
        Tavan metni ELLE YAZILMAZ: sınır `zip-limit.ts` içindeki MAX_ZIP_BYTES'tan türetilir.
        (Daha önce burada "En çok 5 MB." yazıyordu ama gerçek tavan 700 KB'a inmişti → kullanıcı
        reddedilen yüklemeyi anlayamıyordu. Artık sabit değişince bu ipucu da değişir.)
      */}
      <Field
        label="Eklenti paketi (.zip)"
        htmlFor="zip"
        hint={`scripts/release-plugin.sh ile üretilen zip önerilir; kök klasör 'wpteslimat/' olmalı. En çok ${MAX_ZIP_LABEL}.`}
      >
        <Input id="zip" type="file" name="zip" accept=".zip" required />
      </Field>
      {state.message && (
        <Alert variant={state.ok ? 'success' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" disabled={pending}>
        <UploadCloud />
        {pending ? 'Yayınlanıyor…' : 'Yeni sürüm yayınla'}
      </Button>
    </form>
  );
}
