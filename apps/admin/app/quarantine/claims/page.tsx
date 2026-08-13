import { FileText, ShieldAlert } from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Alert, AlertDescription } from '../../../components/ui/alert';
import { QuarantineNav } from '../../../components/claims/quarantine-nav';
import { ClaimsList } from '../../../components/claims/claims-panel';
import { CLAIM_LIST_LIMIT, fetchClaims } from '../claims-queries';

export const dynamic = 'force-dynamic';

/**
 * KUSURLU STOK › DEĞİŞİM FİŞLERİ (§12) — kesilen fişler ve tedarikçi yanıtlarının takibi.
 *
 * NEDEN AYRI ROTA (kırık breadcrumb): fiş detayının breadcrumb'ı ("Kusurlu Stok › Değişim
 * Fişleri › Detay") ara segmente Link basar (`shell/site-header.tsx` son-olmayan segmentleri
 * linkler) ama `/quarantine/claims` bir sayfa DEĞİLDİ → operatör 404 alıyordu. Bu, projede
 * `/products`'ta bire bir yaşanan hata sınıfı; bu sayfa onu kapatır.
 *
 * YALNIZ KENDİ VERİSİNİ ÇEKER: karantina defteri (en ağır sorgu) burada koşmaz.
 */
export default async function ClaimsPage() {
  const { rows, error, truncated } = await fetchClaims();

  return (
    <div>
      <PageHeader
        icon={FileText}
        title="Değişim Fişleri"
        description={
          error
            ? 'Tedarikçiye kesilen değişim fişleri ve kalem kalem yanıtları.'
            : `Tedarikçiye kesilen ${rows.length.toLocaleString('tr-TR')} değişim fişi — durumları ve kalem kalem yanıtlarıyla. Fişi açıp raporu indirir, tedarikçiden gelen sonucu işlersiniz.`
        }
      />
      <QuarantineNav />

      {/* DÜRÜST KIRPMA: API bu listeyi sabit 500 satırla kesiyor ve bir bayrak döndürmüyor.
          Uç DÜZELTİLMEDİ (kapsam dışı) — tavana dayanıldığı ekranda açıkça söylenir. */}
      {truncated && (
        <Alert variant="warning" className="mb-4">
          <ShieldAlert aria-hidden />
          <AlertDescription>
            Liste sunucu üst sınırına ({CLAIM_LIST_LIMIT.toLocaleString('tr-TR')} fiş) dayandı —
            daha eski fişler burada GÖRÜNMÜYOR olabilir. Aradığınız fişi bulamazsanız fiş
            numarasıyla arayın (Ctrl+K) ya da ilgili tedarikçinin sayfasından gidin.
          </AlertDescription>
        </Alert>
      )}

      <ClaimsList rows={rows} error={error} />
    </div>
  );
}
