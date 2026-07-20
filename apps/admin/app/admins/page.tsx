import { ShieldAlert } from 'lucide-react';
import { apiGet, type AdminUser } from '../../lib/api';
import { isOwner } from '../../lib/session';
import { Card, PageHeader } from '../../components/ui';
import { EmptyState } from '../../components/ui/page-header';
import { CreateAdminForm } from '../../components/create-admin-form';
import { AdminsTable } from '../../components/admins-table';

export const dynamic = 'force-dynamic';

export default async function AdminsPage() {
  // Yalnız owner yönetebilir (auth açıkken). Defense-in-depth: nav gizli + burada da engel.
  if (!(await isOwner())) {
    return (
      <div>
        <PageHeader title="Yöneticiler" />
        <Card className="py-10">
          <EmptyState
            icon={ShieldAlert}
            title="Yetkiniz yok"
            description="Admin yönetimi yalnız 'owner' rolündeki yöneticiler içindir."
          />
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
        title="Yöneticiler"
        desc="Panele erişimi olan adminler. Kullanıcı adı veya e-posta + parola ile giriş yaparlar (§8)."
      />

      <Card className="mb-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Admin</h2>
        <CreateAdminForm />
      </Card>

      {error ? (
        <Card>
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <AdminsTable admins={admins} />
      )}
    </div>
  );
}
