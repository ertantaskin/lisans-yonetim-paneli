import { LogIn } from 'lucide-react';
import { Input, Label } from './ui/input';
import { Button } from './ui/button';

/** Login formu — native POST /api/login (server-component; RSC action quirk'i yok). */
export function LoginForm({ from, error }: { from: string; error?: boolean }) {
  return (
    <form method="post" action="/api/login" className="space-y-4">
      <input type="hidden" name="from" value={from} />
      <div className="space-y-1.5">
        <Label htmlFor="password">Parola</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoFocus
          required
          autoComplete="current-password"
          placeholder="••••••••"
        />
      </div>
      {error && <p className="text-sm text-destructive">Hatalı parola.</p>}
      <Button type="submit" className="w-full">
        <LogIn /> Giriş Yap
      </Button>
    </form>
  );
}
