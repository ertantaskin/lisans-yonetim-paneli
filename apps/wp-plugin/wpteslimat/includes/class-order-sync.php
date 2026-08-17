<?php
if (!defined('ABSPATH')) exit;

/**
 * Sipariş senkronu (§2, §7): Woo siparişi processing/completed olunca panele push.
 * Panel atomik atama yapar; assignment referansı order meta'ya yazılır.
 * Lisans verisi WP'de TUTULMAZ.
 */
class Wpteslimat_Order_Sync {
    private static $instance = null;
    /** Re-entrancy guard: resync sırasındaki save() zinciri kendini tetiklemesin (#16). */
    private static $syncing = false;

    /**
     * (GECİKME) Aynı istekte, YANIT MÜŞTERİYE GÖNDERİLDİKTEN SONRA çalıştırılacak işler.
     * Anahtar "hook|order_id" → [metot, AS argüman dizisi, hook]. Aynı (hook, sipariş) çifti bir
     * istekte yalnız BİR KEZ kaydedilir (checkout'ta birden çok durum geçişi ateşlenebilir).
     * (G1) Argüman dizisi ve hook SAKLANIR: iş bitince kuyruktaki ikizi as_unschedule_action ile
     * BİREBİR aynı argümanlarla düşürülür.
     */
    private static $after_response_jobs = [];
    /** 'shutdown' hook'una istek başına yalnız BİR KEZ bağlan. */
    private static $after_response_hooked = false;
    /** (F10) Sınıra takılıp satır-içi koşulMAYAN iş sayısı (Action Scheduler devralır) — yalnız log. */
    private static $after_response_deferred = 0;

    /**
     * (F10) Bir İSTEKTE satır-içi koşulacak EN FAZLA iş sayısı. WooCommerce yönetim ekranındaki
     * toplu durum değiştirme (ör. 50 siparişi "tamamlandı" yapma) tek istekte onlarca iş kaydeder;
     * her iş bir panel HTTP çağrısıdır → tek PHP işçisi dakikalarca meşgul kalır ve FPM havuzu
     * tükenir. Sınırın üstündeki işler ZATEN kuyrukta olan Action Scheduler işine bırakılır
     * (iş KAYBOLMAZ, yalnız birkaç saniye/dakika gecikir).
     */
    const AFTER_RESPONSE_MAX_JOBS = 3;

    /**
     * (G5) BAĞLANTIYI KAPATAMAYAN SAPI (ne fastcgi_finish_request ne litespeed_finish_request —
     * ör. mod_php/Apache) için AYRI sınırlar. O dalda istek, işler bitene kadar tarayıcıya AÇIK
     * kalır: 3 iş × 5sn + set_time_limit(20) checkout sekmesini 15-20sn "yükleniyor" bırakabilirdi
     * (eski yorumdaki "birkaç yüz ms" yalnız MUTLU YOL için doğruydu). Bu dalda:
     *   - tek iş (MAX_JOBS_BLOCKING),
     *   - 2sn panel timeout (HTTP_TIMEOUT_BLOCKING),
     *   - yalnız KRİTİK iş (push/revoke) satır-içi koşar; resync/refund Action Scheduler'a kalır
     *     (birkaç saniye gecikme kabul edilebilir — teslimat gecikmesi DEĞİL, uzlaştırma gecikmesi).
     */
    const AFTER_RESPONSE_MAX_JOBS_BLOCKING = 1;
    const INLINE_CRITICAL_METHODS = ['push', 'revoke'];

    /**
     * (F10/#98) Satır-içi yolda panel HTTP çağrısı için KISA zaman aşımı (sn). Varsayılan 15sn
     * yerine 5sn: satır-içi yol PHP işçisini meşgul tutar ve bağlantıyı kapatamayan SAPI'lerde
     * (mod_php) isteği uzatır. Ölçülen panel yanıt süresi ~15 ms → 5sn fazlasıyla yeterli.
     * Zaman aşımına uğrayan çağrı bugünkü davranışla aynı şekilde retry planlar; ayrıca AS
     * güvenlik ağı işi tam timeout'la (15sn) yeniden dener.
     */
    const INLINE_HTTP_TIMEOUT = 5;
    /** (G5) Bağlantı kapatılamayan SAPI'de daha da kısa timeout — istek müşteriyi bekletiyor. */
    const INLINE_HTTP_TIMEOUT_BLOCKING = 2;

    /** (F10) İş başına PHP zaman sınırı (sn) — takılan tek çağrı işçiyi süresiz tutmasın. */
    const INLINE_TIME_LIMIT = 20;
    /** (G5) Bağlantı kapatılamayan SAPI'de üst sınır: 1 iş × 2sn timeout → 6sn fazlasıyla yeter. */
    const INLINE_TIME_LIMIT_BLOCKING = 6;

    /**
     * (F2/G2) İş kilidi TTL (sn): süreç fatal error ile ölse bile kilit en fazla bu kadar takılı
     * kalır; sonraki koşum bayat kilidi devralır.
     *
     * (G2) 300 → 60: TTL, Action Scheduler'ın GECİKME PENCERESİNİN (ölçülen 12-75sn) ALTINDA
     * olmalıdır. Aksi halde satır-içi koşum fatal alıp kilidi takılı bıraktığında AS güvenlik ağı
     * kilidi "taze" görüp işi atlıyor, sipariş panele HİÇ gitmiyordu (kilit bir MUTEX'tir; güvenlik
     * ağını yutmamalıdır). Kilit yalnız GERÇEK eşzamanlılığı kapatır: satır-içi tüm iş döngüsü
     * en fazla ~20sn sürer (bkz. INLINE_TIME_LIMIT), yani 60sn hâlâ geniş bir marjdır.
     */
    const JOB_LOCK_TTL = 60;

    /**
     * (G2) Kilit MEŞGULken işi kaç saniye sonraya yeniden planlarız. TTL ile eşit: kilidi tutan
     * süreç ölmüşse yeniden planlanan koşum kilidi BAYAT bulup devralır; süreç sağlıklıysa işi
     * çoktan bitirmiştir ve "yapıldı" işareti yeniden planlanan koşumu susturur (bkz. mark_done).
     */
    const JOB_RESCHEDULE_DELAY = 60;

    /**
     * (G1) "Yapıldı" işareti (transient) — kilit IDEMPOTENCY DEĞİL, yalnız MUTEX'tir: satır-içi iş
     * biter, kilit açılır, 15-75sn sonra koşan AS işi kilidi BOŞ bulup AYNI işi baştan koşar.
     * push/revoke kalıcı meta ile korunur ama resync/refund korunmuyordu → panele ikinci POST +
     * siparişe yanıltıcı ikinci not. Birincil savunma as_unschedule_action'dır (kuyrukta BEKLEYEN
     * ikizi düşürür); bu işaret İKİNCİL savunmadır — AS işi zaten "running" durumdaysa kuyruktan
     * düşürülemez, o iş kilide takılır ve kendini yeniden planlar (G2).
     *
     * KRİTİK: bu işaret YALNIZCA `wpteslimat_recheck` (kilit meşgul olduğu için ertelenmiş güvenlik-ağı
     * koşumu) tarafından TÜKETİLİR. Normal iş hook'ları (async/retry/satır-içi) işarete HİÇ bakmaz →
     * MEŞRU bir yeniden tetik (ör. operatör kalemleri tekrar düzenledi, ikinci kısmi iade girdi) ASLA
     * yutulmaz. İş KAYBI, mükerrer POST'tan çok daha kötüdür.
     *
     * TTL kayıt temizliği içindir; işaret TEK SEFERLİK tüketilir ve yalnız TAZE ise (≤ WINDOW) recheck'i
     * susturur — pencere, erteleme (60sn) + AS gecikmesini (≤75sn) kapsar; daha eski bir işaret
     * "bu iş gerçekten şimdi bitti" kanıtı sayılmaz ve recheck GÜVENLİ yönde (koşarak) davranır.
     */
    const DONE_MARKER_TTL = 300;
    const DONE_MARKER_WINDOW = 180;

    /**
     * (§4) Başarısız panel çağrısının tekrar deneme basamakları (saniye): 1dk → 5dk → 30dk, SONRA DUR.
     *
     * NEDEN sayaç + üst sınır + backoff: eskiden her başarısızlık SABİT 300sn sonra KOŞULSUZ yeniden
     * planlanıyordu ve zincirin sonu YOKTU. Panel kalıcı olarak reddediyorsa (panelde `rotate-secret`
     * yapılıp wp-config güncellenmediyse 401, ya da sunucu saati kaydığı için imza penceresi dışına
     * düşüldüyse) durum ASLA 2xx olmaz → etkilenen HER sipariş için günde ~288 sipariş notu, 288
     * zamanlanmış eylem ve 288 kuyruk log satırı üretiliyordu (sipariş ekranı okunamaz hale gelir,
     * DB ve AS kuyruğu şişer). Sözleşme (§4: "5xx → 1dk/5dk/30dk retry") zaten SONLU bir zinciri
     * tarif ediyordu ve kodun kendi yorumu da bunu söylüyordu — sapan taraf uygulamaydı.
     */
    const RETRY_DELAYS = [60, 300, 1800];

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // PERFORMANS (denetim bulgusu): panel HTTP çağrıları checkout/status-geçişi/admin isteğini
        // 15sn'ye kadar BLOKLAMASIN → status hook'ları işi doğrudan çalıştırmak yerine ARKA PLANA
        // (Action Scheduler) alır; asıl push/revoke/resync arka plan işinde koşar. AS yoksa (nadir —
        // WooCommerce AS taşır) senkron fallback ile eski davranış korunur. Idempotency
        // (_wpteslimat_pushed/_revoked) + klon guard'ı iş işleyicilerinde aynen geçerli.
        // GECİKME (ölçüldü: AS işleri 12-75sn sonra koşuyordu): AS güvenlik ağı olarak KORUNUR,
        // ama iş ayrıca aynı istekte YANIT GÖNDERİLDİKTEN SONRA koşturulur → bkz. after_response().
        add_action('woocommerce_order_status_processing', [$this, 'enqueue_push'], 10, 1);
        add_action('woocommerce_order_status_completed', [$this, 'enqueue_push'], 10, 1);
        // İade/iptal → panelde lisansı geri al (§2: iade edilen key satışta CANLI kalmaz).
        add_action('woocommerce_order_status_refunded', [$this, 'enqueue_revoke'], 10, 1);
        add_action('woocommerce_order_status_cancelled', [$this, 'enqueue_revoke'], 10, 1);
        // (#16) Sipariş kalemleri düzenlenip kaydedilince (yalnız item değişimi) — daha önce
        // panele iletilmiş siparişi güncel adetlerle yeniden uzlaştır. Guard sonsuz döngüyü keser.
        add_action('woocommerce_saved_order_items', [$this, 'enqueue_resync'], 20, 2);
        // (§2/§7) KISMİ iade → yalnız iade edilen birimleri geri al. woocommerce_order_refunded
        // hem kısmi hem tam iadede ateşlenir; sync_refund tam iadeyi (net=0) mevcut revoke yoluna
        // devreder, kısmiyi satır-bazlı refund ucuna gönderir.
        add_action('woocommerce_order_refunded', [$this, 'enqueue_refund'], 20, 2);

        // Arka plan iş işleyicileri (Action Scheduler async) — asıl panel çağrısı burada koşar.
        // 2. argüman = işi TETİKLEYEN mağaza yöneticisi (yoksa ''). Aktör İŞE BAĞLIDIR; siparişte
        // kalıcı meta olarak TUTULMAZ (bkz. enqueue_or_run). Eski (yükseltme öncesi) kuyrukta
        // bekleyen tek-argümanlı işler varsayılan '' ile sorunsuz koşar.
        add_action('wpteslimat_async_push', [$this, 'push'], 10, 2);
        add_action('wpteslimat_async_revoke', [$this, 'revoke'], 10, 2);
        add_action('wpteslimat_async_resync', [$this, 'resync_items'], 10, 2);
        add_action('wpteslimat_async_refund', [$this, 'sync_refund'], 10, 2);

        // (G2) GÜVENLİK AĞI yeniden koşumu: iş kilidi meşgul olduğu için atlanan koşum bu hook ile
        // ertelenir (bkz. reschedule_locked_job). AYRI bir hook olması ŞART — böylece "yapıldı"
        // işareti YALNIZ bu yolda tüketilir ve meşru yeni tetikler asla susturulmaz (bkz. recheck).
        add_action('wpteslimat_recheck', [$this, 'recheck'], 10, 3);

        // Retry (başarısız işlerin tekrarı; Action Scheduler yoksa wp-cron). Aktör tekrar denemeye
        // de taşınır → 30dk sonra koşan iş hâlâ DOĞRU kişiyi gösterir.
        add_action('wpteslimat_retry_push', [$this, 'push'], 10, 2);
        add_action('wpteslimat_retry_revoke', [$this, 'revoke'], 10, 2);
        add_action('wpteslimat_retry_refund', [$this, 'sync_refund'], 10, 2);
        // (denetim) resync'in tekrar denemesi EKSİKTİ: kalem düzenlemesi panele iletilemediğinde
        // (panel kapalı/ağ hatası) hiçbir not, hiçbir tekrar deneme yoktu → panel ESKİ adette kalıyor
        // ve operatör bunu yalnız kuyruk log tablosuna bakarsa fark ediyordu. Adet DÜŞÜRÜLDÜYSE bu,
        // fazladan teslim edilmiş birimin geri alınmaması demektir (§2). Diğer üç iş gibi retry'lı.
        add_action('wpteslimat_retry_resync', [$this, 'resync_items'], 10, 2);

        // (§4) Kimlik doğrulama reddi (401/403) tekrar denemeyle DÜZELMEZ → yöneticiye görünür uyarı.
        add_action('admin_notices', [$this, 'auth_failure_notice']);
    }

    /**
     * Push'u arka plana al (checkout thank-you / status-geçişini bloklamaz). enqueue_or_run
     * çift-zamanlamayı ve gereksiz (yapılandırılmamış/klon) işleri eler.
     */
    public function enqueue_push($order_id) {
        $this->enqueue_or_run('wpteslimat_async_push', 'push', $order_id);
    }

    /** Revoke'u arka plana al (refund/cancel admin isteğini bloklamaz). */
    public function enqueue_revoke($order_id) {
        $this->enqueue_or_run('wpteslimat_async_revoke', 'revoke', $order_id);
    }

    /** Resync'i arka plana al. $syncing iken kısa devre → async resync'in save'i döngü açmaz. */
    public function enqueue_resync($order_id, $items = null) {
        if (self::$syncing) return;
        $this->enqueue_or_run('wpteslimat_async_resync', 'resync_items', $order_id);
    }

    /** Kısmi/tam iade uzlaştırmasını arka plana al (refund admin isteğini bloklamaz). */
    public function enqueue_refund($order_id, $refund_id = null) {
        $this->enqueue_or_run('wpteslimat_async_refund', 'sync_refund', $order_id);
    }

    /**
     * İşi Action Scheduler ile ASYNC kuyruğa alır; AS yoksa SENKRON çalıştırır (geriye dönük
     * davranış). Yapılandırılmamış veya klon ortamda hiç iş üretmez (kuyruk şişmesin; iş
     * işleyicileri de aynı guard'ları taşır → çift savunma). Aynı iş zaten beklemedeyse tekrar
     * eklemez (çift async çalıştırmayı önler; idempotency zaten çift çalışmayı zararsız kılar).
     */
    private function enqueue_or_run($hook, $method, $order_id) {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;

        /*
         * YENİ İŞ = YENİ ŞANS (denetim bulgusu — kalıcı sessizlik).
         *
         * `_wpteslimat_fail_<op>` yalnız 2xx ile temizleniyordu. Bir tekrar-deneme zinciri
         * tükendikten sonra AYNI iş için sonraki TÜM başarısızlıklar kalıcı olarak SESSİZ
         * kalıyordu: not yazılmıyor (note_once bayrağı 'yes'), yeni zincir planlanmıyor.
         * Somut sonuç (§2): haftalar sonra yapılan İKİNCİ bir kısmi iade panele iletilemezse
         * sipariş ekranında HİÇBİR iz kalmıyor ve müşterinin iade ettiği anahtarlar canlı
         * kalıyordu. Yeni bir iş tetiklendiğinde (yeni iş olayı = yeni ticari gerçek) sayaç
         * ve kalıcı hata izi sıfırlanır → o iş kendi zincirini ve kendi notunu alır.
         */
        $op = str_replace('wpteslimat_async_', '', $hook);
        $order = wc_get_order($order_id);
        if ($order) {
            $changed = false;
            foreach (['_wpteslimat_retry_' . $op, '_wpteslimat_fail_' . $op] as $meta) {
                if ($order->get_meta($meta) !== '') {
                    $order->delete_meta_data($meta);
                    $changed = true;
                }
            }
            if ($changed) $order->save();
        }

        // (§7 "kim yaptı") İşi TETİKLEYEN mağaza yöneticisi İŞİN KENDİSİNE bağlanır (Action
        // Scheduler argümanı). NEDEN kalıcı sipariş meta'sı DEĞİL (denetim bulgusu): meta bir kez
        // yazılıp hiç temizlenmiyordu; aynı sipariş sonradan ödeme geçidi webhook'u / cron gibi
        // OTURUMSUZ bir yolla iade-iptal edildiğinde sipariş notu ve panel audit'i o ESKİ kişiyi
        // "işlemi başlatan" gösteriyordu (yanlış izlenebilirlik). İşe bağlı aktör yalnız o işte
        // geçerlidir; oturumsuz tetikte '' kalır → hiçbir isim UYDURULMAZ.
        $actor = self::current_initiator();

        if (function_exists('as_enqueue_async_action')) {
            // (G1) Argüman dizisi TEK YERDE üretilir: AS argümanları serileştirip karşılaştırdığı için
            // dedupe (as_has_scheduled_action), kuyruğa alma (as_enqueue_async_action) ve İLERİDEKİ
            // kuyruktan düşürme (as_unschedule_action) BİREBİR aynı diziyi kullanmak ZORUNDADIR.
            $args = [$order_id, $actor];
            $already_queued = function_exists('as_has_scheduled_action')
                && as_has_scheduled_action($hook, $args, 'wpteslimat');
            if (!$already_queued) {
                // GÜVENLİK AĞI olarak AS işi AYNEN korunur: yanıt-sonrası satır-içi çalıştırma
                // herhangi bir nedenle koşmazsa (cron/CLI bağlamı, istek başına iş sınırı,
                // PHP fatal, istek yarıda kesildi) iş yine de kuyrukta durur ve retry'ı vardır.
                as_enqueue_async_action($hook, $args, 'wpteslimat');
            }
            // EK OLARAK aynı istekte, yanıt gönderildikten sonra işi hemen koş (bkz. after_response).
            // Zaten kuyrukta bekleyen bir iş olsa BİLE kaydederiz: amaç gecikmeyi ~0'a indirmektir.
            // (F2) İki koşumun ÇAKIŞMASI kısa ömürlü iş kilidiyle engellenir (bkz. run_locked);
            // (G1) satır-içi iş BİTTİKTEN sonra AS işi kuyruktan DÜŞÜRÜLÜR (kilit mutex'tir,
            // idempotency değildir) — eskiden resync/refund panele iki kez POST ediyordu.
            $this->after_response($hook, $method, $args);
        } else {
            // Action Scheduler yok (nadir) → senkron fallback: eski, bloklayan ama çalışan davranış.
            // Aynı istekte koştuğu için oturum zaten mevcuttur; aktörü yine de AÇIKÇA geçiririz ki
            // başarısızlıkta planlanan wp-cron retry'ı da doğru kişiyi taşısın (kalıcı meta gerekmez).
            $this->$method($order_id, $actor);
        }
    }

    /**
     * (GECİKME — ölçülmüş sorun) Action Scheduler işleri dev ortamında planlanmalarından
     * 12sn / 27sn / 30sn / 65sn / 75sn SONRA koşuyordu. Sebep: AS'in async loopback dispatch'i
     * güvenilir değil; iş pratikte wp-cron'un 'every_minute' → action_scheduler_run_queue
     * olayına düşüyor ve wp-cron ANCAK siteye bir sayfa isteği geldiğinde tetikleniyor. Trafiği
     * düşük mağazada bu "sipariş panele dakikalar sonra düştü" demek → operatörün gecikme şikâyeti.
     *
     * Çözüm: işi checkout/status isteğini BLOKLAMADAN, aynı PHP sürecinde ama YANIT MÜŞTERİYE
     * GÖNDERİLDİKTEN SONRA çalıştır. 'shutdown' hook'una EN GEÇ öncelikle (PHP_INT_MAX) bağlanırız;
     * WP kendi çıktı tamponlarını 'shutdown' önceliği 1'deki wp_ob_end_flush_all() ile boşaltır,
     * biz ondan SONRA koşarız (aksi halde sayfa çıktısı kırpılırdı).
     *
     * (#98) BAĞLANTI KAPATMA KATMANLI: fastcgi_finish_request() (PHP-FPM) → litespeed_finish_request()
     * (LiteSpeed/OpenLiteSpeed) → hiçbiri yok (mod_php). Eskiden fastcgi_finish_request yoksa satır-içi
     * yol HİÇ kaydedilmiyordu; mod_php (ör. wordpress:6-php8.2-apache) dahil çok yaygın kurulumlarda
     * gecikme düzeltmesi ETKİSİZ kalıyordu (ölçülen 12-75 sn gecikme aynen sürüyordu). Artık mod_php'de
     * de satır-içi koşarız: tamponlar boşaltıldığı için sayfa İÇERİĞİ tarayıcıya çoktan gitmiştir.
     *
     * (G5) ANCAK bağlantı kapatılamayan SAPI'de istek, işler bitene kadar AÇIK kalır (tarayıcı
     * "yükleniyor" gösterir) → o dalda sınırlar AYRILIR: tek iş + 2sn panel timeout + yalnız KRİTİK
     * iş (push/revoke); resync/refund Action Scheduler'a bırakılır. Böylece en kötü durum ~2-6sn'dir
     * (eskiden 3 iş × 5sn + set_time_limit(20) → 15-20sn olabiliyordu).
     * ignore_user_abort(true) ile istemci bağlantıyı kesse bile iş yarım kalmaz.
     */
    private function after_response($hook, $method, $args) {
        // (F10/#98) Bağlam kapısı: zaten arka plandaysak (cron/CLI) satır-içi koşuma HİÇ girme.
        if (!self::can_run_inline()) return;
        if (!method_exists($this, $method)) return;
        if (!is_array($args) || !isset($args[0])) return;

        // (G5) Bağlantı kapatılamıyorsa istek müşteriyi bekletir → yalnız KRİTİK iş satır-içi koşar.
        // Uzlaştırma işleri (resync/refund) zaten kuyrukta olan AS işine kalır (iş KAYBOLMAZ).
        if (!self::can_close_connection() && !in_array($method, self::INLINE_CRITICAL_METHODS, true)) {
            self::$after_response_deferred++;
            return;
        }

        $order_id = (int) $args[0];
        $key = $hook . '|' . $order_id;
        if (isset(self::$after_response_jobs[$key])) return;

        // (F10/G5) İstek başına satır-içi iş SINIRI — fazlası AS kuyruğunda bekleyen işe kalır.
        if (count(self::$after_response_jobs) >= self::max_inline_jobs()) {
            self::$after_response_deferred++;
            return;
        }

        // AS'e verilen argüman dizisini AYNEN saklarız: iş bitince as_unschedule_action ile
        // kuyruktaki ikizini düşürmek için BİREBİR aynı diziyi geçmek zorundayız (G1).
        self::$after_response_jobs[$key] = [$method, $args, $hook];

        if (!self::$after_response_hooked) {
            self::$after_response_hooked = true;
            add_action('shutdown', [$this, 'run_after_response_jobs'], PHP_INT_MAX);
        }
    }

    /**
     * (F10/#98/G3) Bu istekte satır-içi (yanıt-sonrası) koşum ANLAMLI mı?
     *
     * - CLI/WP-CLI: "yanıt" diye bir şey yok, istek kimseyi bekletmez → AS/senkron yol zaten yeterli.
     * - Cron (wp_doing_cron/DOING_CRON): zaten arka plan; AS işi orada koşacak.
     *
     * (G3) REST İSTEKLERİ ARTIK DIŞLANMAZ. Eskiden `REST_REQUEST` topluca "arka plan" sayılıyordu;
     * bu YANLIŞTI: modern WooCommerce'in VARSAYILAN checkout'u (Checkout Block / Store API
     * POST /wp-json/wc/store/v1/checkout) bir REST isteğidir ve `woocommerce_order_status_processing`
     * TAM O İSTEKTE ateşlenir → gecikme düzeltmesi en yaygın checkout yolunda HİÇ çalışmıyor, yalnız
     * klasik shortcode checkout'ta çalışıyordu (aynı sürümde iki farklı davranış). REST yanıtı da
     * (rest_api_loaded → serve_request → die()) 'shutdown'dan ÖNCE gönderilir; tamponlar boşaltıldıktan
     * sonra koştuğumuz için satır-içi koşum orada da güvenlidir.
     *
     * Diğer tüm bağlamlarda (checkout thank-you, Store API checkout, admin sipariş ekranı, admin-ajax,
     * ödeme geçidi IPN'i vb.) satır-içi koşarız — asıl gecikme şikâyeti oralardan geliyordu.
     */
    private static function can_run_inline() {
        if (php_sapi_name() === 'cli') return false;
        if (defined('WP_CLI') && WP_CLI) return false;
        if (function_exists('wp_doing_cron') && wp_doing_cron()) return false;
        if (defined('DOING_CRON') && DOING_CRON) return false;
        return true;
    }

    /**
     * (G5) Yanıt gönderildikten sonra BAĞLANTIYI kapatabiliyor muyuz? PHP-FPM (fastcgi_finish_request)
     * ve LiteSpeed (litespeed_finish_request) kapatabilir; mod_php/Apache KAPATAMAZ → istek, işler
     * bitene kadar müşterinin sekmesinde açık kalır. Yetenek statiktir (function_exists) → iş
     * KAYDEDİLİRKEN de güvenle sorgulanabilir.
     */
    private static function can_close_connection() {
        return function_exists('fastcgi_finish_request') || function_exists('litespeed_finish_request');
    }

    /** (G5) İstek başına satır-içi iş sınırı — bağlantı kapatılamıyorsa TEK iş. */
    private static function max_inline_jobs() {
        return self::can_close_connection()
            ? self::AFTER_RESPONSE_MAX_JOBS
            : self::AFTER_RESPONSE_MAX_JOBS_BLOCKING;
    }

    /** (G5) Satır-içi panel HTTP timeout'u — bağlantı kapatılamıyorsa daha kısa (müşteri bekliyor). */
    private static function inline_http_timeout() {
        return self::can_close_connection()
            ? self::INLINE_HTTP_TIMEOUT
            : self::INLINE_HTTP_TIMEOUT_BLOCKING;
    }

    /** (G5) İş başına PHP zaman sınırı — bağlantı kapatılamıyorsa daha kısa. */
    private static function inline_time_limit() {
        return self::can_close_connection()
            ? self::INLINE_TIME_LIMIT
            : self::INLINE_TIME_LIMIT_BLOCKING;
    }

    /**
     * (F10) Satır-içi koşumda YALNIZ panel isteklerinin zaman aşımını kısaltır.
     *
     * İş metotlarının imzasını (push/revoke/resync_items/sync_refund) ve Panel_Client'ı DEĞİŞTİRMEDEN
     * istek-kapsamlı bir "kısa timeout modu" sağlar: Panel_Client::post varsayılan 15sn geçer, bu
     * filtre onu satır-içi timeout'a indirir (G5: bağlantı kapatılamıyorsa 2sn). Yalnız panel URL'iyle
     * BAŞLAYAN istekler etkilenir (mağazanın kargo/ödeme gibi diğer HTTP çağrıları korunur); filtre
     * iş döngüsü biter bitmez kaldırılır (istek kapsamı dışına taşmaz).
     */
    public function inline_panel_timeout($args, $url) {
        $panel = Wpteslimat_Settings::panel_url();
        if ($panel !== '' && strpos((string) $url, $panel) === 0) {
            $current = isset($args['timeout']) ? (float) $args['timeout'] : 15;
            $args['timeout'] = min($current, (float) self::inline_http_timeout());
        }
        return $args;
    }

    /**
     * 'shutdown' (PHP_INT_MAX) işleyicisi: önce yanıtı kapat, SONRA panel çağrılarını koş.
     * Guard'lar (is_configured/is_clone/idempotency) iş metotlarının kendisinde AYNEN geçerli.
     *
     * Bu noktadan SONRA kaydedilen bir iş (teorik: bir işin içinden yeni bir status geçişi
     * tetiklenirse) satır-içi koşmaz — AS güvenlik ağı onu devralır. Bilinçli: yeniden-giriş
     * yapıp shutdown içinde döngü kurmayız.
     */
    public function run_after_response_jobs() {
        if (empty(self::$after_response_jobs)) return;
        $jobs = self::$after_response_jobs;
        self::$after_response_jobs = [];

        // (F10/G5) Satır-içi koşulMAYAN işler yalnız GECİKİR (AS kuyruğunda duruyorlar) — sessiz kalmasın.
        if (self::$after_response_deferred > 0) {
            error_log(sprintf(
                'wpteslimat: %d iş satır-içi koşulmadı (istek başına sınır %d%s) — Action Scheduler devralacak.',
                self::$after_response_deferred,
                self::max_inline_jobs(),
                self::can_close_connection() ? '' : ', bağlantı kapatılamıyor: yalnız kritik iş'
            ));
            self::$after_response_deferred = 0;
        }

        // İstemci bağlantıyı kesse bile iş TAMAMLANSIN (yarım kalan panel çağrısı = tutarsız durum).
        // Bağlantıyı kapatamayan SAPI'lerde (mod_php) bu şart: kullanıcı sekmeyi kapatırsa PHP
        // aksi halde iş ortasında sonlandırılırdı.
        if (function_exists('ignore_user_abort')) ignore_user_abort(true);

        // Kalan çıktı tamponlarını boşalt. WP zaten önceliği 1'de wp_ob_end_flush_all() çağırır;
        // bu döngü yalnız artakalanlar için savunmadır. Kapatılamayan tamponda ob_end_flush()
        // false döner → sonsuz döngüyü kır.
        while (ob_get_level() > 0) {
            if (!@ob_end_flush()) break;
        }
        flush();

        // (#98) Bağlantıyı KAPAT — katmanlı: PHP-FPM → LiteSpeed → (yoksa) kapatmadan devam et.
        // Üçüncü durumda (mod_php) sayfa İÇERİĞİ yukarıdaki flush ile tarayıcıya gitmiştir; yalnız
        // bağlantı iş süresince (kısa timeout + en fazla 3 iş) açık kalır. Eski davranış burada
        // satır-içi koşumu tamamen iptal ediyordu → gecikme düzeltmesi mod_php'de etkisizdi.
        if (function_exists('fastcgi_finish_request')) {
            fastcgi_finish_request();
        } elseif (function_exists('litespeed_finish_request')) {
            litespeed_finish_request();
        }

        // (F10) Satır-içi yolda panel çağrıları KISA timeout ile yapılır (bkz. inline_panel_timeout).
        add_filter('http_request_args', [$this, 'inline_panel_timeout'], 10, 2);
        try {
            foreach ($jobs as $job) {
                list($method, $args, $hook) = $job;
                $order_id = (int) $args[0];
                $actor = isset($args[1]) && is_scalar($args[1]) ? (string) $args[1] : '';
                // İş başına zaman sınırı: takılan tek bir çağrı PHP işçisini süresiz tutmasın
                // (max_execution_time sıfır/uzun olan kurulumlarda da üst sınır garanti edilir).
                if (function_exists('set_time_limit')) @set_time_limit(self::inline_time_limit());
                $executed = false;
                try {
                    // run_locked true döner = iş gövdesi BU koşumda GERÇEKTEN çalıştı (kilit alındı,
                    // guard'lara takılmadı). false = atlandı → kuyruktaki AS işine DOKUNMA.
                    $executed = (bool) $this->$method($order_id, $actor);
                } catch (\Throwable $e) {
                    // Yanıt zaten gönderildi; burada patlamak kullanıcıya bir şey göstermez. İşi
                    // kuyruktaki AS güvenlik ağına bırak, izlenebilirlik için logla.
                    error_log('wpteslimat: yanıt-sonrası iş hatası (' . $method . ' #' . $order_id . '): ' . $e->getMessage());
                    continue;
                }
                if (!$executed) continue;

                // (G1) İş BURADA tamamlandı → kuyrukta BEKLEYEN ikizini düşür. Kilit bir MUTEX'tir,
                // idempotency DEĞİL: kilit açıldıktan 15-75sn sonra koşacak AS işi aynı işi baştan
                // yapardı (resync/refund kalıcı "yapıldı" meta'sı yazmaz → panele ikinci POST +
                // siparişe yanıltıcı ikinci not). Argümanlar kuyruğa alınırkenkiyle BİREBİR aynı.
                // Zaten "running" durumdaki bir AS ikizi kuyruktan düşürülemez; o koşum kilide takılır
                // ve kendini 'wpteslimat_recheck' olarak erteler, orada "yapıldı" işareti onu susturur.
                //
                // GÜVENLİK: iş SÜRERKEN aynı (hook, sipariş) için YENİ bir tetik kaydedildiyse
                // (teorik: gövde içindeki save() yeni bir durum geçişi doğurursa) kuyruktan DÜŞÜRME —
                // o yeni iş bu döngüde koşmaz, AS güvenlik ağına aittir; düşürmek onu KAYBETMEK olurdu.
                if (isset(self::$after_response_jobs[$hook . '|' . $order_id])) continue;
                try {
                    if (function_exists('as_unschedule_action')) {
                        as_unschedule_action($hook, $args, 'wpteslimat');
                    }
                } catch (\Throwable $e) {
                    error_log('wpteslimat: AS işi kuyruktan düşürülemedi (' . $hook . ' #' . $order_id . '): ' . $e->getMessage());
                }
            }
        } finally {
            // Filtre İSTEK KAPSAMINDA kalır: bundan sonraki (teorik) panel çağrıları normal 15sn.
            remove_filter('http_request_args', [$this, 'inline_panel_timeout'], 10);
        }
    }

    /**
     * (F2) Kısa ömürlü İŞ KİLİDİ anahtarı.
     *
     * Anahtar İŞ ADINDAN türetilir (hook adından DEĞİL): aynı mantıksal iş üç ayrı yoldan gelebilir
     * (wpteslimat_async_*, wpteslimat_retry_*, satır-içi yanıt-sonrası çağrı) ve hepsinin AYNI kilidi
     * paylaşması gerekir — hook adı kullanılsaydı async ile retry farklı kilit alır, çift koşum sürerdi.
     */
    private static function lock_key($job, $order_id) {
        return 'wpteslimat_lock_' . $job . '_' . (int) $order_id;
    }

    /**
     * (F2/G4) Kilidi ATOMİK edinir; alınamazsa false (çağıran işi yeniden PLANLAR — bkz. run_locked).
     *
     * NEDEN gerekli: yanıt-sonrası satır-içi koşum ile Action Scheduler işi AYNI işi AYNI ANDA
     * çalıştırabilir. push/revoke için kalıcı meta işareti (_wpteslimat_pushed/_wpteslimat_revoked)
     * ikinciyi no-op yapar; ama resync_items ve sync_refund BÖYLE BİR İŞARET YAZMAZ → aynı iade/
     * uzlaştırma panele İKİ KEZ POST edilir: siparişte yanıltıcı ikinci not ("0 birim geri alındı"),
     * kuyruk logunda çift satır, panelde eşzamanlı iki /refund.
     *
     * (G4) NEDEN add_option DEĞİL: add_option ATOMİK "yoksa oluştur" DEĞİLDİR. WP çekirdeği önce
     * get_option ile check-then-act yapar, sonra `INSERT ... ON DUPLICATE KEY UPDATE` çalıştırır →
     * çakışmada İKİ süreç de true alabilir (kilit hiç kilitlemez). Bunun yerine DB düzeyinde atomik
     * primitifler kullanılır:
     *   - edinme  : INSERT IGNORE + rows_affected === 1 (UNIQUE option_name → yalnız BİR süreç ekler)
     *   - devralma: koşullu UPDATE (WHERE option_value < eşik) + rows_affected === 1
     * autoload='no' → kilit kaydı her istekte belleğe alınmaz. Yazımdan sonra obje-cache temizlenir
     * (satırı $wpdb ile doğrudan yazdığımız için get_option/notoptions önbelleği bayat kalabilir).
     */
    private static function acquire_lock($job, $order_id) {
        global $wpdb;
        $key = self::lock_key($job, $order_id);
        $now = time();

        // 1) ATOMİK edinme: satır varsa INSERT IGNORE sessizce 0 satır etkiler (hata üretmez).
        $inserted = $wpdb->query($wpdb->prepare(
            "INSERT IGNORE INTO {$wpdb->options} (option_name, option_value, autoload) VALUES (%s, %s, 'no')",
            $key,
            (string) $now
        ));
        if ($inserted === false) {
            // Sürücü INSERT IGNORE desteklemiyor (ör. SQLite drop-in) → geriye dönük, ATOMİK OLMAYAN
            // add_option yoluna düş. Nadiren çift koşum olabilir (iş metotlarının kendi guard'ları
            // devrede kalır); işin HİÇ koşmamasından iyidir. Bayat kilit devralması BURADA DA olmalı:
            // aksi halde fatal'dan kalan kilit sonsuza dek kalır ve iş her seferinde ertelenip
            // ertelenip HİÇ koşmaz.
            if (add_option($key, (string) $now, '', 'no')) return true;
            $since = (int) get_option($key, 0);
            if ($since > 0 && ($now - $since) < self::JOB_LOCK_TTL) return false;
            delete_option($key);
            return (bool) add_option($key, (string) $now, '', 'no');
        }
        if ((int) $wpdb->rows_affected === 1) {
            self::flush_option_cache($key);
            return true;
        }

        // 2) Kilit VAR. Süreç fatal error ile ölmüşse kilit takılı kalabilir → TTL dolduysa DEVRAL.
        // Koşullu UPDATE atomiktir: yarışta yalnız BİR süreç 1 satır etkiler (diğeri 0 alır).
        // CAST(... AS UNSIGNED): option_value longtext'tir; sayısal karşılaştırmayı açıkça zorlarız.
        // '<=' bilinçli: TAM TTL kadar yaşlı kilit de bayattır (güvenlik-ağı koşumu erteleme süresiyle
        // TTL eşit olduğundan '<' kullanılsaydı devralma bir tur daha gecikirdi).
        $updated = $wpdb->query($wpdb->prepare(
            "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND CAST(option_value AS UNSIGNED) <= %d",
            (string) $now,
            $key,
            $now - self::JOB_LOCK_TTL
        ));
        if ($updated === false) return false;
        $took_over = ((int) $wpdb->rows_affected === 1);
        if ($took_over) {
            self::flush_option_cache($key);
            error_log(sprintf('wpteslimat: bayat iş kilidi devralındı (%s #%d) — önceki koşum yarıda kalmış olabilir.', $job, (int) $order_id));
        }
        return $took_over;
    }

    /**
     * (G4) $wpdb ile doğrudan yazılan option satırı için obje-cache tutarlılığı: hem kaydın kendisi
     * hem de "bu option YOK" bilgisini tutan `notoptions` listesi geçersizleştirilir.
     */
    private static function flush_option_cache($key) {
        if (!function_exists('wp_cache_delete')) return;
        wp_cache_delete($key, 'options');
        wp_cache_delete('notoptions', 'options');
    }

    /** (F2) Kilidi bırakır (iş bitti/patladı fark etmez — çağıran finally içinde çağırır). */
    private static function release_lock($job, $order_id) {
        delete_option(self::lock_key($job, $order_id));
    }

    /** (G1) "Yapıldı" işaretinin anahtarı — kilitle AYNI (iş, sipariş) çiftine bağlıdır. */
    private static function done_marker_key($job, $order_id) {
        return 'wpteslimat_done_' . $job . '_' . (int) $order_id;
    }

    /**
     * (G1) İş BAŞARIYLA tamamlandı (gövde exception atmadan döndü): kısa ömürlü işaret bırak —
     * kilide takılıp ertelenmiş güvenlik-ağı koşumunu (recheck) susturur. Yalnız recheck okur.
     */
    private static function mark_done($job, $order_id) {
        if (!function_exists('set_transient')) return;
        set_transient(self::done_marker_key($job, $order_id), (string) time(), self::DONE_MARKER_TTL);
    }

    /**
     * (G1) Güvenlik-ağı koşumunda (YALNIZ recheck): kilidi tutan ikiz koşum işi AZ ÖNCE bitirdi mi?
     * İşaret TEK SEFERLİK tüketilir (okundu → silindi) ve yalnız TAZE ise (≤ DONE_MARKER_WINDOW)
     * işi susturur. Bayat işaret hiçbir işi yutamaz — belirsizlikte GÜVENLİ yön koşmaktır.
     */
    private static function consume_done_marker($job, $order_id) {
        if (!function_exists('get_transient')) return false;
        $key = self::done_marker_key($job, $order_id);
        $done_at = get_transient($key);
        if ($done_at === false) return false;
        delete_transient($key);
        return (time() - (int) $done_at) <= self::DONE_MARKER_WINDOW;
    }

    /**
     * (G2) Kilit MEŞGULken işi SESSİZCE düşürme — Action Scheduler güvenlik ağını yutar.
     *
     * Senaryo: satır-içi koşum fatal alır (max_execution_time/OOM) → kilit açılmadan kalır ve
     * kalıcı "yapıldı" meta'sı YAZILMAZ; gövde içindeki handle_failure() de hiç çalışmaz. AS işi
     * kilidi taze görüp sessizce dönerse eylem 'complete' işaretlenir → SİPARİŞ PANELE HİÇ GİTMEZ.
     * Bu yüzden meşgul kilitte iş +60sn sonraya YENİDEN PLANLANIR (o an kilit TTL ile bayat olur ve
     * devralınır) ve iz için log bırakılır. AS yoksa sessiz geçilir (o kurulumda senkron fallback
     * çalışır, eşzamanlılık zaten oluşmaz).
     *
     * NEDEN AYRI HOOK ('wpteslimat_recheck', iş adı argümanla taşınır) — asıl 'wpteslimat_async_*'
     * hook'u DEĞİL: ertelenen koşum, kilidi tutan ikiz işi bitirdiyse TEKRAR KOŞMAMALIDIR (G1) ve bu
     * yalnız "yapıldı" işaretine bakılarak anlaşılır. Aynı async hook kullanılsaydı işareti o hook'un
     * TÜM koşumları sorgulamak zorunda kalırdı ve MEŞRU bir yeniden tetik (ikinci kısmi iade, ikinci
     * kalem düzenlemesi) yanlışlıkla susturulabilirdi — iş kaybı. Ayrı hook ile işaret yalnız güvenlik
     * ağı yolunda tüketilir. İş metotlarının imzaları DEĞİŞMEZ (recheck ayrı bir giriş noktasıdır).
     */
    private static function reschedule_locked_job($job, $order_id, $actor) {
        $args = [(string) $job, (int) $order_id, is_scalar($actor) ? (string) $actor : ''];
        error_log(sprintf(
            'wpteslimat: %s #%d kilitli (başka koşum sürüyor ya da yarıda kalmış) — %dsn sonraya yeniden planlandı.',
            $job,
            (int) $order_id,
            self::JOB_RESCHEDULE_DELAY
        ));
        if (function_exists('as_schedule_single_action')) {
            // Aynı argümanlarla zaten bekleyen bir güvenlik-ağı koşumu varsa tekrar ekleme (kuyruk şişmesin).
            if (function_exists('as_has_scheduled_action') && as_has_scheduled_action('wpteslimat_recheck', $args, 'wpteslimat')) return;
            as_schedule_single_action(time() + self::JOB_RESCHEDULE_DELAY, 'wpteslimat_recheck', $args, 'wpteslimat');
            return;
        }
        // (denetim) Action Scheduler YOKSA burası eskiden SESSİZCE dönüyordu → iş KAYBOLUYORDU.
        // "Eşzamanlılık zaten oluşmaz" varsayımı yanlıştı: AS'siz kurulumda iş SENKRON koşar ve iki
        // eşzamanlı istek (ör. iki yöneticinin aynı siparişi işlemesi, ödeme geçidi IPN'i ile admin
        // isteğinin çakışması) aynı kilide gider; kaybeden koşum hiç yeniden denenmezdi. Ayrıca
        // ÖNCEKİ koşum fatal alıp kilidi takılı bıraktıysa hiçbir kurtarma yolu kalmıyordu.
        // wp-cron'a düş (handle_failure ile AYNI fallback deseni) — dedupe: aynı argümanlı olay varsa ekleme.
        if (!function_exists('wp_schedule_single_event')) return;
        if (function_exists('wp_next_scheduled') && wp_next_scheduled('wpteslimat_recheck', $args)) return;
        wp_schedule_single_event(time() + self::JOB_RESCHEDULE_DELAY, 'wpteslimat_recheck', $args);
    }

    /**
     * (G1/G2) Güvenlik-ağı giriş noktası: kilit meşgul olduğu için atlanan işi SONRADAN koşar.
     *
     * - Kilidi tutan ikiz koşum işi BAŞARIYLA bitirmişse ("yapıldı" işareti taze) → koşMA (mükerrer
     *   /orders veya /refund POST'u + siparişte yanıltıcı ikinci not olurdu).
     * - İşaret yoksa/bayatsa (ikiz fatal ile ölmüş ya da hiç bitirememiş) → işi normal kilitli yoldan
     *   koş. Kilit o an TTL ile bayattır ve atomik olarak devralınır → iş KAYBOLMAZ.
     *
     * @param string $job    Mantıksal iş adı: push|revoke|resync|refund.
     */
    public function recheck($job, $order_id = 0, $actor = '') {
        $map = [
            'push'   => 'do_push',
            'revoke' => 'do_revoke',
            'resync' => 'do_resync_items',
            'refund' => 'do_sync_refund',
        ];
        $job = is_scalar($job) ? (string) $job : '';
        if (!isset($map[$job])) return false;
        if (self::consume_done_marker($job, $order_id)) return false;
        return $this->run_locked($job, $map[$job], $order_id, $actor);
    }

    /**
     * (F2) İş gövdesini kısa ömürlü kilitle sarar. Kilit alınamazsa iş ATLANIR ama SESSİZCE DEĞİL:
     * güvenlik-ağı koşumu olarak yeniden planlanır (G2). Kilit yalnız MUTEX'tir; ertelenen koşumun
     * mükerrer çalışmasını "yapıldı" işareti keser (G1 — yalnız recheck yolunda tüketilir).
     *
     * Ucuz ön kontroller (yapılandırma/klon) kilitten ÖNCE: yapılandırılmamış veya klon sitede
     * gereksiz option yazımı olmasın. İş metotlarının kendi guard'ları (idempotency meta dahil)
     * AYNEN korunur → çift savunma.
     *
     * @return bool İş gövdesi BU koşumda gerçekten çalıştı mı (çağıran buna göre AS ikizini düşürür).
     */
    private function run_locked($job, $method, $order_id, $actor) {
        if (!Wpteslimat_Settings::is_configured()) return false;
        if (Wpteslimat_Settings::is_clone()) return false;

        if (!self::acquire_lock($job, $order_id)) {
            self::reschedule_locked_job($job, $order_id, $actor);
            return false;
        }
        // try/finally: dönüş, exception ve iç return dahil FATAL OLMAYAN tüm yollarda kilit bırakılır.
        // Fatal (OOM/timeout) hâlinde finally çalışmaz → kilidi kısa TTL (JOB_LOCK_TTL) bayatlatır ve
        // yeniden planlanan koşum devralır (bkz. reschedule_locked_job).
        try {
            $this->$method($order_id, $actor);
            self::mark_done($job, $order_id);
            return true;
        } finally {
            self::release_lock($job, $order_id);
        }
    }

    /**
     * (§7 izlenebilirlik) İşlemi TETİKLEYEN mağaza yöneticisinin kullanıcı adı — yoksa ''.
     *
     * Yalnız MAĞAZA YETKİLİSİ (manage_woocommerce / edit_shop_orders) oturumunda dolu döner:
     * ödeme sonrası müşteri oturumuyla tetiklenen otomatik push müşteri adına yazılmaz (audit'te
     * yanıltıcı olurdu; panel 'system' görür). DB'ye hiçbir şey yazmaz.
     *
     * Karakter kümesi panel istemcisinin sanitize_actor'ıyla AYNI → panelde sessiz kırpılma olmaz
     * ve değer sipariş notuna girdiğinde HTML enjeksiyonu taşıyamaz.
     */
    private static function current_initiator() {
        if (!function_exists('is_user_logged_in') || !is_user_logged_in()) return '';
        if (!current_user_can('manage_woocommerce') && !current_user_can('edit_shop_orders')) return '';
        $user = wp_get_current_user();
        if (!$user || !$user->exists() || !$user->user_login) return '';
        $login = preg_replace('/[^A-Za-z0-9._@+\- ]/', '', (string) $user->user_login);
        $login = trim(preg_replace('/\s+/', ' ', (string) $login));
        return function_exists('mb_substr') ? mb_substr($login, 0, 60) : substr($login, 0, 60);
    }

    /**
     * Panel çağrısından hemen ÖNCE, İŞE BAĞLI aktörü tek-seferlik olarak ayarlar → arka plan
     * işinde (oturum YOK) bile audit "wp:<yönetici>@<site>" olur. Boşsa no-op — panel istemcisi
     * 'system'e düşer (uydurma isim yok).
     */
    private static function apply_actor($actor) {
        $actor = is_scalar($actor) ? trim((string) $actor) : '';
        if ($actor !== '') Wpteslimat_Panel_Client::set_actor($actor);
    }

    /**
     * Panel durumunu İKİ meta'ya birden yazar — sipariş ekranı ile sipariş LİSTESİ ayrışmasın.
     *
     * NEDEN (dev testinde ÖLÇÜLDÜ): aynı kavramın iki anahtarı var —
     *   · `_wpteslimat_status`       → metabox / müşteri hesabı / rozetler,
     *   · `_wpteslimat_panel_status` → sipariş LİSTESİ kolonu ve "panel durumu" FİLTRESİ.
     * İkincisini yalnız geri-kanal webhook'u (ve manuel toplu yoklama) yazıyordu. Panel iade için
     * webhook ÜRETMEZ; dolayısıyla tam iade edilen bir sipariş panelde 'revoked' iken mağaza
     * listesinde "Teslim edildi" olarak kalıyordu (gerçek sipariş #76'da görüldü) — panel durumuna
     * göre süzen operatör iade edilmiş siparişi teslim edilmiş sanıyordu.
     *
     * Sayaç meta'ları da SİLİNİR: webhook yolundaki gerekçenin aynısı — "Teslim edildi (2/5)" gibi
     * bayat bir sayaç yeni durumla çelişir (sayaç yoksa kolon hiç göstermez).
     *
     * Kaydetmez (`save()`), çağıranın mevcut kayıt akışına karışmaz.
     */
    private static function set_panel_status($order, $status) {
        $status = sanitize_text_field((string) $status);
        if ($status === '') return;
        $order->update_meta_data('_wpteslimat_status', $status);
        $order->update_meta_data('_wpteslimat_panel_status', $status);
        $order->delete_meta_data('_wpteslimat_panel_fulfilled');
        $order->delete_meta_data('_wpteslimat_panel_total');
    }

    /**
     * (F2) Kilitli giriş noktası — imza DEĞİŞMEDİ (AS/retry hook'ları ve senkron fallback aynen çağırır).
     * Dönüş değeri yalnız satır-içi koşum için anlamlıdır (true = gövde çalıştı → AS ikizi düşürülür);
     * WP hook'ları dönüşü yok sayar.
     * @param string $actor İşi tetikleyen mağaza yöneticisi (yoksa '' → panelde 'system').
     */
    public function push($order_id, $actor = '') {
        return $this->run_locked('push', 'do_push', $order_id, $actor);
    }

    /** Asıl push gövdesi (kilit altında koşar). */
    private function do_push($order_id, $actor = '') {
        if (!Wpteslimat_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): site adresi bağlanma anındakinden farklıysa CANLI
        // panele push etme (klon ortamı gerçek stoğu tüketmesin). Admin'e uyarı gösterilir.
        if (Wpteslimat_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Idempotency: bir kez push (panel de site+order ile idempotent).
        if ($order->get_meta('_wpteslimat_pushed') === 'yes') {
            // (#4 denetim) İptal/iade (revoked) edilmiş sipariş tekrar processing/completed'a çevrilirse
            // buraya döner ama re-push YAPILMAZ (§2 terminal — iade edilen hak otomatik dönmez). Otomatik
            // re-teslim yok ama operatör sessiz kalmasın: BİR KEZ sipariş notu bırak (manuel işlem gerekli).
            if ($order->get_meta('_wpteslimat_revoked') === 'yes'
                && $order->get_meta('_wpteslimat_reactivate_notice') !== 'yes') {
                $order->add_order_note('Teslimat: Bu sipariş daha önce iptal/iade edilip lisansları geri alınmıştı; yeniden etkinleştirildi ancak lisanslar OTOMATİK teslim EDİLMEZ. Gerekiyorsa ürün satırındaki "+1 Bonus" ya da panelden manuel atama ile teslim edin.');
                $order->update_meta_data('_wpteslimat_reactivate_notice', 'yes');
                $order->save();
            }
            return;
        }

        $lines = $this->collect_lines($order);
        if (empty($lines)) return;

        $body = [
            'remoteOrderId' => (string) $order_id,
            'customerEmail' => $order->get_billing_email(),
            'lines'         => $lines,
        ];

        self::apply_actor($actor);
        $res = Wpteslimat_Panel_Client::post('/v1/orders', $body);
        $this->log($order_id, 'push', $body, $res);

        // 201 tam / 207 kısmi / 202 pending — hepsi başarılı bildirim.
        if (in_array($res['code'], [200, 201, 202, 207], true)) {
            $order->update_meta_data('_wpteslimat_pushed', 'yes');
            if (!empty($res['body']['orderId'])) {
                $order->update_meta_data('_wpteslimat_order_id', $res['body']['orderId']);
            }
            if (!empty($res['body']['status'])) {
                self::set_panel_status($order, $res['body']['status']);
            }
            // (§8 dinamik satış kotası) Panel siparişi KABUL etti ama dinamik kota eşiği
            // aşıldığından teslimatı yönetici incelemesine aldı (202 + body.held=true). Sipariş
            // pending kalır; yönetici onaylarsa normal teslimat + geri-kanal webhook devam eder,
            // reddederse revoked olur (bulk-status poll'de görünür). Sadece EK işaret: held yok/
            // false ise bugünküyle birebir aynı davranış (geriye dönük uyumlu).
            if (!empty($res['body']['held']) && $order->get_meta('_wpteslimat_held_for_review') !== 'yes') {
                $order->update_meta_data('_wpteslimat_held_for_review', 'yes');
                $order->add_order_note('Teslimat: Sipariş güvenlik incelemesine alındı — teslimat yönetici onayından sonra tamamlanacak.');
            }
            $order->save();
            $this->mark_success($order, 'push');
        } else {
            // Başarısız → §4 basamaklarıyla (1dk/5dk/30dk) sonlu tekrar deneme; 401/403'te hiç deneme.
            $this->handle_failure($order, 'push', $res, $actor, __('sipariş', 'wpteslimat'));
        }
    }

    /**
     * Güncel sipariş kalemlerinden panel satırlarını üretir (push + resync ortak).
     * Varyasyon id yalnız varyasyonlu üründe gönderilir (panel string bekler).
     */
    private function collect_lines($order) {
        $lines = [];
        foreach ($order->get_items() as $item_id => $item) {
            // C1 (denetim): ürün SİLİNMİŞ olsa bile ($item->get_product()===false) sipariş kalemi
            // product_id/variation_id'yi KORUR → satır ATLANMAZ (eksik teslimat + iade under-revoke önlenir).
            // get_product_id() = parent (variation'da) / self (basit) = eski `get_parent_id() ?: get_id()`
            // ile BİREBİR aynı; get_variation_id() = varyasyon (basit üründe 0). Ürün nesnesi yalnız ad için.
            $product = $item->get_product();
            $item_product_id = (int) $item->get_product_id();
            $item_variation_id = (int) $item->get_variation_id();
            if ($item_product_id <= 0) continue; // gerçekten kimliksiz kalem → atla
            // NET adet = brüt − iade edilen (get_qty_refunded_for_item). KRİTİK (§2): WooCommerce iade
            // ile order item qty'sini DÜŞÜRMEZ. BRÜT push edilirse, kısmi iade sonrası bir re-sync
            // (woocommerce_saved_order_items) panel line.qty'sini brüte geri çıkarır → autoComplete iade
            // edilen birimleri YENİDEN teslim eder (BEDAVA LİSANS). NET gönderilir → re-sync iadeyi geri
            // açamaz (ilk push'ta iade=0 → net=brüt, davranış aynı). Tümüyle iade edilen (net=0) satır
            // ATLANIR: /refund ucu ya da tam-iade revoke zaten uzlaştırmıştır ve reconcile yalnız
            // GÖNDERİLEN satırları işler → atlanan satıra dokunmaz (mevcut revoke durumu korunur).
            //
            // Bundle/Composite: TÜM kalemler (konteyner + bileşen) push edilir; teslimat kararı PANEL
            // EŞLEMESİNE bırakılır (konteyneri koşulsuz atlamak, konteyner lisans taşıyorsa eksik-teslimat
            // üretirdi). Eşlemesiz kalem panelde zararsız 'unmapped' satır olur.
            $gross = (int) $item->get_quantity();
            $refunded = abs((int) $order->get_qty_refunded_for_item($item_id));
            $net = max(0, $gross - $refunded);
            if ($net <= 0) continue;
            // Mağaza ürün adı (opsiyonel, additive): panel eşlenmemiş ürünü isimle gösterir → operatör
            // tek tıkla eşler (teslimatı ETKİLEMEZ). Kalem adı ($item->get_name()) varyasyon etiketini de
            // içerir (ideal); boşsa ürün adına düş; panel 255 char'a sınırlar (burada da kırpılır).
            $remote_name = trim((string) $item->get_name());
            if ($remote_name === '' && $product) {
                $remote_name = trim((string) $product->get_name());
            }
            $remote_name = function_exists('mb_substr')
                ? mb_substr($remote_name, 0, 255)
                : substr($remote_name, 0, 255);
            $line = [
                'remoteLineId'    => (string) $item_id,
                'remoteProductId' => (string) $item_product_id,
                'remoteName'      => $remote_name,
                'qty'             => $net,
            ];
            if ($item_variation_id > 0) {
                $line['remoteVariationId'] = (string) $item_variation_id;
            }
            $lines[] = $line;
        }
        return $lines;
    }

    /**
     * (#16) Sipariş kalemleri düzenlenip kaydedilince yeniden uzlaştırır. Yalnız DAHA ÖNCE
     * panele iletilmiş sipariş (_wpteslimat_pushed=yes) için çalışır; güncel adetlerle mevcut
     * POST /v1/orders akışını AYNI idempotency anahtarıyla (site+remoteOrder+remoteLine) yeniden
     * çağırır — adet değişimini panel uzlaştırır. Re-entrancy guard sonsuz döngüyü engeller.
     *
     * `woocommerce_saved_order_items` hook'u YALNIZ kalem değişiminde ateşlenir; ayrıca
     * içerideki $order->save() zinciri guard ile kendini yeniden tetikleyemez.
     */
    public function resync_items($order_id, $actor = '') {
        // (F2) Kilit ŞART: resync kalıcı bir "yapıldı" işareti YAZMAZ (push/revoke'taki meta gibi) →
        // satır-içi + AS çift koşumu panele iki kez POST ederdi (kuyruk logunda çift satır). Kilit
        // yalnız EŞZAMANLI koşumu keser; ARDIŞIK (AS 15-75sn sonra) koşumu G1 mekanizması keser.
        return $this->run_locked('resync', 'do_resync_items', $order_id, $actor);
    }

    /** Asıl resync gövdesi (kilit altında koşar). */
    private function do_resync_items($order_id, $actor = '') {
        if (self::$syncing) return;
        if (!Wpteslimat_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): klon ortamda uzlaştırma push'u yapma.
        if (Wpteslimat_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Panele hiç iletilmemiş sipariş → uzlaştırılacak atama yok (ilk push status geçişinde olur).
        if ($order->get_meta('_wpteslimat_pushed') !== 'yes') return;

        $lines = $this->collect_lines($order);
        if (empty($lines)) {
            // SESSİZ DÖNME YOK (denetim bulgusu): siparişin TÜM kalemleri silinmişse panel bunu
            // asla duymaz ve teslim edilmiş lisanslar müşteride canlı kalır. Bu durum tek bir
            // POST ile ifade edilemez (sözleşme en az bir satır ister) → operatöre GÖRÜNÜR not.
            $order->add_order_note(__(
                'Teslimat: siparişte hiç ürün kalemi kalmadı — panel bu durumu otomatik uzlaştıramaz. '
                . 'Teslim edilmiş lisanslar hâlâ müşteride geçerlidir; iptal etmek için siparişi '
                . 'İptal/İade edin ya da panelden elle geri alın.',
                'wpteslimat'
            ));
            return;
        }

        $body = [
            'remoteOrderId' => (string) $order_id,
            'customerEmail' => $order->get_billing_email(),
            'lines'         => $lines,
            // TAM SENKRON: gövde siparişin ŞU ANKİ TÜM kalemlerini taşır → panel, gelmeyen bir
            // satırı SİLİNMİŞ sayıp teslim edilmiş lisansları geri alabilir. Bayrak YALNIZ bu
            // yolda gönderilir (push kısmi olabilir).
            'fullSync'      => true,
        ];

        // try/finally: panel çağrısı ya da save() bir Throwable atarsa re-entrancy bayrağı AÇIK
        // kalıyordu → aynı istekte koşan SONRAKİ resync işleri sessizce no-op oluyor, üstelik
        // run_locked "çalıştı" (true) döndüğü için kuyruktaki AS ikizleri de düşürülüyordu (iş kaybı).
        self::$syncing = true;
        try {
            self::apply_actor($actor);
            $res = Wpteslimat_Panel_Client::post('/v1/orders', $body);
            $this->log($order_id, 'resync', $body, $res);

            // 200/201/207/202 → panel güncel adetlerle uzlaştı; durum meta'sını tazele.
            if (in_array($res['code'], [200, 201, 202, 207], true)) {
                if (!empty($res['body']['status'])) {
                    self::set_panel_status($order, $res['body']['status']);
                    $order->save();
                }
                $this->mark_success($order, 'resync');
            } else {
                // (denetim) Eskiden bu dal YOKTU: başarısız uzlaştırma tamamen sessizdi. Panel eski
                // adette kalır; adet DÜŞÜRÜLMÜŞSE fazla teslim edilen birim geri alınmaz (§2).
                // push/revoke/refund ile aynı davranış: görünür sipariş notu + sonlu tekrar deneme.
                $this->handle_failure($order, 'resync', $res, $actor, __('sipariş kalemi güncellemesi', 'wpteslimat'));
            }
        } finally {
            self::$syncing = false;
        }
    }

    /**
     * İade/iptal olan siparişin panel-tarafı lisanslarını geri alır (§2). Yalnız panele
     * push edilmiş siparişler için anlamlı (atama var). İdempotent: panel zaten revoked
     * ise no-op; bir kez işaretlenir. Lisans verisi WP'de tutulmadığından yalnız tetikler.
     *
     * @param string $actor İşi tetikleyen mağaza yöneticisi (yoksa '' → "İşlemi başlatan" YAZILMAZ).
     */
    public function revoke($order_id, $actor = '') {
        return $this->run_locked('revoke', 'do_revoke', $order_id, $actor);
    }

    /** Asıl revoke gövdesi (kilit altında koşar). */
    private function do_revoke($order_id, $actor = '') {
        if (!Wpteslimat_Settings::is_configured()) return;
        // Kopya/staging koruması (§7): klon ortamda CANLI panele revoke GÖNDERME. Klon aynı
        // api_key+hmac_secret VE `_wpteslimat_pushed` meta'sını miras alır → is_clone() true olsa
        // bile revoke aksi halde CANLI panele giderdi; staging'de iade/iptal edilen sipariş GERÇEK
        // müşterinin prod lisanslarını geri alırdı. push/resync ile aynı guard; retry hook
        // (wpteslimat_retry_revoke) da bu metottan geçtiği için otomatik kapsanır.
        if (Wpteslimat_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;

        // Panele hiç gitmemiş sipariş → geri alınacak atama yok.
        if ($order->get_meta('_wpteslimat_pushed') !== 'yes') return;
        // İdempotency: bir kez revoke (panel de order üzerinden idempotent).
        if ($order->get_meta('_wpteslimat_revoked') === 'yes') return;

        $reason = 'İade/iptal (' . wc_get_order_status_name($order->get_status()) . ')';
        $body = ['reason' => $reason];
        self::apply_actor($actor);
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode((string) $order_id) . '/revoke',
            $body
        );
        $this->log($order_id, 'revoke', $body, $res);

        // 200 → geri alındı; 404 → panelde sipariş yok (zaten temiz). İkisi de idempotent tamam.
        if (in_array($res['code'], [200, 404], true)) {
            $order->update_meta_data('_wpteslimat_revoked', 'yes');
            // (§8 held staleness) Terminal durumu yerel meta'ya yansıt (manuel poll beklemeden):
            // iade/iptal edilen sipariş 'revoked'dır ve varsa "İnceleme bekliyor" işareti artık
            // geçersizdir → idempotent temizle. Aksi halde refund edilen bir held siparişin bayat
            // held meta'sı my-account/metabox'ta asılı kalırdı.
            self::set_panel_status($order, 'revoked');
            if ($order->get_meta('_wpteslimat_held_for_review') === 'yes') {
                $order->delete_meta_data('_wpteslimat_held_for_review');
            }
            $count = isset($res['body']['revoked']) ? (int) $res['body']['revoked'] : 0;
            // "İşlemi başlatan" YALNIZ bu işe bağlı aktörden gelir. Oturumsuz tetikte (ödeme geçidi
            // webhook'u / cron / retry) kayıt yoksa cümle HİÇ yazılmaz — eskiden kalıcı meta
            // okunduğu için burada aylar önceki bir yönetici gösterilebiliyordu (yanlış izlenebilirlik).
            $who = is_scalar($actor) ? trim((string) $actor) : '';
            $order->add_order_note(sprintf(
                'Teslimat: %d lisans geri alındı (%s).%s',
                $count,
                $reason,
                $who !== '' ? ' İşlemi başlatan: ' . $who . '.' : ''
            ));
            $order->save();
            $this->mark_success($order, 'revoke');
        } else {
            // Başarısız → sonlu tekrar deneme (aktör tekrar denemeye taşınır).
            $this->handle_failure($order, 'revoke', $res, $actor, __('lisans geri alımı', 'wpteslimat'));
        }
    }

    /**
     * (§4) Başarısız panel çağrısının ORTAK sonucu: sayaçlı/backoff'lu tekrar deneme + TEK not.
     * Dört iş de (push/resync/revoke/refund) bu yoldan geçer — davranış tek yerde tanımlıdır.
     *
     * Tekrar deneme hook'u iş adından türer: `wpteslimat_retry_<op>` (dördü de kayıtlı). Aktör
     * argümanda taşınır (kalıcı meta okunmaz) → 30dk sonra koşan iş hâlâ DOĞRU kişiyi gösterir.
     *
     * NEDEN 401/403 HİÇ denenmez: bunlar YAPILANDIRMA hatasıdır (geçersiz api_key / imza / saat
     * kayması). Aynı istek 30dk sonra da aynı yanıtı alır; tekrar denemek düzeltmez, yalnız gürültü
     * üretir. Operatöre TEK kalıcı sipariş notu + yönetici paneli uyarısı bırakılır (auth_failure_notice).
     *
     * NEDEN ara denemelerde not YAZILMAZ: her denemeye not düşmek siparişin zaman çizelgesini
     * okunamaz hale getiriyordu. İlk başarısızlıkta BİR bilgilendirme, zincir tükenince BİR kalıcı
     * not yazılır; aradaki denemelerin izi zaten kuyruk log tablosundadır.
     *
     * @param WC_Order $order
     * @param string   $op    İş adı: 'push' | 'resync' | 'revoke' | 'refund'.
     * @param array    $res   Panel yanıtı (log ile aynı yapı; 'code' okunur, 0 = ağ hatası).
     * @param string   $actor İşi tetikleyen mağaza yöneticisi (yoksa '').
     * @param string   $what  Nota giren Türkçe iş adı ("sipariş", "lisans geri alımı", …).
     */
    private function handle_failure($order, $op, $res, $actor, $what) {
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        $attempts = count(self::RETRY_DELAYS);

        // Kimlik doğrulama reddi → tekrar deneme YOK; tek kalıcı not + yönetici uyarısı.
        if ($code === 401 || $code === 403) {
            self::flag_auth_failure($code);
            $this->note_once($order, $op, sprintf(
                /* translators: 1: iş adı (sipariş, lisans geri alımı…), 2: HTTP durum kodu */
                __('Teslimat: %1$s panele iletilemedi (HTTP %2$d — panel kimlik doğrulamayı reddetti). Otomatik tekrar DENENMEYECEK: panel adresi, API anahtarı/HMAC sırrı ve sunucu saati kontrol edilmeli.', 'wpteslimat'),
                $what,
                $code
            ));
            return;
        }

        $n = (int) $order->get_meta('_wpteslimat_retry_' . $op);
        if ($n >= $attempts) {
            // Zincir tükendi → DUR. Sessizce vazgeçme: operatör tek ve net bir not görür.
            $this->note_once($order, $op, sprintf(
                /* translators: 1: iş adı, 2: HTTP durum kodu, 3: deneme adedi */
                __('Teslimat: %1$s panele iletilemedi (HTTP %2$d) — %3$d otomatik denemeden sonra vazgeçildi. Panel bağlantısını/yapılandırmasını kontrol edip işlemi tekrar başlatın.', 'wpteslimat'),
                $what,
                $code,
                $attempts
            ));
            return;
        }

        $delay = self::RETRY_DELAYS[$n];
        $order->update_meta_data('_wpteslimat_retry_' . $op, $n + 1);
        $order->save();
        if ($n === 0) {
            $order->add_order_note(sprintf(
                /* translators: 1: iş adı, 2: HTTP durum kodu, 3: toplam deneme adedi */
                __('Teslimat: %1$s panele iletilemedi (HTTP %2$d) — otomatik tekrar denenecek (en fazla %3$d deneme).', 'wpteslimat'),
                $what,
                $code,
                $attempts
            ));
        }

        $hook = 'wpteslimat_retry_' . $op;
        $args = [$order->get_id(), $actor];
        if (function_exists('as_schedule_single_action')) {
            as_schedule_single_action(time() + $delay, $hook, $args, 'wpteslimat');
        } else {
            wp_schedule_single_event(time() + $delay, $hook, $args);
        }
    }

    /**
     * Aynı kalıcı hata için TEK sipariş notu (meta bayrağıyla korunur) — not spam'i olmaz.
     * Bayrak başarılı bir 2xx'te temizlenir (bkz. mark_success), böylece SONRAKİ gerçek bir arıza
     * yine görünür olur.
     */
    private function note_once($order, $op, $message) {
        if ($order->get_meta('_wpteslimat_fail_' . $op) === 'yes') return;
        $order->update_meta_data('_wpteslimat_fail_' . $op, 'yes');
        $order->save();
        $order->add_order_note($message);
    }

    /**
     * Başarılı (2xx) sonuç: bu işin tekrar deneme sayacını ve kalıcı hata izlerini SIFIRLA.
     *
     * NEDEN: sayaç sıfırlanmazsa aylar önce yaşanmış geçici bir hata, gelecekteki MEŞRU bir tekrar
     * deneme zincirini daha ilk denemede keser (sipariş sessizce panele iletilemez).
     * Değişiklik varsa kendi kaydını yapar → çağıranların save() düzenine bağımlı değildir.
     */
    private function mark_success($order, $op) {
        $changed = false;
        foreach (['_wpteslimat_retry_' . $op, '_wpteslimat_fail_' . $op] as $meta) {
            if ($order->get_meta($meta) !== '') {
                $order->delete_meta_data($meta);
                $changed = true;
            }
        }
        if ($changed) $order->save();
        // Başarılı imzalı istek, kimlik bilgilerinin ARTIK çalıştığının kanıtıdır → uyarıyı kaldır.
        self::clear_auth_failure();
    }

    /**
     * (401/403) Kimlik doğrulama reddini yönetici uyarısı için işaretle. Aynı kod için tekrar tekrar
     * option yazmaz (her başarısız istekte DB yazımı olmasın); ilk görülme zamanı korunur.
     */
    private static function flag_auth_failure($code) {
        $cur = get_option('wpteslimat_auth_failure', []);
        if (is_array($cur) && isset($cur['code']) && (int) $cur['code'] === (int) $code) return;
        update_option('wpteslimat_auth_failure', ['code' => (int) $code, 'time' => time()]);
    }

    /** Kimlik doğrulama uyarısını kaldırır (ilk başarılı imzalı istekte). */
    private static function clear_auth_failure() {
        if (get_option('wpteslimat_auth_failure', null) !== null) {
            delete_option('wpteslimat_auth_failure');
        }
    }

    /**
     * Panel kimlik doğrulamayı reddettiyse (401/403) yöneticiye GÖRÜNÜR uyarı bas.
     *
     * NEDEN: bu hata tekrar denemeyle DÜZELMEZ ve tek iz sipariş notu olsaydı operatör o siparişi
     * açana kadar fark etmezdi — bu arada gelen HER yeni sipariş de sessizce panele iletilemez.
     * Klon/güvensiz-adres uyarılarıyla aynı desen (sır/kimlik bilgisi EKRANA BASILMAZ).
     */
    public function auth_failure_notice() {
        if (!current_user_can('manage_options')) return;
        $flag = get_option('wpteslimat_auth_failure', []);
        if (!is_array($flag) || empty($flag['time'])) return;
        $when = function_exists('wp_date')
            ? wp_date(get_option('date_format') . ' H:i', (int) $flag['time'])
            : date_i18n(get_option('date_format') . ' H:i', (int) $flag['time']);
        echo '<div class="notice notice-error"><p>' . esc_html(sprintf(
            'Teslimat eklentisi: Panel kimlik doğrulamayı reddediyor (HTTP %d — ilk hata: %s). Siparişler panele ' .
            'İLETİLEMİYOR ve bu hata için otomatik tekrar deneme YAPILMIYOR (tekrar denemek düzeltmez). ' .
            'Panelde anahtar rotasyonu yapıldıysa yeni API anahtarını/HMAC sırrını (wp-config.php ya da ' .
            'Ayarlar → Teslimat Eklentisi) güncelleyin ve sunucu saatinin doğru olduğunu kontrol edin.',
            (int) $flag['code'],
            $when
        )) . '</p></div>';
    }

    /**
     * (§2/§7) Kısmi iade uzlaştırması: satır-bazlı NET adet (sipariş qty − iade edilen qty).
     * Tam iade (net=0) → mevcut revoke() (terminal, idempotent). Kısmi → /refund ucu: panel qty'yi
     * düşürür + fazla teslim edilmiş birimi geri alır → autoComplete iade edileni DOLDURMAZ (bedava
     * lisans kapanır). Klon/yapılandırma guard'lı; başarısızlıkta retry.
     */
    public function sync_refund($order_id, $actor = '') {
        // (F2) Kilit ŞART: iade uzlaştırması da kalıcı işaret yazmaz → çift koşum siparişe yanıltıcı
        // ikinci not ("0 birim geri alındı") ve panele ikinci /refund POST'u üretiyordu. Ardışık
        // (satır-içi bitti → AS geç koştu) mükerrer koşumu G1 mekanizması keser.
        return $this->run_locked('refund', 'do_sync_refund', $order_id, $actor);
    }

    /** Asıl kısmi-iade gövdesi (kilit altında koşar). */
    private function do_sync_refund($order_id, $actor = '') {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;
        $order = wc_get_order($order_id);
        if (!$order) return;
        // Panele hiç iletilmemiş sipariş → uzlaştırılacak atama yok.
        if ($order->get_meta('_wpteslimat_pushed') !== 'yes') return;

        $lines = [];
        $total_net = 0;
        $total_ordered = 0;
        foreach ($order->get_items() as $item_id => $item) {
            // C1 (denetim): ürün SİLİNMİŞ olsa bile order-item product_id/variation_id korunur → satır
            // ATLANMAZ (kısmi iade under-revoke önlenir: silinmiş ürünün iade edilen birimi de revoke edilir).
            $item_product_id = (int) $item->get_product_id();
            $item_variation_id = (int) $item->get_variation_id();
            if ($item_product_id <= 0) continue;
            $qty = (int) $item->get_quantity();
            // get_qty_refunded_for_item NEGATİF döner (iade edilen adet) → abs ile net hesapla.
            $refunded = abs((int) $order->get_qty_refunded_for_item($item_id));
            $net = max(0, $qty - $refunded);
            $total_net    += $net;
            $total_ordered += $qty;
            // remoteProductId/remoteVariationId gönderilir → panel bu satırın bundleQty'sini yeniden
            // çözüp NET sipariş adedini PANEL birimine ölçekler (bundleQty>1'de aşırı/yanlış revoke önlenir).
            $line = [
                'remoteLineId'    => (string) $item_id,
                'netQty'          => $net,
                'remoteProductId' => (string) $item_product_id,
            ];
            if ($item_variation_id > 0) {
                $line['remoteVariationId'] = (string) $item_variation_id;
            }
            $lines[] = $line;
        }
        if (empty($lines)) return;

        // Hiç iade yok → no-op (hook başka nedenle ateşlenmiş olabilir).
        if ($total_net >= $total_ordered) return;

        // Tam iade (hiç net kalmadı) → terminal revoke yoluna devret (idempotent; _wpteslimat_revoked).
        // Aktör aynı işin parçası olarak devredilir (sipariş notu doğru kişiyi gösterir).
        // (F2) KİLİT: revoke kendi anahtarını ('revoke') alır, biz 'refund' anahtarını tutuyoruz →
        // iç içe çağrıda kendi kilidimize takılmayız (kilitler iş adına göre AYRI).
        if ($total_net === 0) {
            $this->revoke($order_id, $actor);
            return;
        }

        // Kısmi iade → satır-bazlı /refund ucu.
        $body = ['reason' => 'WooCommerce kısmi iade', 'lines' => $lines];
        self::apply_actor($actor);
        $res = Wpteslimat_Panel_Client::post(
            '/v1/orders/' . rawurlencode((string) $order_id) . '/refund',
            $body
        );
        $this->log($order_id, 'refund', $body, $res);
        if (in_array($res['code'], [200, 404], true)) {
            $revoked = isset($res['body']['revoked']) ? (int) $res['body']['revoked'] : 0;
            $order->add_order_note(sprintf('Teslimat: kısmi iade uzlaştırıldı (%d birim geri alındı).', $revoked));
            $order->save();
            $this->mark_success($order, 'refund');
        } else {
            $this->handle_failure($order, 'refund', $res, $actor, __('kısmi iade uzlaştırması', 'wpteslimat'));
        }
    }

    private function log($order_id, $direction, $payload, $response) {
        global $wpdb;
        $wpdb->insert($wpdb->prefix . 'wpteslimat_queue', [
            'order_id'  => $order_id,
            'direction' => $direction,
            'status'    => isset($response['code']) && $response['code'] >= 200 && $response['code'] < 300 ? 'ok' : 'error',
            'payload'   => wp_json_encode($payload),
            'response'  => wp_json_encode($response),
        ]);
    }
}
