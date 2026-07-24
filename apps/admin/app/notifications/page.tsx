import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { NotificationsTable } from '../../components/notifications-table';
import { getNotifications, type NotificationRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  let notifications: NotificationRow[] = [];
  let error: string | null = null;
  try {
    notifications = await getNotifications();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Bildirimler"
        description="Düşük stok ve sistem bildirimleri — kritik/uyarı/bilgi seviyeleri."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <NotificationsTable notifications={notifications} />
      )}
    </div>
  );
}
