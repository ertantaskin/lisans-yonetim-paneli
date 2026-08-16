import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, FileText, TriangleAlert } from 'lucide-react';
import { ApiError, type ProductRow, type SiteRow } from '../../../lib/api';
import { PageHeader } from '../../../components/ui/page-header';
import { Alert, AlertDescription } from '../../../components/ui/alert';
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
  /** Kapsam seçicilerini besleyen yardımcı listeler gelmedi mi (D1) — sessiz boş dropdown yasak. */
  let scopeListsUnavailable = false;
  try {
    /*
      YANLIŞ 404 KORUMASI (denetim D1): `listProducts`/`listSites` ÇIPLAK bırakılırsa
      aşağıdaki catch onların 404'ünü şablonunkinden ayırt edemez → VAR OLAN bir şablon
      için "sayfa bulunamadı" gösterilirdi. Bu iki liste yalnız editörün kapsam (ürün/site)
      seçicilerini doldurur, ŞABLONUN KENDİSİ için gerekli değildir → korunur ve şablon
      düzenlemesi çalışmaya devam eder. 404→notFound() artık YALNIZ `getTemplate`'e bağlı.
    */
    [template, products, sites] = await Promise.all([
      getTemplate(id),
      listProducts().catch(() => {
        scopeListsUnavailable = true;
        return [] as ProductRow[];
      }),
      listSites().catch(() => {
        scopeListsUnavailable = true;
        return [] as SiteRow[];
      }),
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
        <PageHeader icon={FileText} title="Şablonu Düzenle" description="Değişiklikleri kaydedin veya test maili gönderin." />
      </div>

      {error || !template ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">{error ?? 'Şablon bulunamadı.'}</p>
        </Card>
      ) : (
        <>
          {/* Sessiz boş dropdown yasak (D1): kapsam listeleri gelmediyse operatör, şablonu
              bir ürüne/siteye bağlayamamasının yapılandırma değil ERİŞİM sorunu olduğunu
              görmeli. Şablon metni normal düzenlenip kaydedilebilir. */}
          {scopeListsUnavailable && (
            <Alert variant="warning" className="mb-4">
              <TriangleAlert />
              <AlertDescription>
                Ürün/mağaza listesi alınamadı — kapsam seçimi şu an boş görünüyor. Şablonu
                düzenleyip kaydedebilirsiniz; kapsamı değiştirmek için sayfayı yenileyin.
              </AlertDescription>
            </Alert>
          )}
          <TemplateEditor template={template} products={products} sites={sites} />
        </>
      )}
    </div>
  );
}
