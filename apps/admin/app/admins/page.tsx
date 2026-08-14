import Link from 'next/link';
import { ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react';
import { apiGet, type AdminUser } from '../../lib/api';
import { isOwner } from '../../lib/session';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { CollapsiblePanel } from '@/components/ui/collapsible-panel';
import { Card, CardContent } from '../../components/ui/card';
import { CreateAdminForm } from '../../components/create-admin-form';
import { AdminsTable } from '../../components/admins-table';
import { TotpAdminList } from './totp-admin-list';

export const dynamic = 'force-dynamic';

/**
 * API `/v1/admin/users` yanıtı `totpEnabled` de taşır (paylaşılan `AdminUser` tipi henüz
 * bilmiyor). OPSİYONEL okunur: api/admin ayrı imajlar olduğundan sürüm sapmasında alan
 * gelmeyebilir → o durumda "Bilinmiyor" gösterilir, uydurma "kapalı" DEĞİL.
 */
type AdminUserWithTotp = AdminUser & { totpEnabled?: boolean };

export default async function AdminsPage() {
  // Yalnız owner yönetebilir (auth açıkken). Defense-in-depth: nav gizli + burada da engel.
  if (!(await isOwner())) {
    return (
      <div>
        <PageHeader icon={ShieldCheck} title="Yöneticiler" />
        <Card>
          <CardContent className="px-5 py-10">
            <EmptyState
              icon={ShieldAlert}
              title="Yetkiniz yok"
              description="Admin yönetimi yalnız Sahip rolündeki yöneticiler içindir."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  let admins: AdminUserWithTotp[] = [];
  let error: string | null = null;
  try {
    admins = await apiGet<AdminUserWithTotp[]>('/v1/admin/users');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Yöneticiler"
        description="Panele erişimi olan adminler. Kullanıcı adı veya e-posta + parola ile giriş yaparlar."
      />

      {/* Varsayılan KAPALI (bkz. /suppliers): admin eklemek seyrek bir iş, form sürekli
          açık durunca yönetici listesini aşağı itiyordu. */}
      <CollapsiblePanel title="Yeni Admin" icon={<UserPlus />} className="max-w-3xl">
        <CreateAdminForm />
      </CollapsiblePanel>

      {error ? (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
          </CardContent>
        </Card>
      ) : (
        <AdminsTable admins={admins} />
      )}

      {/* İKİ FAKTÖRLÜ DOĞRULAMA — panel canlı lisans deposunun tek kapısı; tek faktörlü
          girişte ele geçen bir parola owner rolünde TÜM envanteri düz metin gösterebilir.
          Kurulum kullanıcının KENDİ ekranındadır (sır kimseyle paylaşılmaz); owner burada
          yalnız durumu görür ve kurtarma yapar. */}
      {!error && (
        <Card className="mt-6">
          <CardContent className="p-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  İki faktörlü doğrulama (TOTP)
                </h2>
                <p className="text-sm text-muted-foreground">
                  Girişte paroladan sonra telefondaki 6 haneli kod sorulur. Cihazını kaybeden
                  kullanıcı için “Sıfırla” kurtarma yoludur (açık oturumları da kapatır).
                </p>
              </div>
              <Link
                href="/admins/security"
                className="text-sm underline underline-offset-2 hover:text-foreground"
              >
                Kendi hesabımı ayarla
              </Link>
            </div>
            <TotpAdminList
              admins={admins.map((a) => ({
                id: a.id,
                name: a.name,
                email: a.email,
                totpEnabled: a.totpEnabled,
              }))}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
