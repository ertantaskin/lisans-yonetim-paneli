import { LogIn } from 'lucide-react';
import { Input, Label } from './ui/input';
import { Button } from './ui/button';

/** Login formu — native POST /api/login (kimlik = kullanıcı adı veya e-posta). */
export function LoginForm({ from, error }: { from: string; error?: 'bad' | 'api' }) {
  return (
    <form method="post" action="/api/login" className="space-y-4">
      <input type="hidden" name="from" value={from} />
      <div className="space-y-1.5">
        <Label htmlFor="identifier">Kullanıcı adı veya e-posta</Label>
        <Input
          id="identifier"
          name="identifier"
          type="text"
          autoFocus
          required
          autoComplete="username"
          placeholder="admin@ornek.com"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Parola</Label>
        <Input
          id="password"
          name="password"
          type="password"
          required
          autoComplete="current-password"
          placeholder="••••••••"
        />
      </div>
      {(error === 'bad' || error === 'api') && (
        <p role="alert" className="text-sm text-destructive">
          {error === 'bad' ? 'Kullanıcı adı/parola hatalı.' : 'Sunucuya ulaşılamadı, tekrar deneyin.'}
        </p>
      )}
      <Button type="submit" className="w-full">
        <LogIn /> Giriş Yap
      </Button>
    </form>
  );
}
