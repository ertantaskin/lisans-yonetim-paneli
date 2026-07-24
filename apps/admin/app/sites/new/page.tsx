import Link from 'next/link';
import { ArrowLeft, Globe } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { PageHeader } from '../../../components/ui/page-header';
import { Wizard } from './wizard';

export const dynamic = 'force-dynamic';

export default function NewSitePage() {
  return (
    <div className="space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/sites">
            <ArrowLeft /> Siteler
          </Link>
        </Button>
        <div className="mt-2">
          <PageHeader
            icon={Globe}
            title="Yeni Site (Sihirbaz)"
            description="Yeni bir WooCommerce/pazar yeri sitesini 3 adımda panele bağlayın (§14)."
          />
        </div>
      </div>

      {/* Site bağlama, satır-içi 'Yeni Site Bağla' formu (createSiteAction) ile aynı
          admin seviyesinde — owner şartı yok (M11 tutarlılık). Kimlik doğrulama
          middleware'de zorlanır; sayfaya ulaşan herkes zaten yetkili admindir. */}
      <Wizard />
    </div>
  );
}
