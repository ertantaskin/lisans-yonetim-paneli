import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { KeyRound, ShieldCheck } from 'lucide-react';
import { authEnabled } from '../../lib/auth';
import { LoginForm } from '../../components/login-form';
import { TotpForm } from './totp-form';
import { PENDING_COOKIE, verifyPendingToken } from './pending';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string; step?: string }>;
}) {
  // Gate kapalıysa login gereksiz.
  if (!authEnabled()) redirect('/');
  const { from, error, step } = await searchParams;

  // İKİNCİ ADIM yalnız GEÇERLİ bir beklet-çerezi varsa gösterilir: aksi hâlde adres çubuğuna
  // `?step=totp` yazan biri "kod ekranı" görüp orada takılırdı. Çerez yoksa/süresi dolmuşsa
  // birinci adıma düşülür ve sebebi söylenir.
  const pending = step === 'totp' ? verifyPendingToken((await cookies()).get(PENDING_COOKIE)?.value) : null;
  const totpStep = step === 'totp' && pending !== null;
  const expired = step === 'totp' && pending === null;

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            {totpStep ? <ShieldCheck className="size-5" /> : <KeyRound className="size-5" />}
          </span>
          <h1 className="text-lg font-semibold text-foreground">Lisans Paneli</h1>
          <p className="text-sm text-muted-foreground">
            {totpStep
              ? 'İki faktörlü doğrulama — uygulamanızdaki kodu girin'
              : 'Devam etmek için parolanızı girin'}
          </p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-xs">
          {totpStep ? (
            <TotpForm
              from={from ?? '/pending'}
              error={error === 'totp' ? 'code' : error === 'api' ? 'api' : undefined}
            />
          ) : (
            <>
              {/* Süresi geçmiş beklet-çerezi "parola hatalı" DEĞİLDİR — kendi mesajını alır
                  (yanlış mesaj operatörü parolasını değiştirmeye iterdi). */}
              {expired && (
                <p role="alert" className="mb-4 text-sm text-destructive">
                  Doğrulama süresi doldu. Lütfen baştan giriş yapın.
                </p>
              )}
              <LoginForm
                from={from ?? '/pending'}
                error={error === '1' ? 'bad' : error === 'api' ? 'api' : undefined}
              />
            </>
          )}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">Tedarik &amp; Yönetim</p>
      </div>
    </div>
  );
}
