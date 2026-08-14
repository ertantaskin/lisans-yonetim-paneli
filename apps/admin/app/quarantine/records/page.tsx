import { ShieldOff } from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Card } from '../../../components/ui/card';
import { QuarantineNav } from '../../../components/claims/quarantine-nav';
import { QuarantineTable } from '../../../components/quarantine-table';
import { fetchQuarantine, parseQuarantineFilters, QUARANTINE_LIMIT } from '../queries';
import { itemCount } from '../../../lib/labels';
import { SavedViewsMenu } from '../../../components/saved-views-menu';

export const dynamic = 'force-dynamic';

/**
 * KUSURLU STOK › TÜM KAYITLAR (§12) — değişmez defter + süzgeç + dışa aktarma.
 *
 * İŞ LİSTESİ DEĞİL: bildirilmiş olsun olmasın TÜM ölü kalemler burada durur (arşiv/denetim).
 * Yapılacak işler "Bildirilecekler" bölümündedir.
 *
 * SUNUCU SÜZGEÇLERİ BURADA YAŞAR (`?status=&range=&from=&to=&q=`): araç çubuğu bu tablonun
 * içindedir ve `QuarantineTable` gezinirken bu rotaya push eder. `claimed` süzgeci BİLEREK
 * geçilmez — defter tanımı gereği her şeyi gösterir; satır başına "bildirim durumu" kolonu
 * ve hızlı süzgeci tablonun kendisindedir.
 */
export default async function QuarantineRecordsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseQuarantineFilters(await searchParams);
  const { rows, error, truncated } = await fetchQuarantine(filters);
  const kinds = rows.map((r) => r.productKind);

  return (
    <div>
      <PageHeader
        icon={ShieldOff}
        title="Kusurlu Stok — Tüm Kayıtlar"
        description={
          error
            ? 'Arızalı bildirilen, değiştirilen veya geçersiz kılınan tüm kalemlerin değişmez defteri.'
            : `Arızalı bildirilen, değiştirilen veya geçersiz kılınan ${itemCount(rows.length, kinds)} — bildirilmiş olsun olmasın. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ.`
        }
      >
        {/* Kayıtlı görünümler (§14): SUNUCU süzgeçleri (`?status=&range=&from=&to=&q=`) adreste
            yaşıyor → "son 30 gün, geçersiz kılınanlar" gibi bir denetim görünümü tek tıkla
            geri gelir. KİŞİSEL kayıt.

            `unsyncedFilters` (denetim bulgusu U1): hızlı süzgeçler bu ekranda `DataTable`ın
            değil `QuarantineTable`ın state'inde yaşıyor (süzme tablo DIŞINDA yapılıyor ki
            dışa aktarmadaki "görünen N kayıt" dürüst olsun) → `syncUrl` onları YAKALAYAMAZ.
            Uyarı eskiden yalnız adres tamamen boşken çıkıyordu; bu ekranda adres neredeyse
            her zaman dolu olduğu için pratikte HİÇ çıkmıyordu. */}
        <SavedViewsMenu
          page="quarantine"
          unsyncedFilters="hızlı süzgeçler (Bildirim/Ürün/Tedarikçi/Site) ve arama kutusuna yazdıkça yapılan süzme"
        />
      </PageHeader>
      <QuarantineNav />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <QuarantineTable
          rows={rows}
          truncated={truncated}
          limit={QUARANTINE_LIMIT}
          filters={filters}
        />
      )}
    </div>
  );
}
