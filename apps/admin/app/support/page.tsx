import { LifeBuoy } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { SupportTable } from '../../components/support-table';
import { getReplacements, type ReplacementRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function SupportPage() {
  let replacements: ReplacementRow[] = [];
  let error: string | null = null;
  try {
    replacements = await getReplacements();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={LifeBuoy}
        title="Destek"
        description="Değişim/garanti talepleri — onayla (değiştir), reddet veya bilgi iste."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <SupportTable replacements={replacements} />
      )}
    </div>
  );
}
