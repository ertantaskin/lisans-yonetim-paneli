import Link from 'next/link';
import { FileText, Plus } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { TemplatesTable } from '../../components/templates-table';
import { listTemplates, type TemplateRow } from './queries';

export const dynamic = 'force-dynamic';

export default async function TemplatesPage() {
  let templates: TemplateRow[] = [];
  let error: string | null = null;
  try {
    templates = await listTemplates();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <PageHeader
          icon={FileText}
          title="Teslimat Şablonları"
          description="Mail konusu + gövdesi. Öncelik: site override > ürün > genel varsayılan."
        />
        <Button asChild>
          <Link href="/templates/new">
            <Plus className="size-4" />
            Yeni Şablon
          </Link>
        </Button>
      </div>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <TemplatesTable templates={templates} />
      )}
    </div>
  );
}
