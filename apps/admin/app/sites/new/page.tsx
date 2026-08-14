import Link from 'next/link';
import { ArrowLeft, Globe, ShieldAlert } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Card, CardContent } from '../../../components/ui/card';
import { PageHeader, EmptyState } from '../../../components/ui/page-header';
import { isOwner } from '../../../lib/session';
import { Wizard } from './wizard';

export const dynamic = 'force-dynamic';

export default async function NewSitePage() {
  /**
   * OWNER-ONLY (denetim Y1 — eski "owner şartı yok (M11 tutarlılık)" notu ARTIK GEÇERSİZ).
   *
   * Sihirbaz sıradan bir "site kaydı açma" formu DEĞİL: 2. adımda bağlan kodu üretilir, bu da
   * site creds'ini yeniler (rekey) ve kod GUARD'SIZ public `/v1/connect/claim` ucundan
   * `{apiKey, hmacSecret}` olarak teslim edilir. Kodu eline geçiren, o mağazanın HMAC kimliğiyle
   * site-facing `reveal` ucunu imzalayıp DÜZ METİN lisans anahtarı/hesap parolası okuyabilir →
   * "düz metin YALNIZ owner" kararı (A1/A3) atlanırdı. Bu yüzden `rotate-secret` ile aynı
   * seviyede owner-only'dir.
   *
   * Bu kontrol yalnız GÖRÜNÜRLÜK içindir; asıl kapılar sunucu aksiyonlarındaki isOwner()
   * (actions.ts) ve API'deki OwnerGuard'dır. Burada engellemek, owner-olmayan operatörün formu
   * baştan sona doldurup son adımda hata almasını önler.
   */
  if (!(await isOwner())) {
    return (
      <div className="space-y-6">
        <div>
          <Button asChild variant="ghost" size="sm" className="-ml-2">
            <Link href="/sites">
              <ArrowLeft /> Siteler
            </Link>
          </Button>
          <div className="mt-2">
            <PageHeader icon={Globe} title="Yeni Site (Sihirbaz)" />
          </div>
        </div>
        <Card>
          <CardContent className="px-5 py-10">
            <EmptyState
              icon={ShieldAlert}
              title="Yetkiniz yok"
              description="Site bağlama, mağazanın kimlik bilgilerini (API anahtarı + HMAC sırrı) yenilediği için yalnız Sahip rolündeki yöneticiler içindir."
            />
          </CardContent>
        </Card>
      </div>
    );
  }

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
            description="Yeni bir satış kanalını (mağaza / pazar yeri / bayi) 3 adımda panele bağlayın."
          />
        </div>
      </div>

      <Wizard />
    </div>
  );
}
