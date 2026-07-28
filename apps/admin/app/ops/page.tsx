import { Info, MailWarning, TriangleAlert } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { DeadLetterTable } from '../../components/dead-letter-table';
import { MaintenanceCard } from './maintenance-card';
import { getDeadLetter, type DeadLetterPage } from './queries';

export const dynamic = 'force-dynamic';

/** Boş sayfa (API'ye ulaşılamadığında render kırılmasın). */
const EMPTY_PAGE: DeadLetterPage = { items: [], total: 0, truncated: false, limit: 0 };

export default async function OpsPage() {
  let page: DeadLetterPage = EMPTY_PAGE;
  let error: string | null = null;
  try {
    page = await getDeadLetter();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  // Yeniden kuyruğa ALINAMAYAN kayıtlar (teslimat olmayan durum/bildirim maili, siparişe
  // bağlı olmayan test maili). API bu kaydı replay ucunda da açık mesajla reddeder; burada
  // ÖNCEDEN söylemek operatörü boşuna denemekten kurtarır (§16 görünürlük).
  const blocked = page.items.filter((r) => !r.replayable);

  return (
    <div>
      <PageHeader
        icon={MailWarning}
        title="Başarısız İşler"
        description="Başarısız geri-kanal webhook olayları ve mail teslimleri — tek tıkla yeniden kuyruğa al."
      />
      <MaintenanceCard />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {page.truncated && (
            <Alert variant="warning">
              <TriangleAlert />
              <div className="min-w-0 flex-1">
                <AlertTitle>Liste kırpıldı</AlertTitle>
                <AlertDescription>
                  Toplam {page.total} kayıttan {page.items.length} tanesi gösteriliyor (en son
                  güncellenenler). Görünen kayıtları çözdükçe kalanlar listeye girer — bu ekranda
                  görünmeyen kayıtlar yeniden gönderilemez.
                </AlertDescription>
              </div>
            </Alert>
          )}

          {blocked.length > 0 && (
            <Alert variant="info">
              <Info />
              <div className="min-w-0 flex-1">
                <AlertTitle>{blocked.length} kayıt yeniden gönderilemez</AlertTitle>
                <AlertDescription>
                  {blocked[0]!.replayBlockedReason ??
                    'Bu kayıtlar teslimat maili değil — teslimat olarak yeniden gönderilemez.'}{' '}
                  Bu satırlarda &quot;Yeniden gönder&quot; aksiyonu kapalıdır; ilgili bildirimi
                  ilgili ekrandan (destek talebi / şablon testi) tekrar tetikleyin.
                </AlertDescription>
              </div>
            </Alert>
          )}

          <DeadLetterTable rows={page.items} />
        </div>
      )}
    </div>
  );
}
