import { apiGet, type SiteRow } from '../../lib/api';
import { Card, PageHeader, StatusPill, Empty } from '../../components/ui';
import { CreateSiteForm } from '../../components/create-site-form';

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
    <div className="max-w-4xl">
      <PageHeader title="Siteler" desc="Her WooCommerce/pazar yeri kanalı bir tenant." />

      <Card className="mb-5">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Yeni Site Bağla</h2>
        <CreateSiteForm />
      </Card>

      <Card>
        {error ? (
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        ) : sites.length === 0 ? (
          <Empty>Henüz site yok.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Domain</th>
                  <th className="px-3 py-2 font-medium">Tip</th>
                  <th className="px-3 py-2 font-medium">Gönderen</th>
                  <th className="px-3 py-2 font-medium">Durum</th>
                </tr>
              </thead>
              <tbody>
                {sites.map((s) => (
                  <tr key={s.id} className="border-b border-border">
                    <td className="px-3 py-2.5 font-medium text-foreground">{s.domain}</td>
                    <td className="px-3 py-2.5 text-foreground/70">{s.type}</td>
                    <td className="px-3 py-2.5 text-foreground/70">{s.senderEmail ?? '—'}</td>
                    <td className="px-3 py-2.5">
                      <StatusPill status={s.status === 'active' ? 'active' : s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
