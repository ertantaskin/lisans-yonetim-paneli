'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { CheckCircle2, Send, Trash2, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { ProductRow, SiteRow } from '../../lib/api';
import type { TemplateRow } from './queries';
import {
  createTemplateAction,
  deleteTemplateAction,
  testTemplateAction,
  updateTemplateAction,
  type TemplateFormState,
} from './actions';
import { Input, Label, Textarea } from '../../components/ui/input';
import { Button } from '../../components/ui/button';
import { useConfirm } from '../../components/ui/confirm';
import { Combobox } from '../../components/ui/combobox';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';
import { DELIVERY_TEMPLATE_SAMPLE_VARS, DELIVERY_TEMPLATE_TOKENS } from '@lisans/shared';

/**
 * Önizleme için örnek değişkenler — API ile AYNI KAYNAKTAN (`@lisans/shared`).
 *
 * ÖNCEDEN BURADA KOPYASI VARDI VE AYRIŞMIŞTI: API `valid_until` besliyor ama bu kopyada o
 * alan yoktu → `{{valid_until}}` yazan operatör "desteklenmiyor, gönderimde boş çıkar"
 * uyarısı alıyordu; oysa değişken çalışıyordu ve panelin kendi sunucu-taraflı önizlemesi
 * (templates.preview → unknownVars) onu geçerli sayıyordu. Aynı ekranda iki cevap.
 */
const SAMPLE_VARS = DELIVERY_TEMPLATE_SAMPLE_VARS;

const TOKENS = DELIVERY_TEMPLATE_TOKENS;

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

  // #18: DESTEKLENMEYEN {{degisken}} tespiti. render onları sessizce '' yapar (§6) → admin
  // {{password}} gibi tanımsız bir token yazarsa gönderimde BOŞ çıkar (sessiz veri kaybı).
  // Canlı uyarı ile fark ettirilir. Desteklenen set = TOKENS (mail.processor'ın beslediği).
  const unknownVars = React.useMemo(() => {
    const used = new Set<string>();
    for (const m of `${subject}\n${body}`.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
      if (m[1]) used.add(m[1]);
    }
    return [...used].filter((v) => !TOKENS.includes(v));
  }, [subject, body]);

  return (
    <div className="grid gap-5 [&>*]:min-w-0 lg:grid-cols-2">
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

          <div className="grid gap-3 [&>*]:min-w-0 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="te-product">Ürün (opsiyonel)</Label>
              <Combobox
                id="te-product"
                name="productId"
                ariaLabel="Ürün kapsamı"
                allowClear
                clearLabel="— tüm ürünler —"
                defaultValue={template?.productId ?? ''}
                items={products.map((p) => ({
                  value: p.id,
                  label: p.name,
                  hint: p.sku,
                  keywords: [p.sku],
                }))}
                placeholder="— tüm ürünler —"
                searchPlaceholder="Ürün adı veya SKU…"
                emptyText="Ürün bulunamadı"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="te-site">Site (opsiyonel)</Label>
              <Combobox
                id="te-site"
                name="siteId"
                ariaLabel="Site kapsamı"
                allowClear
                clearLabel="— tüm siteler —"
                defaultValue={template?.siteId ?? ''}
                items={sites.map((s) => ({ value: s.id, label: s.domain }))}
                placeholder="— tüm siteler —"
                searchPlaceholder="Site alan adı ara…"
                emptyText="Site bulunamadı"
              />
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
          {unknownVars.length > 0 && (
            /* Elle kurulmuş uyarı kutusu KALDIRILDI: `rounded-md` + `bg-warning/10` (farklı
               tint uzayı) + gövdede `text-warning` kullanıyordu; kanonik primitif oklch
               color-mix tint + `text-foreground` gövde + aksanı yalnız ikonda tutar.
               Yoğunluk (kompakt kutu) yalnız çağrı yerinde sınıfla ayarlanır — renk/yarıçap
               primitiften gelir, böylece tema değişince bu kutu geride kalmaz. */
            <Alert variant="warning" className="mt-3 gap-2 p-3">
              <TriangleAlert />
              <AlertDescription className="text-xs">
                Desteklenmeyen değişken: {unknownVars.map((v) => `{{${v}}}`).join(', ')} — gönderimde{' '}
                <strong>boş</strong> çıkar. Desteklenenler: {TOKENS.map((t) => `{{${t}}}`).join(', ')}.
              </AlertDescription>
            </Alert>
          )}
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
  const { confirm, dialog } = useConfirm();
  const del = async () => {
    const ok = await confirm({
      title: 'Bu şablon silinsin mi?',
      description:
        'Şablon kalıcı olarak silinir. Bu kapsamdaki (site/ürün) mailler bir üst kapsamın şablonuyla gönderilmeye başlar.',
      tone: 'danger',
      confirmLabel: 'Sil',
    });
    if (!ok) return;
    startTransition(async () => {
      const res = await deleteTemplateAction(id);
      // Hata artık tarayıcının alert kutusunda değil, panelin toast'ında görünür.
      if (res.ok) onDeleted();
      else toast.error(res.error ?? 'Silinemedi');
    });
  };
  return (
    <>
    {dialog}
    <Button
      type="button"
      variant="ghost"
      onClick={() => void del()}
      disabled={pending}
      className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
    >
      <Trash2 className="size-4" />
      {pending ? 'Siliniyor…' : 'Sil'}
    </Button>
    </>
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
