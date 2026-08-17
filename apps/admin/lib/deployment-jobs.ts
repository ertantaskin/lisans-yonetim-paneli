/**
 * Dağıtım kuyruğu (`deployments`) penceresi — PENCERE DÜRÜSTLÜĞÜ.
 *
 * TEK KUYRUK, ÇOK HEDEF: panel dağıtımı (`api`/`admin`), eklenti yayını (`plugin`) ve DR
 * işleri (`backup`, `backup-drill`) AYNI tabloda durur — "aynı anda tek aktif iş" güvencesi
 * bu yüzden hepsini birden kapsıyor.
 *
 * ÇÖZÜLEN ARIZA (eskiden): `GET /v1/admin/deployments` bir `target` süzgeci KABUL ETMİYOR ve
 * sabit `limit=50` ile yalnız en yeni 50 satırı döndürüyordu. `/releases` bu 50 satırın
 * içinden `plugin` olanları AYIKLIYORDU; gecelik yedek cron'u her gün en az bir `backup`
 * satırı yazdığı için pencere ~50 günde tamamen yedek kayıtlarıyla dolar → geçmişte gerçekten
 * yapılmış yayınlar dururken ekran "Henüz yayın işi yok" derdi (bu kod tabanının tekrar tekrar
 * yakaladığı SESSİZ KIRPMA sınıfı). Uç artık `?target=`/`?limit=` kabul ediyor → süzgeç
 * SUNUCUDA uygulanır ve pencere hedef BAŞINA dolar; başka hedeflerin gürültüsü yer kaplamaz.
 *
 * `pickJobsByTarget` istemci-taraflı süzme için KALDI: ekran bir kez daha karışık bir listeyi
 * bölmek isterse (ya da eski bir API imajına denk gelirse) davranış aynı ve `windowSaturated`
 * hâlâ dürüst bir kırpma sinyali verir.
 */

/** API'nin `DeploymentsService.list()` varsayılan penceresi (süzgeç verilmezse). */
export const DEPLOYMENTS_WINDOW = 50;

/** Ucun kabul ettiği üst sınır (`limit` bunun üstüne çıkarsa sunucu kırpar). */
export const DEPLOYMENTS_MAX_LIMIT = 200;

/**
 * `?target=` sorgu parçası üretir. Hedefler API whitelist'inden gelmelidir; whitelist DIŞI
 * bir değer sunucuda 400 verir (sessizce yok sayılıp "bu hedefin işi yok" yalanı söylenmez).
 */
export function targetQuery(targets: readonly string[], limit?: number): string {
  const params = new URLSearchParams();
  if (targets.length > 0) params.set('target', targets.join(','));
  if (limit !== undefined) params.set('limit', String(limit));
  const s = params.toString();
  return s === '' ? '' : `?${s}`;
}

export interface TargetJobs<T> {
  /** Hedefe ait işler (en yeni önce; `take` kadar). */
  jobs: T[];
  /**
   * Yanıt pencereyi DOLDURDU mu. true ise "bu hedefin daha eski işleri pencerenin
   * dışında kalmış olabilir" demektir — ekran "hepsi bu kadar" DEMEMELİDİR.
   *
   * Yanlış-pozitif mümkündür (tam pencere kadar kayıt varsa uyarı boşuna çıkar); eksik
   * listeyi sessizce doğru göstermekten iyidir — `CLAIM_LIST_LIMIT` ile aynı gerekçe.
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
