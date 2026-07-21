import Link from 'next/link';
import { ArrowLeft, ShieldAlert } from 'lucide-react';
import { isOwner } from '../../../lib/session';
import { Button } from '../../../components/ui/button';
import { Card } from '../../../components/ui/card';
import { PageHeader, EmptyState } from '../../../components/ui/page-header';
import { Wizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewSitePage() {
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
            title="Yeni Site (Sihirbaz)"
            description="Yeni bir WooCommerce/pazar yeri sitesini 3 adımda panele bağlayın (§14)."
          />
        </div>
      </div>

      {/* Yalnız owner site bağlayabilir (auth açıkken). Defense-in-depth. */}
      {(await isOwner()) ? (
        <Wizard />
      ) : (
        <Card className="py-10">
          <EmptyState
            icon={ShieldAlert}
            title="Yetkiniz yok (yalnız owner)"
            description="Site bağlama sihirbazı yalnız 'owner' rolündeki yöneticiler içindir."
          />
        </Card>
      )}
    </div>
  );
}
