import { PageHeader } from '../../../components/ui/page-header';
import { CostsView } from '../costs-view';

export const dynamic = 'force-dynamic';

export default function CostsReportPage() {
  return (
    <div>
      <PageHeader
        title="Maliyet Raporu"
        description="Gelir HARİÇ — yalnız tedarik maliyeti (PO). Kâr/marj panelde hesaplanmaz."
      />
      <CostsView />
    </div>
  );
}
