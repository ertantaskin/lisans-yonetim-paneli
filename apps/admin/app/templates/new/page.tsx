import type { ProductRow, SiteRow } from '../../../lib/api';
import { PageHeader } from '../../../components/ui';
import { Card } from '../../../components/ui/card';
import { TemplateEditor } from '../template-editor';
import { listProducts, listSites } from '../queries';

export const dynamic = 'force-dynamic';

export default async function NewTemplatePage() {
  let products: ProductRow[] = [];
  let sites: SiteRow[] = [];
  let error: string | null = null;
  try {
    [products, sites] = await Promise.all([listProducts(), listSites()]);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div>
      <PageHeader title="Yeni Şablon" desc="Kapsamı boş bırakırsanız genel varsayılan olur." />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <TemplateEditor template={null} products={products} sites={sites} />
      )}
    </div>
  );
}
