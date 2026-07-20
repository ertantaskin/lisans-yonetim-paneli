import { PageHeader } from '../../components/ui';
import { Card } from '../../components/ui/card';
import { SecurityTable } from '../../components/security-table';
import { getSecurityEvents, type SecurityEventRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function SecurityPage() {
  let events: SecurityEventRow[] = [];
  let error: string | null = null;
  try {
    events = await getSecurityEvents();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        title="Güvenlik"
        desc="Velocity/kota/anomali olayları — insan onaylar (§15). Otomatik askıya alma yok."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <SecurityTable events={events} />
      )}
    </div>
  );
}
