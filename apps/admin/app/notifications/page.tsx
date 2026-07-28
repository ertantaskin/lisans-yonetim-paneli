import { Bell } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { NotificationsTable } from '../../components/notifications-table';
import { getNotifications, NOTIFICATIONS_LIMIT, type NotificationRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function NotificationsPage() {
  let notifications: NotificationRow[] = [];
  let truncated = false;
  let error: string | null = null;
  try {
    const data = await getNotifications();
    notifications = data.rows;
    truncated = data.truncated;
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={Bell}
        title="Bildirimler"
        description="Düşük stok ve sistem bildirimleri — kritik/uyarı/bilgi seviyeleri. Okunmamışları işaretleyince üst bardaki çan rozeti de düşer."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <NotificationsTable
          notifications={notifications}
          truncated={truncated}
          limit={NOTIFICATIONS_LIMIT}
        />
      )}
    </div>
  );
}
