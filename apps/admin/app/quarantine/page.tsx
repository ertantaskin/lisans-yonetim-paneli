import { ShieldOff } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { QuarantineTable } from '../../components/quarantine-table';
import { QuarantineTabs } from '../../components/claims/quarantine-tabs';
import { ClaimsList, PendingClaimsPanel } from '../../components/claims/claims-panel';
import {
  fetchQuarantine,
  hasQuarantineServerFilters,
  parseQuarantineFilters,
  QUARANTINE_LIMIT,
} from './queries';
import { fetchClaims, fetchSuppliersLite } from './claims-queries';

export const dynamic = 'force-dynamic';

/**
 * Kusurlu Anahtarlar (§2/§3/§12) — kusur havuzu + tedarikçiye değişim fişleri.
 *
 * NEDEN İKİ SEKME: ekran eskiden yalnız düz bir "ölü anahtar defteri"ydi; operatörün asıl işi
 * (partiden çıkan hatalıları tedarikçiye bildirip takip etmek) panelde hiç yaşamıyordu, tek
 * yol izi olmayan bir CSV indirmesiydi. "Bekleyenler" = henüz bildirilmemiş kusur havuzu
 * (tedarikçi→parti gruplu, tek tıkla fiş); "Fişler" = kesilen fişlerin geçmişi ve sonuçları.
 *
 * Durum · tarih aralığı · arama SUNUCU süzgecidir ve URL'de taşınır (`?status=&range=&from=&to=&q=`).
 * Ürün/tedarikçi/site facet'leri ile hızlı arama YALNIZ yüklenen pencere içinde, istemcide kalır.
 */
export default async function QuarantinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseQuarantineFilters(await searchParams);
  // Üç bağımsız okuma → tek turda paralel (sayfa üç kaynağı da göstermeden açılmıyor zaten).
  const [{ rows, error, truncated }, claims, suppliers] = await Promise.all([
    fetchQuarantine(filters),
    fetchClaims(),
    fetchSuppliersLite(),
  ]);

  // "Bekleyenler" = henüz bildirilmemiş. Süzgeç SUNUCUDA da var (`claimed=none`) ama liste
  // görünümü tüm ölü anahtarları göstermeye devam ediyor (defter işlevi korunur); panel
  // yalnız bildirilmemiş olanları gruplar. Yüklem BİREBİR aynı: fişte açık kaydı yoksa bekliyor.
  const pendingRows = rows.filter((r) => !r.claimId);

  const description = hasQuarantineServerFilters(filters)
    ? 'Arızalı olduğu bildirilen, değiştirilen veya geçersiz kılınan lisans ve hesap kalemleri. Aşağıdaki liste SÜZÜLMÜŞ sunucu sonucudur; dışa aktarma bu sonucu kapsar.'
    : 'Arızalı olduğu bildirilen, değiştirilen veya geçersiz kılınan lisans ve hesap kalemleri. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ. Tedarikçiye toplu bildirmek için “Fiş oluştur” ile bir değişim fişi kesin — fiş kesilen anahtar bekleyenler listesinden düşer, reddedilen geri döner.';

  return (
    <div>
      <PageHeader icon={ShieldOff} title="Kusurlu Anahtarlar" description={description} />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <QuarantineTabs
          pendingCount={pendingRows.length}
          claimCount={claims.rows.length}
          pending={
            <>
              <PendingClaimsPanel
                rows={pendingRows}
                suppliers={suppliers}
                lastClaim={claims.rows[0] ?? null}
              />
              <QuarantineTable
                rows={rows}
                truncated={truncated}
                limit={QUARANTINE_LIMIT}
                filters={filters}
              />
            </>
          }
          claims={<ClaimsList rows={claims.rows} error={claims.error} />}
        />
      )}
    </div>
  );
}
