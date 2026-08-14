/**
 * Mağaza SESSİZLİK (canlılık) eşiği — TEK KAYNAK.
 *
 * NEDEN AYRI DOSYA: aynı eşiği ÜÇ yer okur — (1) periyodik alarm taraması
 * (`site-silence.service.ts`), (2) site listesi, (3) site detayı (`sites.service.ts`).
 * Üçü ayrı ayrı hesaplasaydı panelde "sessiz" görünen bir site için alarm üretilmeyebilir
 * (ya da tersi) olurdu; bu projede "aynı kavramın iki tanımı" defalarca gerçek hataya yol
 * açtı (bkz. parti sayaçları, "atanabilir stok"). Yüklem TEK yerde: `isSiteSilent`.
 *
 * Nest DI (ConfigService) BİLEREK kullanılmıyor: `SitesService` şu an (db, crypto) ile
 * elle new'lenerek test ediliyor (birçok test dosyası) ve zorunlu üçüncü bir ctor argümanı
 * hepsini kırardı. `sweep-alarm.service.ts` de aynı sebeple env'i doğrudan okur — mevcut
 * desen korunuyor (ConfigService zaten process.env'i okur, davranış aynıdır).
 */

/**
 * Varsayılan sessizlik eşiği (saat). CÖMERT seçildi: normal bir mağaza panele saatler
 * içinde birçok imzalı istek gönderir (sipariş push, katalog senkronu, günlük heartbeat).
 * 24 saat, "mağaza gerçekten susmuş" demek için güvenli bir alt sınırdır; daha kısa bir
 * eşik düşük hacimli/az trafikli mağazalarda yanlış alarm üretir ve alarm körlüğü yaratır
 * (bu panelde bildirim kanalı Telegram'a da düşer). Env: `SITE_SILENCE_HOURS`.
 */
export const SITE_SILENCE_DEFAULT_HOURS = 24;

/**
 * Eşiği çözer: `SITE_SILENCE_HOURS` geçerli pozitif tamsayıysa onu, aksi hâlde varsayılanı
 * döndürür (boş string dâhil — docker-compose `${VAR:-}` boş geçirebilir).
 */
export function resolveSilenceHours(): number {
  const raw = process.env.SITE_SILENCE_HOURS;
  if (raw === undefined || raw.trim() === '') return SITE_SILENCE_DEFAULT_HOURS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : SITE_SILENCE_DEFAULT_HOURS;
}

/**
 * "Bu site sessiz mi?" — alarm taramasının SQL yüklemiyle BİREBİR aynı kural:
 *
 *   status = 'active'  AND  last_seen_at IS NOT NULL  AND  last_seen_at < now() - eşik
 *
 * - `status !== 'active'`: askıya alınmış sitenin susması BEKLENEN durumdur (HMAC auth zaten
 *   reddediliyor) → alarm da rozet de üretilmez.
 * - `lastSeenAt === null`: mağaza panele HİÇ imzalı istek göndermemiş → bu bir KESİNTİ değil,
 *   tamamlanmamış KURULUMDUR. Alarm konusu yapılmaz (yeni site her gün alarm üretmesin);
 *   ekranda ayrı bir "hiç bağlanmadı" durumu olarak gösterilir.
 */
export function isSiteSilent(
  lastSeenAt: Date | string | null | undefined,
  status: string,
  hours: number,
  now: number = Date.now(),
): boolean {
  if (status !== 'active') return false;
  if (!lastSeenAt) return false;
  const t = lastSeenAt instanceof Date ? lastSeenAt.getTime() : new Date(lastSeenAt).getTime();
  if (Number.isNaN(t)) return false;
  return now - t > hours * 3_600_000;
}
