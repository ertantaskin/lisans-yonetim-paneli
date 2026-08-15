import Link from 'next/link';
import { Globe, Plus, PlugZap, TriangleAlert } from 'lucide-react';
import { apiGet } from '../../lib/api';
import { Card } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { fmtDateTime, relativeTime } from '../../lib/utils';
import { isOwner } from '../../lib/session';
import { SitesTable, type SiteListRow } from '../../components/sites-table';

export const dynamic = 'force-dynamic';

/**
 * Liste satırı + CANLILIK alanları (0040). Üçü de OPSİYONEL okunur: api ve admin AYRI
 * imajlardır, sürüm sapmasında gelmeyebilirler → o durumda canlılık bandı HİÇ çizilmez
 * ("bilinmiyor"u "sessiz" sanıp yanlış alarm basmaktan iyidir).
 *
 * `silent` kararı SUNUCUDAN gelir: eşik (SITE_SILENCE_HOURS) yalnız API'de tanımlıdır ve
 * periyodik alarmın SQL yüklemiyle birebir aynı kuraldan üretilir. Burada yeniden
 * hesaplasaydık panelin "sessiz" dediği küme ile alarm üretilen küme sessizce ayrışırdı.
 */
type SiteLivenessRow = SiteListRow & {
  /** Mağazadan gelen SON imzalı isteğin zamanı (ISO). null = hiç bağlanmadı. */
  lastSeenAt?: string | null;
  /** Eşiği aşan sessizlik mi (yalnız aktif + en az bir kez bağlanmış siteler). */
  silent?: boolean;
  /** Kararın dayandığı eşik (saat) — metni uydurmamak için sunucudan gelir. */
  silenceThresholdHours?: number;
};

/** relativeTime 'az önce' de dönebilir → "az önce önce" yazmamak için tek yerde toparlanır. */
function agoText(iso: string): string {
  const rel = relativeTime(iso);
  return rel === 'az önce' ? rel : `${rel} önce`;
}

export default async function SitesPage() {
  // SiteListRow = SiteRow + bağlantı sağlığı alanları (pluginVersion/pluginVersionAt, 0028).
  // API bunları zaten döndürüyor (toPublicSite sır olmayan kolonları geçirir); tip tarafında
  // opsiyonel okunur → alan gelmezse kolon "—" gösterir, uydurma değer basılmaz.
  let sites: SiteLivenessRow[] = [];
  let error: string | null = null;
  try {
    sites = await apiGet<SiteLivenessRow[]>('/v1/admin/sites');
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  /*
   * RBAC GÖRÜNÜRLÜĞÜ (§8): "Secret Yenile" ve "Askıya Al" sunucu aksiyonlarında `isOwner()` ile
   * korunuyor; owner-olmayan operatör onayı geçtikten SONRA "yetkiniz yok" alıyordu. Karar
   * SUNUCUDA verilip istemciye SERİLEŞTİRİLEBİLİR bir boolean olarak geçilir (fonksiyon prop'u
   * çalışma anında hata sınırına düşürür) — /sites/new sayfa kapısının satır-içi karşılığı.
   */
  const canOwner = await isOwner();

  // SESSİZ mağazalar: en uzun süredir susan başta (operatörün ilk bakacağı satır).
  const silent = sites
    .filter((s) => s.silent === true)
    .sort((a, b) => (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? ''));
  // Hiç bağlanmamış siteler ALARM DEĞİLDİR (kurulum aşaması) ama görünür olmalı — aksi hâlde
  // yarım kalmış bir kurulum panelde hiçbir iz bırakmaz.
  const neverConnected = sites.filter(
    (s) => s.lastSeenAt === null && s.status === 'active' && s.silent !== undefined,
  );
  const thresholdHours = sites.find((s) => s.silenceThresholdHours != null)?.silenceThresholdHours;

  return (
    <div>
      <PageHeader icon={Globe} title="Siteler" description="Her satış kanalı (mağaza / pazar yeri / bayi) bir tenant.">
        <Button asChild>
          <Link href="/sites/new">
            <Plus /> Yeni Site (Sihirbaz)
          </Link>
        </Button>
      </PageHeader>

      {error ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">API'ye ulaşılamadı: {error}</p>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* CANLILIK BANDI — bu panelin günlerce fark edemediği kesinti sınıfı buradan görünür:
              mağaza panele imzalı istek göndermeyi bıraktığında hiçbir ekran bunu söylemiyordu
              ("aktif" rozeti yalnız 'askıya alınmadı' demek). */}
          {silent.length > 0 && (
            <Alert variant="warning">
              <TriangleAlert />
              <div className="min-w-0 flex-1">
                <AlertTitle>
                  {silent.length} mağaza sessiz — panele yeni imzalı istek göndermiyor
                </AlertTitle>
                <AlertDescription>
                  <p className="mb-2">
                    {thresholdHours != null
                      ? `Son ${thresholdHours} saattir istek gelmedi.`
                      : 'Eşik süresince istek gelmedi.'}{' '}
                    Eklenti devre dışı kalmış, panel adresi/anahtarı değişmiş ya da mağaza
                    erişilemez olabilir. Sipariş push ve katalog senkronu da durmuş olabilir.
                  </p>
                  <ul className="space-y-1">
                    {silent.map((s) => (
                      <li key={s.id} className="flex flex-wrap items-baseline gap-x-2">
                        <Link
                          href={`/sites/${s.id}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {s.domain}
                        </Link>
                        {s.lastSeenAt && (
                          <span className="text-xs text-foreground/70" title={fmtDateTime(s.lastSeenAt)}>
                            son görülme: {agoText(s.lastSeenAt)}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </div>
            </Alert>
          )}

          {neverConnected.length > 0 && (
            <Alert variant="muted">
              <PlugZap />
              <div className="min-w-0 flex-1">
                <AlertTitle>
                  {neverConnected.length} site panele hiç bağlanmadı (kurulum tamamlanmamış)
                </AlertTitle>
                <AlertDescription>
                  {/* Bu bir KESİNTİ değil → alarm üretilmez; yalnız görünür kılınır. */}
                  <p>
                    {neverConnected.map((s) => s.domain).join(', ')} — eklenti kurulup bağlan kodu
                    girilene kadar bu sitelerden sipariş gelmez.
                  </p>
                </AlertDescription>
              </div>
            </Alert>
          )}

          <SitesTable sites={sites} canOwner={canOwner} />
        </div>
      )}
    </div>
  );
}
