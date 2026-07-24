import { ClipboardCheck } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { ReviewTable } from '../../components/review-table';
import { getReviewQueue, type ReviewRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  let items: ReviewRow[] = [];
  let error: string | null = null;
  try {
    items = await getReviewQueue();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader
        icon={ClipboardCheck}
        title="İnceleme Kuyruğu"
        description="Dinamik satış kotası eşiğini aşan siparişler reddedilmez, manuel onay bekler — Onayla teslimatı başlatır, Reddet siparişi kapatır (müşteriye key gitmez)."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <ReviewTable items={items} />
      )}
    </div>
  );
}
