'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { CheckCircle2, CircleCheck, CircleX, Plug, TriangleAlert } from 'lucide-react';
import {
  testConnectionAction,
  updateSiteAction,
  type TestConnectionState,
  type UpdateSiteState,
} from '../actions';
import { Input, Label } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';

const initial: UpdateSiteState = { ok: false };

/**
 * Site 'Yapılandırma' düzenleme formu (§5/§14): günlük satış kotası + sandbox + gönderen
 * e-posta. updateSiteAction → PATCH /v1/admin/sites/:id (audit'e düşer). Yalnız bu üç alan
 * düzenlenir; status (askıya al/aktifleştir) ayrı aksiyondadır. SIR gösterilmez.
 */
export function SiteConfigForm({
  siteId,
  salesDailyQuota,
  sandbox,
  senderEmail,
  webhookUrl,
}: {
  siteId: string;
  salesDailyQuota: number | null;
  sandbox: boolean;
  senderEmail: string | null;
  webhookUrl: string | null;
}) {
  const [state, action, pending] = useActionState(updateSiteAction, initial);

  // Bağlantı sağlık testi (onboarding): plain-arg action → useTransition + local state
  // (site-status-toggle deseniyle aynı). Sonuç check-check inline gösterilir; SIR yok.
  const [testing, startTest] = React.useTransition();
  const [test, setTest] = React.useState<TestConnectionState | null>(null);
  const runTest = () => {
    setTest(null);
    startTest(async () => {
      setTest(await testConnectionAction(siteId));
    });
  };

  return (
    <div className="space-y-4">
      <form action={action} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="siteId" value={siteId} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sc-sender">Gönderen e-posta</Label>
          <Input
            id="sc-sender"
            name="senderEmail"
            type="email"
            defaultValue={senderEmail ?? ''}
            placeholder="varsayılan gönderen"
            className="w-56"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sc-webhook">Geri kanal webhook URL</Label>
          <Input
            id="sc-webhook"
            name="webhookUrl"
            type="url"
            defaultValue={webhookUrl ?? ''}
            placeholder="webhook devre dışı"
            className="w-72"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sc-quota">Günlük satış kotası</Label>
          <Input
            id="sc-quota"
            name="salesDailyQuota"
            type="number"
            min={1}
            step={1}
            defaultValue={salesDailyQuota ?? ''}
            placeholder="limitsiz"
            className="w-40"
          />
        </div>
        <label
          htmlFor="sc-sandbox"
          className="flex h-9 items-center gap-2 text-sm text-foreground/80"
        >
          <input
            id="sc-sandbox"
            name="sandbox"
            type="checkbox"
            defaultChecked={sandbox}
            className="size-4 rounded border-border accent-primary"
          />
          Sandbox (test modu)
        </label>
        <Button type="submit" disabled={pending}>
          {pending ? 'Kaydediliyor…' : 'Kaydet'}
        </Button>
      </form>

      {state.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Kaydedilemedi</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </div>
        </Alert>
      )}

      {state.ok && state.saved && (
        <Alert variant="success">
          <CheckCircle2 />
          <div className="min-w-0 flex-1">
            <AlertTitle>Yapılandırma kaydedildi</AlertTitle>
          </div>
        </Alert>
      )}

      {/* Bağlantı sağlık testi (onboarding): site kaydı + durum + HMAC secret + (varsa)
          webhook erişilebilirliği. Sonuç check-check yeşil/kırmızı satır olarak inline. */}
      <div className="border-t border-border pt-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" onClick={runTest} disabled={testing}>
            <Plug />
            {testing ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}
          </Button>
          <p className="text-xs text-muted-foreground">
            Site kaydı, HMAC secret ve (varsa) webhook erişilebilirliğini doğrular.
          </p>
        </div>

        {test?.error && (
          <p className="mt-3 flex items-center gap-1.5 text-sm text-destructive">
            <TriangleAlert className="size-4" /> {test.error}
          </p>
        )}

        {test?.tested && test.checks && (
          <div className="mt-3 space-y-1.5">
            <p className="text-sm font-medium text-foreground">
              {test.healthy ? 'Bağlantı sağlıklı' : 'Bağlantıda sorun var'}
            </p>
            <ul className="space-y-1">
              {test.checks.map((c) => (
                <li key={c.name} className="flex items-start gap-2 text-sm">
                  {c.ok ? (
                    <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
                  ) : (
                    <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
                  )}
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">{c.name}</span>
                    <span className="text-muted-foreground"> — {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
