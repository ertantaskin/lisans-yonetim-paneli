import { ShieldCheck } from 'lucide-react';
import { Input, Label } from '../../components/ui/input';
import { Button } from '../../components/ui/button';

/**
 * Girişin İKİNCİ ADIMI — doğrulama kodu. Birinci adımla AYNI teknikte: native form POST →
 * /api/login route handler. (Proje dersi: login/logout Server Action ile yapılamaz — redirect
 * yanıtına çerez bindirilemiyor.) Hesap kimliği formda DEĞİL, imzalı beklet-çerezindedir.
 */
export function TotpForm({ from, error }: { from: string; error?: 'code' | 'expired' | 'api' }) {
  return (
    <form method="post" action="/api/login" className="space-y-4">
      <input type="hidden" name="from" value={from} />
      <input type="hidden" name="step" value="totp" />
      <div className="space-y-1.5">
        <Label htmlFor="code">Doğrulama kodu</Label>
        <Input
          id="code"
          name="code"
          type="text"
          autoFocus
          required
          // Mobil klavye rakama açılsın; tarayıcı SMS/authenticator otomatik doldurmasını tanısın.
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9 -]{6,8}"
          maxLength={8}
          placeholder="123456"
        />
        <p className="text-xs text-muted-foreground">
          Kimlik doğrulama uygulamanızdaki 6 haneli kodu girin.
        </p>
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error === 'code'
            ? 'Kod doğrulanamadı. Yeni kodu bekleyip tekrar deneyin.'
            : error === 'expired'
              ? 'Doğrulama süresi doldu. Lütfen baştan giriş yapın.'
              : 'Sunucuya ulaşılamadı, tekrar deneyin.'}
        </p>
      )}
      <Button type="submit" className="w-full">
        <ShieldCheck /> Doğrula
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        <a href="/login" className="underline underline-offset-2 hover:text-foreground">
          Baştan giriş yap
        </a>
      </p>
    </form>
  );
}
