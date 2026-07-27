'use client';
import { useActionState } from 'react';
import { Plus, TriangleAlert } from 'lucide-react';
import { createSiteAction, type CreateSiteState } from '../app/sites/actions';
import { Input } from './ui/input';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Field, FieldRow } from './ui/field';

const initial: CreateSiteState = { ok: false };

export function CreateSiteForm() {
  const [state, action, pending] = useActionState(createSiteAction, initial);

  return (
    <div>
      <form action={action} className="space-y-4">
        <Field
          label="Domain"
          htmlFor="cs-domain"
          required
          hint="Bağlanacak satış kanalının (mağaza / pazar yeri) alan adı."
        >
          <Input id="cs-domain" name="domain" placeholder="magazam.com" required className="max-w-sm" />
        </Field>

        <FieldRow>
          <Field
            label="Gönderen e-posta (opsiyonel)"
            htmlFor="cs-sender"
            hint="Teslimat maillerinde görünecek gönderen adresi. Boş = panel varsayılanı."
          >
            <Input
              id="cs-sender"
              name="senderEmail"
              type="email"
              placeholder="satis@magazam.com"
            />
          </Field>
          <Field
            label="Günlük satış kotası (opsiyonel)"
            htmlFor="cs-quota"
            hint="Bir günde bu siteye izin verilen en fazla satış. Boş = limitsiz."
          >
            <Input
              id="cs-quota"
              name="salesDailyQuota"
              type="number"
              min={1}
              step={1}
              placeholder="limitsiz"
            />
          </Field>
        </FieldRow>

        <Field
          label="Sandbox (test modu)"
          htmlFor="cs-sandbox"
          hint="Açıkken teslimat mailleri gerçek müşteriye gitmez; entegrasyon denemesi için."
        >
          <label htmlFor="cs-sandbox" className="flex items-center gap-2 text-sm text-foreground/80">
            <input
              id="cs-sandbox"
              name="sandbox"
              type="checkbox"
              className="size-4 rounded border-border accent-primary"
            />
            Test modunu etkinleştir
          </label>
        </Field>

        <Button type="submit" disabled={pending}>
          <Plus /> {pending ? 'Oluşturuluyor…' : 'Site Oluştur'}
        </Button>
      </form>

      {state.error && <p className="mt-3 text-sm text-destructive">{state.error}</p>}

      {state.ok && state.site && (
        <Alert variant="warning" className="mt-4">
          <TriangleAlert />
          <div className="min-w-0">
            <AlertTitle>Bu bilgiler yalnız bir kez gösterilir — güvenli saklayın</AlertTitle>
            <AlertDescription>
              <div className="space-y-1 font-mono text-xs text-foreground">
                <div className="break-all">
                  <span className="text-foreground/70">API Key:</span> {state.site.apiKey}
                </div>
                <div className="break-all">
                  <span className="text-foreground/70">HMAC Secret:</span> {state.site.hmacSecret}
                </div>
              </div>
            </AlertDescription>
          </div>
        </Alert>
      )}
    </div>
  );
}
