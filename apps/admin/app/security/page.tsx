import { ShieldAlert } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { SecurityTable } from '../../components/security-table';
import { getSecurityEvents, SECURITY_FETCH_LIMIT, type SecurityEventsData } from './queries';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  let data: SecurityEventsData = { rows: [], truncated: false };
  let error: string | null = null;
  try {
    data = await getSecurityEvents();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ShieldAlert}
        title="Güvenlik"
        description="Anormal hız, kota ve anomali olayları — insan onaylar. Otomatik askıya alma yok."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <SecurityTable
          events={data.rows}
          truncated={data.truncated}
          limit={SECURITY_FETCH_LIMIT}
        />
      )}
    </div>
  );
}
