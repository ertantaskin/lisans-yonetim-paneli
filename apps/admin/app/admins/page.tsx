import { ShieldAlert, ShieldCheck, UserPlus } from 'lucide-react';
import { apiGet, type AdminUser } from '../../lib/api';
import { isOwner } from '../../lib/session';
import { PageHeader, EmptyState } from '../../components/ui/page-header';
import { Card, CardContent } from '../../components/ui/card';
import { CreateAdminForm } from '../../components/create-admin-form';
import { AdminsTable } from '../../components/admins-table';

export const dynamic = 'force-dynamic';

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
              description="Admin yönetimi yalnız 'owner' rolündeki yöneticiler içindir."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  let admins: AdminUser[] = [];
  let error: string | null = null;
  try {
    admins = await apiGet<AdminUser[]>('/v1/admin/users');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ShieldCheck}
        title="Yöneticiler"
        description="Panele erişimi olan adminler. Kullanıcı adı veya e-posta + parola ile giriş yaparlar (§8)."
      />

      <Card className="mb-5">
        <CardContent className="p-5">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-foreground">
            <UserPlus className="size-4 text-muted-foreground" /> Yeni Admin
          </h2>
          <CreateAdminForm />
        </CardContent>
      </Card>

      {error ? (
        <Card>
          <CardContent className="p-5">
            <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
          </CardContent>
        </Card>
      ) : (
        <AdminsTable admins={admins} />
      )}
    </div>
  );
}
