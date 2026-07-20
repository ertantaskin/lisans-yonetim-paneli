'use client';
import { useActionState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { createSiteAction, type CreateSiteState } from '../app/sites/actions';
import { Input, Label } from './ui/input';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';

const initial: CreateSiteState = { ok: false };

export function CreateSiteForm() {
  const [state, action, pending] = useActionState(createSiteAction, initial);

  return (
    <div>
      <form action={action} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cs-domain">Domain</Label>
          <Input id="cs-domain" name="domain" placeholder="magazam.com" required className="w-56" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cs-sender">Gönderen e-posta (ops.)</Label>
          <Input
            id="cs-sender"
            name="senderEmail"
            type="email"
            placeholder="satis@magazam.com"
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cs-quota">Günlük satış kotası (ops.)</Label>
          <Input
            id="cs-quota"
            name="salesDailyQuota"
            type="number"
            min={1}
            step={1}
            placeholder="limitsiz"
            className="w-40"
          />
        </div>
        <label
          htmlFor="cs-sandbox"
          className="flex h-9 items-center gap-2 text-sm text-foreground/80"
        >
          <input
            id="cs-sandbox"
            name="sandbox"
            type="checkbox"
            className="size-4 rounded border-border accent-primary"
          />
          Sandbox (test modu)
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? 'Oluşturuluyor…' : 'Site Oluştur'}
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
