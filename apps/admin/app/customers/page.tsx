import { Users } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { CustomersTable } from '../../components/customers-table';
import { CustomerSiteFilter } from '../../components/customer-site-filter';
import { getCustomers, getSitesForFilter, type CustomerRow, type SiteOption } from './queries';

export const dynamic = 'force-dynamic';

/**
 * Müşteriler — site → müşteri hiyerarşisi. Üstteki site süzgeci ile bir siteye daralınca
 * (?site=<id>) yalnız o sitenin müşterileri + o siteye kapsanmış sayılar gösterilir; süzgeç
 * boşken tüm müşteriler + hangi site(ler)den geldikleri ("Siteler" kolonu) görünür.
 */
export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ site?: string }>;
}) {
  const { site } = await searchParams;

  let customers: CustomerRow[] = [];
  let sites: SiteOption[] = [];
  let error: string | null = null;
  try {
    [customers, sites] = await Promise.all([getCustomers({ siteId: site }), getSitesForFilter()]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const activeSite = sites.find((s) => s.id === site);
  const description = activeSite
    ? `${activeSite.domain} sitesinin müşterileri — sipariş/atama/değişim bu siteye göre.`
    : 'Sipariş/atama geçmişi, değişim oranı ve etiketler — site süzgeci ile bir siteye daralın.';

  return (
    <div>
      <PageHeader icon={Users} title="Müşteriler" description={description}>
        <CustomerSiteFilter sites={sites} current={site} />
      </PageHeader>
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <CustomersTable customers={customers} siteScoped={!!activeSite} />
      )}
    </div>
  );
}
