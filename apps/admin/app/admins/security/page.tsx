import { ShieldCheck, ShieldAlert } from 'lucide-react';
import { apiGet } from '../../../lib/api';
import { getSessionUser } from '../../../lib/session';
import { authEnabled } from '../../../lib/auth';
import { PageHeader } from '../../../components/ui/page-header';
import { Card, CardContent } from '../../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';
import { TotpCard } from '../totp-card';

export const dynamic = 'force-dynamic';

interface TotpStatus {
  id: string;
  email: string;
  totpEnabled: boolean;
  pendingSetup: boolean;
}

/**
 * "Hesap Güvenliğim" — HER yönetici kendi ikinci faktörünü buradan kurar.
 *
 * AD TEK KAYNAK (denetim bulgusu U7): sol menü, sayfa başlığı ve breadcrumb aynı adı yazar.
 * Eskiden üç farklı ad vardı ("Hesap Güvenliğim" / "Hesap güvenliği" / "Güvenlik") ve
 * sonuncusu `/security` ekranının adıyla ÇAKIŞIYORDU. Breadcrumb artık tam yol sözlüğünden
 * (`components/shell/site-header.tsx` → PATH_LABELS) okuyor.
 *
 * NEDEN /admins ALTINDA AMA OWNER KAPISI YOK: `/admins` yalnız owner'a açıktır (yönetici
 * CRUD'u); ikinci faktör ise herkesin KENDİ hesabının ayarıdır — owner kapısının arkasına
 * konsaydı owner-olmayan yöneticiler 2FA'yı hiç açamazdı. Yetki, hedef kimliğin OTURUMDAN
 * alınmasıyla sağlanır (bkz. totp-actions.ts) + API `assertSelfOrOwner`.
 */
export default async function AdminSecurityPage() {
  const session = await getSessionUser();

  if (!authEnabled() || !session) {
    return (
      <div>
        <PageHeader icon={ShieldCheck} title="Hesap Güvenliğim" />
        <Card>
          <CardContent className="p-5">
            <Alert variant="warning">
              <ShieldAlert />
              <div>
                <AlertTitle>Kimlik doğrulama kapalı</AlertTitle>
                <AlertDescription>
                  Panel şu an oturum kapısı olmadan çalışıyor (SESSION_SECRET tanımlı değil).
                  İki faktörlü doğrulama ancak giriş açıkken anlamlıdır.
                </AlertDescription>
              </div>
            </Alert>
          </CardContent>
        </Card>
      </div>
    );
  }

  let status: TotpStatus | null = null;
  let error: string | null = null;
  try {
    status = await apiGet<TotpStatus>(`/v1/admin/users/${session.sub}/totp`);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Hesap Güvenliğim"
        description="Girişinize ikinci bir adım ekleyin: parolanız ele geçse bile telefonunuzdaki kod olmadan panele girilemez."
      />
      <Card>
        <CardContent className="p-5">
          {error || !status ? (
            <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
          ) : (
            <TotpCard
              enabled={status.totpEnabled}
              pendingSetup={status.pendingSetup}
              account={status.email}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
