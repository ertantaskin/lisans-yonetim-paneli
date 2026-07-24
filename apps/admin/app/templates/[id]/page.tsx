import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { ApiError, type ProductRow, type SiteRow } from '../../../lib/api';
import { PageHeader } from '../../../components/ui/page-header';
import { Card } from '../../../components/ui/card';
import { Button } from '../../../components/ui/button';
import { TemplateEditor } from '../template-editor';
import { getTemplate, listProducts, listSites, type TemplateRow } from '../queries';

export const dynamic = 'force-dynamic';

export default async function EditTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  let template: TemplateRow | null = null;
  let products: ProductRow[] = [];
  let sites: SiteRow[] = [];
  let error: string | null = null;
  try {
    [template, products, sites] = await Promise.all([
      getTemplate(id),
      listProducts(),
      listSites(),
    ]);
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Şablon yüklenemedi';
  }

  return (
    <div>
      <div className="mb-5 flex items-center gap-3">
        <Button asChild variant="ghost" size="icon-sm">
          <Link href="/templates" aria-label="Geri">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <PageHeader title="Şablonu Düzenle" description="Değişiklikleri kaydedin veya test maili gönderin." />
      </div>

      {error || !template ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">{error ?? 'Şablon bulunamadı.'}</p>
        </Card>
      ) : (
        <TemplateEditor template={template} products={products} sites={sites} />
      )}
    </div>
  );
}
