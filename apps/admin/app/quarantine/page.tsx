import { ShieldOff } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { QuarantineTable } from '../../components/quarantine-table';
import {
  fetchQuarantine,
  hasQuarantineServerFilters,
  parseQuarantineFilters,
  QUARANTINE_LIMIT,
} from './queries';

export const dynamic = 'force-dynamic';

/**
 * Karantina / Değiştirilen Anahtarlar (§2/§3).
 *
 * Durum · tarih aralığı · arama SUNUCU süzgecidir ve URL'de taşınır (`?status=&range=&from=&to=&q=`)
 * — /customers?site= deseni. Sorgu veritabanındaki TÜM kayıtları tarar (yalnız "en yeni 5000"
 * penceresini değil), böylece kırpılma uyarısının önerdiği "aralığı daraltıp yeniden yükleyin"
 * eylemi gerçekten sonuç verir; sonuç yine en fazla `QUARANTINE_LIMIT` kayıttır ve kırpılırsa
 * tabloda uyarı çıkar. Ürün/tedarikçi/site facet'leri ile hızlı arama YALNIZ yüklenen pencere
 * içinde, istemcide kalır (istek atmadan anında süzer).
 */
export default async function QuarantinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseQuarantineFilters(await searchParams);
  const { rows, error, truncated } = await fetchQuarantine(filters);

  const description = hasQuarantineServerFilters(filters)
    ? 'Arızalı olduğu bildirilen, değiştirilen veya geçersiz kılınan lisans ve hesap kalemleri. Aşağıdaki liste SÜZÜLMÜŞ sunucu sonucudur; dışa aktarma bu sonucu kapsar.'
    : 'Arızalı olduğu bildirilen, değiştirilen veya geçersiz kılınan lisans ve hesap kalemleri. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ; tedarikçiden değişim istemek için listeyi durum/tarih/ürün/tedarikçi/site ile süzüp CSV (Excel) ya da düz metin olarak dışa aktarabilirsiniz.';

  return (
    <div>
      <PageHeader icon={ShieldOff} title="Karantina" description={description} />
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
