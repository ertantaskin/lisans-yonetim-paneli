'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Check,
  CircleCheck,
  CircleX,
  Copy,
  KeyRound,
  Plug,
  TriangleAlert,
} from 'lucide-react';
import {
  createSiteAndIssueCode,
  testConnectionAction,
  type TestConnectionResult,
} from './actions';
import { Input, Label, selectClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';

interface CreatedSite {
  siteId: string;
  code: string;
  expiresAt: string;
}

const STEPS = ['Site Bilgileri', 'Bağlan Kodu', 'Bağlantı Testi'] as const;

/**
 * Adım göstergesi (§14): 1-2-3 ilerleme. Aktif/tamamlanmış adım nötr primary,
 * bekleyen adım muted. Tamamlanan adımda tik ikonu.
 */
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  return (
    <ol className="mb-6 flex flex-wrap items-center gap-2 text-sm">
      {STEPS.map((label, i) => {
        const n = (i + 1) as 1 | 2 | 3;
        const done = n < step;
        const active = n === step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span
              className={
                'flex size-6 items-center justify-center rounded-full text-xs font-semibold ' +
                (done || active
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground')
              }
            >
              {done ? <Check className="size-3.5" /> : n}
            </span>
            <span
              className={active ? 'font-medium text-foreground' : 'text-muted-foreground'}
            >
              {label}
            </span>
            {n < 3 && <span className="mx-1 text-muted-foreground/50">/</span>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Site bağlama sihirbazı (§14): 3 adımda yeni bir WooCommerce/pazar yeri sitesini panele
 * bağlar. Adım 1 site oluşturur + tek-seferlik bağlan kodu üretir; Adım 2 kodu WP eklentisine
 * girmek için gösterir; Adım 3 bağlantı sağlığını test eder. Optimistic UI yok; para/stok yok.
 */
export function Wizard() {
  const [step, setStep] = React.useState<1 | 2 | 3>(1);
  const [created, setCreated] = React.useState<CreatedSite | null>(null);

  // Adım 1 — site oluşturma
  const [creating, startCreate] = React.useTransition();
  const [createErr, setCreateErr] = React.useState<string | null>(null);

  // Adım 2 — kopyala geri bildirimi
  const [copied, setCopied] = React.useState(false);

  // Adım 3 — bağlantı testi
  const [testing, startTest] = React.useTransition();
  const [test, setTest] = React.useState<TestConnectionResult | null>(null);

  function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const domain = String(fd.get('domain') || '').trim();
    if (!domain) {
      setCreateErr('Domain zorunlu');
      return;
    }
    // Günlük satış kotası (ops.) — boş = limitsiz. Negatif/0 reddedilir.
    const quotaRaw = String(fd.get('salesDailyQuota') || '').trim();
    let salesDailyQuota: number | undefined;
    if (quotaRaw) {
      const num = Number(quotaRaw);
      if (!Number.isInteger(num) || num < 1) {
        setCreateErr('Günlük satış kotası pozitif tam sayı olmalı');
        return;
      }
      salesDailyQuota = num;
    }
    const input = {
      domain,
      type: String(fd.get('type') || 'woocommerce'),
      senderEmail: String(fd.get('senderEmail') || '').trim() || undefined,
      webhookUrl: String(fd.get('webhookUrl') || '').trim() || undefined,
      sandbox: fd.get('sandbox') != null,
      salesDailyQuota,
    };
    setCreateErr(null);
    startCreate(async () => {
      const res = await createSiteAndIssueCode(input);
      if (res.ok && res.siteId && res.code && res.expiresAt) {
        setCreated({ siteId: res.siteId, code: res.code, expiresAt: res.expiresAt });
        setStep(2);
      } else {
        setCreateErr(res.error ?? 'Site oluşturulamadı');
      }
    });
  }

  async function copyCode() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Pano erişimi yoksa sessiz geç — kod zaten ekranda görünür.
    }
  }

  function runTest() {
    if (!created) return;
    setTest(null);
    startTest(async () => {
      setTest(await testConnectionAction(created.siteId));
    });
  }

  return (
    <div>
      <Stepper step={step} />

      {/* ── Adım 1: Site bilgileri ─────────────────────────────────────────── */}
      {step === 1 && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Site bilgileri</CardTitle>
            <CardDescription>
              Bağlanacak WooCommerce/pazar yeri sitesinin temel bilgileri. Yalnız domain zorunlu.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onCreate} className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wz-domain">Domain</Label>
                <Input
                  id="wz-domain"
                  name="domain"
                  placeholder="magazam.com"
                  required
                  autoFocus
                  className="max-w-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wz-type">Kanal tipi</Label>
                <select
                  id="wz-type"
                  name="type"
                  defaultValue="woocommerce"
                  className={selectClass + ' max-w-sm'}
                >
                  <option value="woocommerce">WooCommerce</option>
                  <option value="marketplace">Pazar yeri</option>
                  <option value="reseller">Bayi</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wz-sender">Gönderen e-posta (ops.)</Label>
                <Input
                  id="wz-sender"
                  name="senderEmail"
                  type="email"
                  placeholder="satis@magazam.com"
                  className="max-w-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wz-webhook">Geri kanal webhook URL (ops.)</Label>
                <Input
                  id="wz-webhook"
                  name="webhookUrl"
                  type="url"
                  placeholder="webhook devre dışı"
                  className="max-w-sm"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="wz-quota">Günlük satış kotası (ops.)</Label>
                <Input
                  id="wz-quota"
                  name="salesDailyQuota"
                  type="number"
                  min={1}
                  step={1}
                  placeholder="limitsiz"
                  className="w-40"
                />
              </div>

              <label
                htmlFor="wz-sandbox"
                className="flex items-center gap-2 text-sm text-foreground/80"
              >
                <input
                  id="wz-sandbox"
                  name="sandbox"
                  type="checkbox"
                  className="size-4 rounded border-border accent-primary"
                />
                Sandbox (test modu) — mailler gerçek müşteriye gitmez
              </label>

              {createErr && (
                <Alert variant="destructive">
                  <TriangleAlert />
                  <div className="min-w-0 flex-1">
                    <AlertTitle>Oluşturulamadı</AlertTitle>
                    <AlertDescription>{createErr}</AlertDescription>
                  </div>
                </Alert>
              )}

              <Button type="submit" disabled={creating}>
                {creating ? 'Oluşturuluyor…' : 'Site Oluştur ve Kod Üret'}
                {!creating && <ArrowRight />}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      {/* ── Adım 2: Bağlan kodu ────────────────────────────────────────────── */}
      {step === 2 && created && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Tek-seferlik bağlan kodu</CardTitle>
            <CardDescription>
              Bu kodu WP eklentisine girerek siteyi panele bağlayın. Kod yalnız bir kez ve kısa
              süre geçerlidir.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <code className="select-all break-all font-mono text-2xl font-semibold tracking-wide text-foreground">
                  {created.code}
                </code>
                <Button type="button" variant="outline" onClick={copyCode}>
                  {copied ? <Check /> : <Copy />}
                  {copied ? 'Kopyalandı' : 'Kopyala'}
                </Button>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Son kullanma:{' '}
                <span className="font-medium text-foreground">
                  {new Date(created.expiresAt).toLocaleString('tr-TR')}
                </span>
              </p>
            </div>

            <Alert variant="info">
              <KeyRound />
              <div className="min-w-0 flex-1">
                <AlertTitle>Kodu nereye gireceğim?</AlertTitle>
                <AlertDescription>
                  WordPress yönetici panelinizde{' '}
                  <span className="font-medium text-foreground">
                    Jetlisans &rsaquo; Panele Bağlan
                  </span>{' '}
                  ekranını açın ve yukarıdaki kodu yapıştırın. Eklenti, kodu kullanarak siteyi
                  panele kalıcı olarak bağlar (HMAC secret güvenli şekilde WP tarafına aktarılır).
                </AlertDescription>
              </div>
            </Alert>

            <Button type="button" onClick={() => setStep(3)}>
              Bağlantıyı Test Et <ArrowRight />
            </Button>
          </CardContent>
        </Card>
      )}

      {/* ── Adım 3: Bağlantı testi ─────────────────────────────────────────── */}
      {step === 3 && created && (
        <Card className="max-w-2xl">
          <CardHeader>
            <CardTitle>Bağlantı testi</CardTitle>
            <CardDescription>
              Site kaydı, durum, HMAC secret ve (varsa) webhook erişilebilirliğini doğrular.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button type="button" variant="outline" onClick={runTest} disabled={testing}>
              <Plug />
              {testing ? 'Test ediliyor…' : 'Bağlantıyı Test Et'}
            </Button>

            {test?.error && (
              <Alert variant="destructive">
                <TriangleAlert />
                <div className="min-w-0 flex-1">
                  <AlertTitle>Test başarısız</AlertTitle>
                  <AlertDescription>{test.error}</AlertDescription>
                </div>
              </Alert>
            )}

            {test && !test.error && test.checks && (
              <div className="space-y-3">
                <p className="text-sm font-medium text-foreground">
                  {test.ok ? 'Bağlantı sağlıklı' : 'Bağlantıda sorun var'}
                </p>
                <ul className="space-y-1.5">
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

                {test.ok && (
                  <Alert variant="success">
                    <CircleCheck />
                    <div className="min-w-0 flex-1">
                      <AlertTitle>Site bağlandı</AlertTitle>
                      <AlertDescription>
                        <Button asChild variant="link" className="h-auto p-0">
                          <Link href={`/sites/${created.siteId}`}>Site detayına git →</Link>
                        </Button>
                      </AlertDescription>
                    </div>
                  </Alert>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
