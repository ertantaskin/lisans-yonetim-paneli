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
      {/*
        İPUCU GERÇEĞE UYDURULDU: eskiden "Mevcut sürümden büyük olmalı" yazıyordu ama HİÇBİR
        yerde karşılaştırma yoktu (API yalnız SemVer BİÇİMİNE bakar, aynı sürümü de sessizce
        üzerine yazar). Sitelere sunulan paket EN YÜKSEK semver'dir → düşük sürüm 201 döner ama
        hiçbir siteye ulaşmaz. Kural artık gerçekten uygulanıyor (actions.ts sürüm kapısı) ve
        aşmak bilinçli bir onay gerektiriyor.
      */}
      <Field
        label="Sürüm"
        htmlFor="version"
        hint="SemVer — ör. 0.2.0. Siteler daima EN YÜKSEK sürümü çeker; daha düşük ya da mevcut bir sürüm onay ister."
      >
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
        <Alert variant={state.ok ? 'success' : state.needsConfirm ? 'warning' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {/* Onay kutusu YALNIZ kapıya takıldıktan sonra çıkar (bkz. PublishState.needsConfirm). */}
      {state.needsConfirm && (
        <label
          htmlFor="allowNotLatest"
          className="flex items-start gap-2 text-sm text-muted-foreground"
        >
          <input
            id="allowNotLatest"
            name="allowNotLatest"
            type="checkbox"
            value="on"
            className="mt-0.5 size-4 rounded border-input accent-primary"
          />
          <span>
            Yine de yayınla — sonucun ne olacağını (paketin sitelere sunulmaması ya da mevcut
            sürümün üzerine yazılması) anlıyorum.
          </span>
        </label>
      )}
      <Button type="submit" disabled={pending}>
        <UploadCloud />
        {pending ? 'Yayınlanıyor…' : 'Yeni sürüm yayınla'}
      </Button>
    </form>
  );
}
