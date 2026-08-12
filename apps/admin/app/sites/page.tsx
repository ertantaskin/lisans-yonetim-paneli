import Link from 'next/link';
import { Globe, Plus } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { SitesTable, type SiteListRow } from '../../components/sites-table';

export const dynamic = 'force-dynamic';

export default async function SitesPage() {
  // SiteListRow = SiteRow + bağlantı sağlığı alanları (pluginVersion/pluginVersionAt, 0028).
  // API bunları zaten döndürüyor (toPublicSite sır olmayan kolonları geçirir); tip tarafında
  // opsiyonel okunur → alan gelmezse kolon "—" gösterir, uydurma değer basılmaz.
  let sites: SiteListRow[] = [];
  let error: string | null = null;
  try {
    sites = await apiGet<SiteListRow[]>('/v1/admin/sites');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader icon={Globe} title="Siteler" description="Her satış kanalı (mağaza / pazar yeri / bayi) bir tenant.">
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
