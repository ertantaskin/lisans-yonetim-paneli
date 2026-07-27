import Link from 'next/link';
import { Globe, Plus } from 'lucide-react';
import { apiGet, type SiteRow } from '../../lib/api';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
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
      <PageHeader icon={Globe} title="Siteler" description="Her WooCommerce/pazar yeri kanalı bir tenant.">
        <Button asChild>
          <Link href="/sites/new">
            <Plus /> Yeni Site (Sihirbaz)
          </Link>
        </Button>
      </PageHeader>

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
