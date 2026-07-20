'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Send, Trash2, TriangleAlert } from 'lucide-react';
import type { ProductRow, SiteRow } from '../../lib/api';
import type { TemplateRow } from './queries';
import {
  createTemplateAction,
  deleteTemplateAction,
  testTemplateAction,
  updateTemplateAction,
  type TemplateFormState,
} from './actions';
import { Input, Label, Textarea, selectClass } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';

/** Önizleme için örnek değişkenler — API SAMPLE_VARS ile aynı (§6). */
const SAMPLE_VARS: Record<string, string> = {
  order_no: '10042',
  site_name: 'jetlisans.com',
  product_name: 'Windows 11 Pro',
  units: '1',
  customer_email: 'musteri@ornek.com',
  items: '• Windows 11 Pro: XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
};

const TOKENS = Object.keys(SAMPLE_VARS);

/** {{degisken}} token değişimi — API renderTemplate ile birebir. */
function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

const initial: TemplateFormState = { ok: false };

export function TemplateEditor({
  template,
  products,
  sites,
}: {
  template: TemplateRow | null;
  products: ProductRow[];
  sites: SiteRow[];
}) {
  const isEdit = template !== null;
  const router = useRouter();

  const saveAction = isEdit
    ? updateTemplateAction.bind(null, template.id)
    : createTemplateAction;
  const [state, action, pending] = useActionState(saveAction, initial);

  // Canlı önizleme için kontrollü alanlar.
  const [subject, setSubject] = React.useState(template?.subject ?? 'Siparişiniz hazır — {{order_no}}');
  const [body, setBody] = React.useState(
    template?.body ??
      'Merhaba,\n\n{{order_no}} numaralı siparişinizin teslimatı aşağıdadır:\n\n{{items}}\n\nİyi günler,\n{{site_name}}',
  );

  return (
    <div className="grid gap-5 lg:grid-cols-2">
      {/* Sol: editör */}
      <Card className="p-5">
        <form action={action} className="space-y-4 text-sm">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="te-subject">Konu</Label>
            <Input
              id="te-subject"
              name="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Siparişiniz hazır — {{order_no}}"
              required
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="te-body">Gövde</Label>
            <Textarea
              id="te-body"
              name="body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={12}
              className="font-mono text-xs"
              required
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="te-product">Ürün (ops.)</Label>
              <select
                id="te-product"
                name="productId"
                defaultValue={template?.productId ?? ''}
                className={selectClass}
              >
                <option value="">— tüm ürünler —</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.sku})
                  </option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="te-site">Site (ops.)</Label>
              <select
                id="te-site"
                name="siteId"
                defaultValue={template?.siteId ?? ''}
                className={selectClass}
              >
                <option value="">— tüm siteler —</option>
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.domain}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <p className="text-xs text-muted-foreground">
            Öncelik: site override &gt; ürün şablonu &gt; genel varsayılan. Kullanılabilir
            değişkenler:{' '}
            {TOKENS.map((t) => (
              <code
                key={t}
                className="mr-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-foreground/80"
              >{`{{${t}}}`}</code>
            ))}
          </p>

          {state.error && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          {state.ok && isEdit && (
            <Alert variant="success">
              <CheckCircle2 />
              <AlertDescription>Şablon kaydedildi.</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending}>
              {pending ? 'Kaydediliyor…' : isEdit ? 'Kaydet' : 'Oluştur'}
            </Button>
            <Button asChild variant="outline" type="button">
              <Link href="/templates">İptal</Link>
            </Button>
            {isEdit && <DeleteButton id={template.id} onDeleted={() => router.push('/templates')} />}
          </div>
        </form>
      </Card>

      {/* Sağ: canlı önizleme + test-mail */}
      <div className="space-y-4">
        <Card className="p-5">
          <div className="mb-2 text-xs font-medium text-muted-foreground">
            Önizleme (örnek değişkenlerle)
          </div>
          <div className="rounded-md border border-border bg-muted/30 p-4">
            <div className="mb-3 border-b border-border pb-2">
              <div className="text-[11px] text-muted-foreground">Konu</div>
              <div className="font-medium text-foreground">{render(subject, SAMPLE_VARS)}</div>
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-foreground/90">
              {render(body, SAMPLE_VARS)}
            </pre>
          </div>
        </Card>

        {isEdit ? (
          <TestMailPanel id={template.id} />
        ) : (
          <Card className="p-5">
            <p className="text-xs text-muted-foreground">
              Test maili göndermek için önce şablonu oluşturun.
            </p>
          </Card>
        )}
      </div>
    </div>
  );
}

function DeleteButton({ id, onDeleted }: { id: string; onDeleted: () => void }) {
  const [pending, startTransition] = React.useTransition();
  const del = () => {
    if (!window.confirm('Bu şablon silinsin mi? Bu işlem geri alınamaz.')) return;
    startTransition(async () => {
      const res = await deleteTemplateAction(id);
      if (res.ok) onDeleted();
      else window.alert(res.error ?? 'Silinemedi');
    });
  };
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={del}
      disabled={pending}
      className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="size-4" />
      {pending ? 'Siliniyor…' : 'Sil'}
    </Button>
  );
}

function TestMailPanel({ id }: { id: string }) {
  const [email, setEmail] = React.useState('');
  const [pending, startTransition] = React.useTransition();
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);

  const send = () => {
    setResult(null);
    startTransition(async () => {
      const res = await testTemplateAction(id, email);
      if (res.ok) setResult({ ok: true, message: `Test maili ${email} adresine gönderildi.` });
      else setResult({ ok: false, message: res.error ?? 'Gönderim başarısız' });
    });
  };

  return (
    <Card className="p-5">
      <div className="mb-2 text-sm font-semibold text-foreground">Test maili gönder</div>
      <p className="mb-3 text-xs text-muted-foreground">
        Şablon örnek değişkenlerle render edilip verilen adrese gönderilir (gerçek müşteri
        verisi kullanılmaz).
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex flex-1 flex-col gap-1.5">
          <Label htmlFor="te-testmail">Alıcı e-posta</Label>
          <Input
            id="te-testmail"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="ben@ornek.com"
          />
        </div>
        <Button type="button" onClick={send} disabled={pending || !email.trim()}>
          <Send className="size-4" />
          {pending ? 'Gönderiliyor…' : 'Gönder'}
        </Button>
      </div>
      {result && (
        <Alert variant={result.ok ? 'success' : 'destructive'} className="mt-3">
          {result.ok ? <CheckCircle2 /> : <TriangleAlert />}
          <AlertDescription>{result.message}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}
