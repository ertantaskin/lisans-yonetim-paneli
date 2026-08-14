'use client';
import * as React from 'react';
import { useActionState } from 'react';
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  confirmTotpSetupAction,
  disableTotpAction,
  startTotpSetupAction,
  type TotpSetupState,
} from './totp-actions';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/input';

const initial: TotpSetupState = {};

/**
 * Kendi hesabım → iki faktörlü doğrulama kurulumu.
 *
 * Üç durum: (1) kapalı → "Kurulumu başlat", (2) sır üretildi ama ONAYLANMADI → sır + URI
 * gösterilir, kod istenir (bayrak ancak burada açılır → yanlış kurulumda kilitlenme YOK),
 * (3) açık → parola + kod ile kapatma.
 *
 * QR YOK (bilinçli): yeni bağımlılık eklenmedi; her authenticator uygulaması "kurulum
 * anahtarını elle gir" akışını destekler. Sır yalnız bu ekranda, bir kez görünür.
 */
export function TotpCard({
  enabled,
  pendingSetup,
  account,
}: {
  enabled: boolean;
  pendingSetup: boolean;
  account: string;
}) {
  const [setup, startAction, startPending] = useActionState(startTotpSetupAction, initial);
  const [confirm, confirmAction, confirmPending] = useActionState(confirmTotpSetupAction, initial);
  const [off, disableAction, disablePending] = useActionState(disableTotpAction, initial);

  // Sunucudan gelen ilk durum + bu oturumdaki aksiyon sonuçları birleştirilir (sayfa
  // revalidate edilse de kullanıcı akışı kesilmesin).
  const isEnabled = confirm.enabled === true ? true : off.enabled === false ? false : enabled;
  const showSecret = Boolean(setup.secret) && !isEnabled;
  const awaitingCode = showSecret || (pendingSetup && !isEnabled);

  if (isEnabled) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <Badge variant="success">
            <ShieldCheck /> Açık
          </Badge>
          <span className="text-sm text-muted-foreground">
            Girişte parolanın ardından 6 haneli kod sorulur.
          </span>
        </div>
        <Alert variant="muted">
          <ShieldOff />
          <div>
            <AlertTitle>Kapatmak istiyorsanız</AlertTitle>
            <AlertDescription>
              Güvenlik gereği parolanız ve <strong>güncel kod</strong> birlikte istenir. Cihazınızı
              kaybettiyseniz kapatamazsınız — bir <strong>Sahip</strong> rolündeki yöneticiden
              sıfırlama isteyin.
            </AlertDescription>
          </div>
        </Alert>
        <form action={disableAction} className="grid max-w-md gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="totp-off-pw">Parolanız</Label>
            <Input
              id="totp-off-pw"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="totp-off-code">Güncel kod</Label>
            <Input
              id="totp-off-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              placeholder="123456"
            />
          </div>
          {off.error && (
            <p role="alert" className="text-sm text-destructive">
              {off.error}
            </p>
          )}
          <div>
            <Button type="submit" variant="danger" disabled={disablePending}>
              <ShieldOff /> {disablePending ? 'Kapatılıyor…' : 'İki faktörlü doğrulamayı kapat'}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Badge variant="warning">Kapalı</Badge>
        <span className="text-sm text-muted-foreground">
          Giriş şu an tek faktörlü: parolanız ele geçerse panele tam erişim sağlanır.
        </span>
      </div>

      {!awaitingCode && (
        <form action={startAction}>
          <Button type="submit" disabled={startPending}>
            <KeyRound /> {startPending ? 'Hazırlanıyor…' : 'Kurulumu başlat'}
          </Button>
          {setup.error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {setup.error}
            </p>
          )}
        </form>
      )}

      {showSecret && (
        <Alert variant="info">
          <KeyRound />
          <div className="min-w-0">
            <AlertTitle>Kurulum anahtarı — yalnız bir kez gösterilir</AlertTitle>
            <AlertDescription>
              <p className="mb-2">
                Kimlik doğrulama uygulamanızda (Google Authenticator, 1Password, Bitwarden…)
                “kurulum anahtarını elle gir” seçeneğini kullanın. Hesap adı:{' '}
                <strong>{setup.account ?? account}</strong>
              </p>
              <code className="block overflow-x-auto rounded-md bg-background px-3 py-2 font-mono text-sm tracking-widest">
                {setup.secret}
              </code>
              <p className="mt-2 break-all font-mono text-xs text-muted-foreground">
                {setup.otpauthUri}
              </p>
            </AlertDescription>
          </div>
        </Alert>
      )}

      {awaitingCode && (
        <form action={confirmAction} className="grid max-w-md gap-3">
          {!showSecret && (
            <p className="text-sm text-muted-foreground">
              Yarım kalmış bir kurulum var. Uygulamanızdaki kodu girerek tamamlayın ya da
              “Kurulumu başlat” ile yeni bir anahtar üretin.
            </p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="totp-code">Uygulamadaki 6 haneli kod</Label>
            <Input
              id="totp-code"
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              placeholder="123456"
            />
          </div>
          {confirm.error && (
            <p role="alert" className="text-sm text-destructive">
              {confirm.error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={confirmPending}>
              <ShieldCheck /> {confirmPending ? 'Doğrulanıyor…' : 'Doğrula ve aç'}
            </Button>
            {!showSecret && (
              <Button type="submit" variant="outline" formAction={startAction} disabled={startPending}>
                <KeyRound /> Yeni anahtar üret
              </Button>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
