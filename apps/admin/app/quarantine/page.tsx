import { ShieldOff } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { QuarantineTable } from '../../components/quarantine-table';
import { fetchQuarantine } from './queries';

export const dynamic = 'force-dynamic';

export default async function QuarantinePage() {
  const { rows, error, truncated } = await fetchQuarantine();

  return (
    <div>
      <PageHeader
        icon={ShieldOff}
        title="Karantina"
        description="Arızalı olduğu bildirilen, değiştirilen veya geçersiz kılınan lisans ve hesap kalemleri. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ; tedarikçiden değişim istemek için listeyi süzüp dışa aktarabilirsiniz."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <QuarantineTable rows={rows} truncated={truncated} />
      )}
    </div>
  );
}
