/**
 * Dağıtım kuyruğu (`deployments`) penceresi — İSTEMCİ TARAFI DÜRÜSTLÜĞÜ.
 *
 * TEK KUYRUK, ÇOK HEDEF: panel dağıtımı (`api`/`admin`), eklenti yayını (`plugin`) ve DR
 * işleri (`backup`, `backup-drill`) AYNI tabloda durur — "aynı anda tek aktif iş" güvencesi
 * bu yüzden hepsini birden kapsıyor.
 *
 * SORUN: `GET /v1/admin/deployments` bir `target` süzgeci KABUL ETMEZ ve sabit `limit=50`
 * ile YALNIZ en yeni 50 satırı döndürür. `/releases` ise bu 50 satırın içinden `plugin`
 * olanları ayıklıyor. Gecelik yedek cron'u her gün en az bir `backup` satırı yazdığı için
 * pencere zamanla tamamen yedek kayıtlarıyla dolar → ~50 gün sonra `/releases`, geçmişte
 * gerçekten yapılmış yayınlar dururken "Henüz yayın işi yok" der. Bu, bu kod tabanının
 * tekrar tekrar yakaladığı SESSİZ KIRPMA sınıfıdır ("o kayıt yok" yanılgısı).
 *
 * TODO(api): `GET /v1/admin/deployments` `?target=`/`?limit=` kabul etmeli; o zaman bu
 * yardımcı yalnız sıralama/kırpma için kalır ve `windowSaturated` daima false olur.
 * API bu işin kapsamı dışında olduğu için burada YAPILABİLECEK EN İYİSİ uygulanır:
 * kırpma tespit edilir ve ekranda AÇIKÇA söylenir (sessizce boş liste gösterilmez).
 */

/** API'nin `DeploymentsService.list(limit = 50)` varsayılanı — süzgeç yok, sabit pencere. */
export const DEPLOYMENTS_WINDOW = 50;

export interface TargetJobs<T> {
  /** Pencerede bulunan, hedefe ait işler (en yeni önce; `take` kadar). */
  jobs: T[];
  /**
   * Yanıt pencereyi DOLDURDU mu. true ise "bu hedefin daha eski işleri pencerenin
   * dışında kalmış olabilir" demektir — ekran "hepsi bu kadar" DEMEMELİDİR.
   *
   * Yanlış-pozitif mümkündür (tam 50 kayıt varsa uyarı boşuna çıkar); eksik listeyi
   * sessizce doğru göstermekten iyidir — `CLAIM_LIST_LIMIT` ile aynı gerekçe.
   */
  windowSaturated: boolean;
}

/**
 * Tek kuyruktan bir hedefin işlerini ayıklar ve pencerenin dolup dolmadığını bildirir.
 * Sıralama API'den gelir (`created_at desc`) — burada YENİDEN SIRALANMAZ (ikinci bir
 * sıralama tanımı, aynı verinin iki farklı sırasını üretme riskidir).
 */
export function pickJobsByTarget<T extends { target: string }>(
  rows: T[],
  target: string,
  take: number,
  window: number = DEPLOYMENTS_WINDOW,
): TargetJobs<T> {
  const all = Array.isArray(rows) ? rows : [];
  return {
    jobs: all.filter((r) => r.target === target).slice(0, take),
    windowSaturated: all.length >= window,
  };
}
