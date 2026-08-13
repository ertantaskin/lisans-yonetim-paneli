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
 * KUSURLU STOK (§2/§3/§12) — kusur havuzu + tedarikçiye değişim fişleri.
 *
 * ADLANDIRMA: ekran eskiden "Kusurlu Anahtarlar" idi. Panel yalnız lisans anahtarı satmıyor
 * (hesap, kod/hediye çeki, süreli hesap…) — kullanıcı geri bildirimi üzerine ad ve tüm sayaç
 * metinleri ürün tipine duyarlı hale getirildi (`lib/labels.itemCount`): liste tek tipse
 * "3 hesap", karışıksa nötr "3 kalem".
 *
 * ÜÇ SEKME: her sekmenin TEK işi var (bkz. `quarantine-tabs.tsx`). Eskiden "Bekleyenler"
 * sekmesinin içinde hem havuz hem de tüm ölü kalemleri gösteren defter vardı; sekme "1" derken
 * tablo 16 satır gösteriyordu ve operatör aradaki farkı anlayamıyordu.
 *
 * Durum · tarih aralığı · arama SUNUCU süzgecidir ve URL'de taşınır (`?status=&range=&from=&to=&q=`);
 * araç çubuğu "Tüm Kayıtlar" sekmesindedir. Süzgeç etkinken havuz da daralır → "Bildirilecekler"
 * sekmesi bunu açıkça söyler (sessiz eksik liste YOK).
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

  // "Bildirilecekler" = henüz bildirilmemiş. Yüklem SUNUCUDAKİ `claimed=none` süzgeciyle
  // BİREBİR aynı: fişte açık kaydı yoksa bekliyordur (reddedilen kalem havuza döndüğü için
  // yine `claimId` boş gelir — bilinçli, tek tanım).
  const pendingRows = rows.filter((r) => !r.claimId);
  const serverFiltered = hasQuarantineServerFilters(filters);

  return (
    <div>
      <PageHeader
        icon={ShieldOff}
        title="Kusurlu Stok"
        description="Arızalı bildirilen, değiştirilen veya geçersiz kılınan lisans/hesap kalemleri. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ; tedarikçiye değişim fişiyle bildirilir."
      />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <QuarantineTabs
          pendingCount={pendingRows.length}
          claimCount={claims.rows.length}
          ledgerCount={rows.length}
          pending={
            <PendingClaimsPanel
              rows={pendingRows}
              suppliers={suppliers}
              lastClaim={claims.rows[0] ?? null}
              serverFiltered={serverFiltered}
            />
          }
          claims={<ClaimsList rows={claims.rows} error={claims.error} />}
          ledger={
            <QuarantineTable
              rows={rows}
              truncated={truncated}
              limit={QUARANTINE_LIMIT}
              filters={filters}
            />
          }
        />
      )}
    </div>
  );
}
