import { ShieldOff } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card } from '../../components/ui/card';
import { QuarantineNav } from '../../components/claims/quarantine-nav';
import { PendingClaimsPanel } from '../../components/claims/claims-panel';
import {
  fetchQuarantine,
  hasQuarantineServerFilters,
  parseQuarantineFilters,
  QUARANTINE_POOL_LIMIT,
} from './queries';
import { fetchClaims, fetchSuppliersLite } from './claims-queries';
import { itemCount } from '../../lib/labels';

export const dynamic = 'force-dynamic';

/**
 * KUSURLU STOK › BİLDİRİLECEKLER (§2/§3/§12) — kusur havuzu, yani İŞ LİSTESİ.
 *
 * ADLANDIRMA: ekran eskiden "Kusurlu Anahtarlar" idi. Panel yalnız lisans anahtarı satmıyor
 * (hesap, kod/hediye çeki, süreli hesap…) — kullanıcı geri bildirimi üzerine ad ve tüm sayaç
 * metinleri ürün tipine duyarlı hale getirildi (`lib/labels.itemCount`): liste tek tipse
 * "3 hesap", karışıksa nötr "3 kalem".
 *
 * ÜÇ SEKME → ÜÇ ROTA: bu ekran eskiden tek sayfada `Tabs` ile üç görünüm taşıyordu. Gerekçeler
 * `components/claims/quarantine-nav.tsx` jsdoc'unda (kırık breadcrumb → `/quarantine/claims`
 * 404, her açılışta üç sorgu, havuzun defterin JS süzgeci olması). Bu sayfa artık YALNIZ havuzu
 * çeker: `claimed=none` SUNUCU süzgeci → defterin 5000'lik penceresine bağımlı değil.
 *
 * SÜZGEÇ: durum/tarih/arama araç çubuğu "Tüm Kayıtlar" bölümündedir. Bu sayfa yine de aynı URL
 * parametrelerini OKUR (dışarıdan gelen derin bağlantı — ör. `?status=voided` — çalışsın diye);
 * etkinse havuzun daraldığı açıkça söylenir (sessiz eksik liste YOK).
 */
export default async function QuarantinePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const filters = parseQuarantineFilters(await searchParams);
  const [{ rows, error, truncated }, claims, suppliers] = await Promise.all([
    // Havuz = "henüz hiçbir açık fişte olmayan" kusurlu kalemler. Yüklem SUNUCUDA (`claimed=none`).
    // PENCERE DAR (perf): bu ekran satırları yalnız sayaç + parti başına ilk 50 kalem için
    // kullanıyor; 5000 kayıt çekmek sunucuda binlerce gereksiz şifre çözümü demekti. Kırpma
    // gizlenmez — `truncated` uyarısı aşağıdaki panelde bu sayıyla yazılır.
    fetchQuarantine({ ...filters, claimed: 'none' }, { limit: QUARANTINE_POOL_LIMIT }),
    // Fiş listesi YALNIZ "son kesilen fiş: KOD · tarih" damgası için (kullanıcı isteğiydi:
    // "gün sonunda son raporun tarihini göreyim"). API'de tek-satır ucu yok; liste zaten
    // `createdAt desc` sıralı ve snapshot taşımaz (hafif) — yalnız `rows[0]` okunur.
    fetchClaims(),
    // Fiş kesme Sheet'inin tedarikçi seçicisi. Hata YUTULMAZ: boş liste ile "alınamadı"
    // ayrı gösterilir (ön-seçili tedarikçi combobox'ta görünmediğinde sebebi yazılı olsun).
    fetchSuppliersLite(),
  ]);

  const serverFiltered = hasQuarantineServerFilters(filters);
  const kinds = rows.map((r) => r.productKind);

  return (
    <div>
      <PageHeader
        icon={ShieldOff}
        title="Kusurlu Stok"
        description={
          error
            ? 'Arızalı bildirilen, değiştirilen veya geçersiz kılınan kalemlerin tedarikçiye bildirilmeyi bekleyen havuzu.'
            : `Tedarikçiye bildirilmeyi bekleyen ${itemCount(rows.length, kinds)}. Bu kalemler müşteriye TEKRAR TESLİM EDİLMEZ; değişim fişiyle tedarikçiye bildirilir.`
        }
      />
      <QuarantineNav />
      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API&apos;ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <PendingClaimsPanel
          rows={rows}
          suppliers={suppliers.rows}
          suppliersError={suppliers.error}
          lastClaim={claims.rows[0] ?? null}
          serverFiltered={serverFiltered}
          truncated={truncated}
          limit={QUARANTINE_POOL_LIMIT}
        />
      )}
    </div>
  );
}
