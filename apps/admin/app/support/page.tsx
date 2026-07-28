import { LifeBuoy, TriangleAlert } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { SupportTable } from '../../components/support-table';
import { getReplacements, type ReplacementRow } from './queries';

export const dynamic = 'force-dynamic';

/**
 * Destek kuyruğu (§13) — müşterilerin mağazadan bildirdiği arızalı lisans/hesap talepleri.
 * Operatör bu ekrandan ÇIKMADAN talebi okur, yanıtlar (yazışma) ve karar verir
 * (onayla = değişim / bilgi iste / reddet).
 */
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
        description="Müşterinin “çalışmıyor” diye bildirdiği lisans/hesap talepleri: talebi açın, yazışmadan yanıtlayın, ardından değişimi onaylayın, bilgi isteyin ya da reddedin."
      />
      {error ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Destek talepleri yüklenemedi</AlertTitle>
            <AlertDescription>
              API'ye ulaşılamadı: {error} — bağlantı düzelince sayfayı yenileyin.
            </AlertDescription>
          </div>
        </Alert>
      ) : (
        <SupportTable replacements={replacements} />
      )}
    </div>
  );
}
