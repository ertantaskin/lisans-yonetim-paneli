import { ClipboardCheck, TriangleAlert } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { Card } from '../../components/ui/card';
import { ReviewTable } from '../../components/review-table';
import { getReviewQueue, type ReviewQueueData } from './queries';

export const dynamic = 'force-dynamic';

export default async function ReviewPage() {
  let queue: ReviewQueueData | null = null;
  let error: string | null = null;
  try {
    queue = await getReviewQueue();
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
        <div className="space-y-4">
          {/* Liste sunucu üst sınırına dayandıysa DÜRÜSTÇE söyle (/support deseni): sessiz
              kırpma burada "onaylanacak başka sipariş yok" izlenimi verir ve müşteri
              beklemede kalır. Uyarı, kaç kayıt gösterildiğini ve ne yapılması gerektiğini
              söyler; cümle tek kaynakta (`queries.notice`) üretilir. */}
          {queue?.notice && (
            <Alert variant="warning">
              <TriangleAlert />
              <div className="min-w-0 flex-1">
                <AlertTitle>
                  Liste eksik olabilir — {queue.rows.length.toLocaleString('tr-TR')} sipariş
                  gösteriliyor
                </AlertTitle>
                <AlertDescription>{queue.notice}</AlertDescription>
              </div>
            </Alert>
          )}
          {/* Eski API düz dizi döndürürse `rows` yine dolar, `notice` null kalır → ekran
              bugünkü davranışıyla aynen çalışır. */}
          <ReviewTable items={queue?.rows ?? []} />
        </div>
      )}
    </div>
  );
}
