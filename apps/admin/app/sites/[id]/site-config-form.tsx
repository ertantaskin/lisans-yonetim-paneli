'use client';
import { useActionState } from 'react';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { updateSiteAction, type UpdateSiteState } from '../actions';
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
    </div>
  );
}
