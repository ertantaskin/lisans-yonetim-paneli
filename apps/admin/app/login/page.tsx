import { redirect } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import { authEnabled } from '../../lib/auth';
import { LoginForm } from '../../components/login-form';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; error?: string }>;
}) {
  // Gate kapalıysa login gereksiz.
  if (!authEnabled()) redirect('/');
  const { from, error } = await searchParams;

  return (
    <div className="flex min-h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
            <KeyRound className="size-5" />
          </span>
          <h1 className="text-lg font-semibold text-foreground">Lisans Paneli</h1>
          <p className="text-sm text-muted-foreground">Devam etmek için parolanızı girin</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <LoginForm from={from ?? '/pending'} error={error === '1' ? 'bad' : error === 'api' ? 'api' : undefined} />
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">Tedarik &amp; Yönetim</p>
      </div>
    </div>
  );
}
