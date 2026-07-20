import { apiGet, type SiteRow } from '../../lib/api';
import { PageHeader } from '../../components/ui';
import { Card } from '../../components/ui/card';
import { CreateSiteForm } from '../../components/create-site-form';
import { SitesTable } from '../../components/sites-table';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  let sites: SiteRow[] = [];
  let error: string | null = null;
  try {
    sites = await apiGet<SiteRow[]>('/v1/admin/sites');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader title="Siteler" desc="Her WooCommerce/pazar yeri kanalı bir tenant." />

      <Card className="mb-5 max-w-2xl p-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Site Bağla</h2>
        <CreateSiteForm />
      </Card>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <SitesTable sites={sites} />
      )}
    </div>
  );
}
