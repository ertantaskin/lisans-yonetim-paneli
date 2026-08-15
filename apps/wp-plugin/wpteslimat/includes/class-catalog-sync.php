<?php
if (!defined('ABSPATH')) exit;

/**
 * (§10) Mağaza ürün kataloğu senkronu — PROAKTİF eşleme için.
 *
 * Yayınlanmış WooCommerce ürünlerini (+ varyasyonları) panele TAM ANLIK GÖRÜNTÜ olarak push eder;
 * böylece operatör panelde ürünleri SİPARİŞ BEKLEMEDEN, ADIYLA eşleyebilir. Panel bu sitenin
 * kataloğunu siler+değiştirir (full snapshot). SIR GÖNDERMEZ — yalnız id/ad/sku/tip; fiyat, stok,
 * lisans, ödeme verisi TAŞINMAZ (ince istemci, §7).
 *
 * remoteProductId / remoteVariationId, order-sync collect_lines() ile BİREBİR aynı türetilir →
 * katalog satırı sipariş satırıyla eşleşir (eşleme sipariş anında çözülür):
 *   - Basit ürün → remoteProductId = ürün id,  remoteVariationId = null,          kind = simple
 *   - Varyasyonlu ürün:
 *       · PARENT satırı  → remoteProductId = parent id, remoteVariationId = null,  kind = variable
 *       · Her varyasyon  → remoteProductId = PARENT id, remoteVariationId = varyasyon id, kind = variation
 *
 * NOT (eşleşme garantisi): collect_lines() bir siparişteki varyasyon kalemi için
 *   remoteProductId = $product->get_parent_id()  (PARENT id)
 *   remoteVariationId = $product->get_id()        (varyasyon id)
 * gönderir; katalogdaki 'variation' satırları TAM AYNI çifti üretir → panel eşlemesi çözülür.
 * Basit üründe collect_lines get_parent_id() 0 döner → get_id()'e düşer; katalog da get_id() gönderir.
 *
 * AYRICA (§12): aynı istekte mağazanın YÖNETİM PANELİ SİPARİŞ BAĞLANTISI ŞABLONU da bildirilir
 * (opsiyonel `adminOrderUrlTemplate`). Panel bu şablonu bugüne kadar TAHMİN ediyordu (HPOS yolu
 * varsayımı + site domain'i) ve alt-dizin kurulumu / HPOS kapalı mağaza / farklı admin adresinde
 * ÇÖZÜLEMEYEN link üretebiliyordu. Doğrusunu yalnız mağazanın kendisi bilir → burada üretilir.
 * SALT YÖNLENDİRME: panel bu adrese otomatik BAĞLANMAZ, veri çekmez; yalnız operatörün tıklayacağı
 * bağlantıyı kurar. Şablon güvenle üretilemiyorsa HİÇ gönderilmez (yanlış link yerine link yok).
 *
 * TETİKLER (hepsi arka plan — editör/istek ASLA bloklanmaz; hash aynıysa push ATLANIR → maliyet ~0):
 *   - ürün oluştur/güncelle/çöpe at (woocommerce_new/update/trash_product),
 *   - eklenti AKTİVASYONU (ilk kurulumda panel şablonsuz/katalogsuz kalmasın),
 *   - eklenti GÜNCELLEMESİ (upgrader_process_complete) — yeni sürümün ürettiği şablon panele gitsin,
 *   - GÜNLÜK heartbeat (kurtarma: hiç ürün düzenlenmeyen mağazada da katalog/şablon tazelenir),
 *   - Ayarlar → "Ürünleri Panele Aktar" (manuel, hash'i yok sayar → zorla tazele).
 */
class Wpteslimat_Catalog_Sync {
    private static $instance = null;

    /** Panel bir çağrıda en fazla 5000 ürün kabul eder (ürün + varyasyon satırları toplamı). */
    const MAX_PRODUCTS = 5000;

    /** Panel `adminOrderUrlTemplate` üst sınırı (sites.controller Zod `.max(500)`). Aşarsa gönderilmez. */
    const MAX_TEMPLATE_LEN = 500;

    /** Panelin şablonda beklediği yer tutucu — URL-encode EDİLMEMİŞ düz metin kalmalı. */
    const ORDER_ID_PLACEHOLDER = '{orderId}';

    /** Arka plan (Action Scheduler / wp-cron) tek-deduped senkron iş hook'u. */
    const SYNC_HOOK = 'wpteslimat_async_catalog_sync';

    /** Günlük "kurtarma" tetiği: hiç ürün düzenlenmese de katalog/şablon tazelenir (hash aynıysa no-op). */
    const HEARTBEAT_HOOK = 'wpteslimat_catalog_heartbeat';

    /** Hızlı ard arda düzenlemeler tek push'ta birleşsin diye gecikme (saniye). */
    const SYNC_DELAY = 180; // 3 dk

    /** Katalog (ÜRÜN satırları) parmak izi — push'u atlamak için. */
    const OPT_HASH = 'wpteslimat_catalog_hash';

    /** Sipariş bağlantısı ŞABLONU parmak izi — ürünlerden AYRI tutulur (F8, aşağıdaki nota bak). */
    const OPT_TPL_HASH = 'wpteslimat_catalog_tpl_hash';

    /** Panelin şablon hakkındaki son kararı (durum + gönderilen değer + zaman). */
    const OPT_TPL_STATUS = 'wpteslimat_catalog_tpl_status';

    /** Panelin döndürebileceği şablon durumları (bilinmeyen değer YOK SAYILIR → "bilinmiyor"). */
    const TEMPLATE_STATUSES = ['accepted', 'kept_manual', 'rejected_host', 'rejected_format', 'absent'];

    /** Panel şablonu REDDETTİYSE yeniden deneme aralığı (saniye) — günde bir (DAY_IN_SECONDS). */
    const TPL_RETRY_INTERVAL = 86400;

    public static function instance() {
        if (self::$instance === null) self::$instance = new self();
        return self::$instance;
    }

    private function __construct() {
        // Manuel tetik (Ayarlar → "Ürünleri Panele Aktar").
        add_action('admin_post_wpteslimat_sync_catalog', [$this, 'handle_manual_sync']);

        // Otomatik senkron: ürün oluşturulunca/güncellenince/silinince tek gecikmeli push planla.
        // save_post_product yerine WooCommerce'in yüksek-seviye ürün hook'ları (varyasyon kaydını da kapsar).
        add_action('woocommerce_new_product', [$this, 'schedule_sync']);
        add_action('woocommerce_update_product', [$this, 'schedule_sync']);
        add_action('woocommerce_trash_product', [$this, 'schedule_sync']);

        // Eklenti GÜNCELLEMESİ sonrası (bu eklenti kendi güncelleyicisini taşır → aktivasyon hook'u
        // ÇALIŞMAZ). Yeni sürüm şablon üretimini değiştirmiş olabilir; hash farklıysa push edilir.
        add_action('upgrader_process_complete', [$this, 'on_upgrade'], 10, 2);

        // Arka plan iş işleyicisi (asıl panel çağrısı burada koşar; editör bloklanmaz).
        add_action(self::SYNC_HOOK, [$this, 'run_sync']);

        // Günlük heartbeat: yalnız "senkron planla" der — hash değişmediyse panele HİÇ istek gitmez.
        add_action(self::HEARTBEAT_HOOK, [$this, 'run_heartbeat']);
        self::ensure_heartbeat();
    }

    /**
     * Günlük heartbeat olayını (yoksa) kurar. wpteslimat_init'teki budama cron'u deseniyle aynı:
     * temizlenmiş/hiç kurulmamış olayı normal yükleme yolunda yeniden kurar → eklenti güncellemesi
     * aktivasyonu tetiklemese bile kurtarma tetiği yaşar. Yapılandırılmamış/klon sitede iş üretmez.
     */
    private static function ensure_heartbeat() {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;
        if (!function_exists('wp_next_scheduled') || !function_exists('wp_schedule_event')) return;
        if (wp_next_scheduled(self::HEARTBEAT_HOOK)) return;
        // İlk koşu 1 saat sonra → aktivasyon/güncelleme anındaki tetikle çakışmasın.
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', self::HEARTBEAT_HOOK);
    }

    /**
     * Günlük heartbeat işleyicisi: senkronu NORMAL yoldan (Action Scheduler debounce + dedupe)
     * planlar. Katalog ve şablon değişmediyse run_sync hash-atlamasıyla panele hiç istek yapmaz →
     * günlük maliyet ~0; değiştiyse (ör. panel şablonu reddetti, operatör düzeltti) kendiliğinden
     * yakalanır.
     */
    public function run_heartbeat() {
        $this->schedule_sync();
    }

    /**
     * Eklenti güncellendikten sonra senkronu planlar (F6b): güncelleme sonrası hiç ürün
     * düzenlenmezse panel şablonsuz kalırdı ve panel artık TAHMİN üretmediği için "Mağaza panelinde
     * aç" bağlantısı HİÇ çıkmazdı.
     *
     * @param mixed $upgrader Kullanılmaz (hook imzası).
     * @param array $options  WP_Upgrader bağlamı: type/action/plugins.
     */
    public function on_upgrade($upgrader = null, $options = []) {
        unset($upgrader); // hook imzası — kullanılmıyor
        if (!is_array($options)) return;

        $type = isset($options['type']) ? (string) $options['type'] : '';
        if ($type !== 'plugin') return;

        $action = isset($options['action']) ? (string) $options['action'] : '';
        if ($action !== 'update' && $action !== 'install') return;

        // Güncellenen BU eklenti mi? (Başka eklenti güncellemesinde boşuna iş üretme.)
        $touched = [];
        if (!empty($options['plugins']) && is_array($options['plugins'])) {
            $touched = $options['plugins'];
        } elseif (!empty($options['plugin'])) {
            $touched = [(string) $options['plugin']];
        }
        $me = (defined('WPTESLIMAT_FILE') && function_exists('plugin_basename'))
            ? plugin_basename(WPTESLIMAT_FILE)
            : '';
        // Liste boşsa (bağlam bilinmiyor) TEMKİNLİ davranıp planla — planlama ucuz, hash zaten atlar.
        if ($me !== '' && !empty($touched) && !in_array($me, $touched, true)) return;

        self::ensure_heartbeat();
        $this->schedule_sync();
    }

    /**
     * Eklenti AKTİVASYONU tetiği (F6b) — dosya sonundaki register_activation_hook'tan çağrılır.
     * Aktivasyon anında sınıf henüz plugins_loaded'dan örneklenmemiş olabilir → statiktir.
     * Yapılandırılmamış taze kurulumda schedule_sync sessizce çıkar; panele bağlandıktan sonraki
     * ilk ürün düzenlemesi ya da günlük heartbeat kataloğu taşır.
     */
    public static function on_plugin_activated() {
        self::ensure_heartbeat();
        self::instance()->schedule_sync();
    }

    /** Deaktivasyonda heartbeat olayını temizle (yetim zamanlanmış olay kalmasın). */
    public static function on_plugin_deactivated() {
        if (function_exists('wp_clear_scheduled_hook')) {
            wp_clear_scheduled_hook(self::HEARTBEAT_HOOK);
        }
    }

    /**
     * Otomatik senkronu ARKA PLANA ve TEK'e indirger: zaten bekleyen bir katalog senkronu varsa
     * yenisini eklemez → değişken bir üründe onlarca varyasyon kaydı tek push'ta birleşir. Editörü
     * ASLA senkron push ile bloklamaz. Yapılandırılmamış/klon ortamda hiç iş üretmez.
     *
     * $product_id kullanılmaz (full snapshot); yalnız hook imzası için kabul edilir.
     */
    public function schedule_sync($product_id = 0) {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;

        if (function_exists('as_schedule_single_action') && function_exists('as_next_scheduled_action')) {
            // Bekleyen katalog senkronu varsa yenisini planlama (dedupe).
            if (as_next_scheduled_action(self::SYNC_HOOK, null, 'wpteslimat')) {
                return;
            }
            as_schedule_single_action(time() + self::SYNC_DELAY, self::SYNC_HOOK, [], 'wpteslimat');
        } else {
            // Action Scheduler yok (nadir — WooCommerce onu taşır) → wp-cron tek olayı ile dedupe.
            // Yine ARKA PLAN (senkron push YOK) → editör bloklanmaz.
            if (!wp_next_scheduled(self::SYNC_HOOK)) {
                wp_schedule_single_event(time() + self::SYNC_DELAY, self::SYNC_HOOK);
            }
        }
    }

    /**
     * Arka plan iş işleyicisi: kataloğu toplar ve panele push eder. Yapılandırma/klon guard'ı burada
     * DA vardır (planlama ile çalışma arasında ortam değişebilir → çift savunma, order-sync deseni).
     */
    public function run_sync() {
        if (!Wpteslimat_Settings::is_configured()) return;
        if (Wpteslimat_Settings::is_clone()) return;

        $products = $this->collect_products();
        if ($products === null) return; // WooCommerce yok → kataloğu YANLIŞLIKLA boşaltma.

        $payload = $this->build_payload($products);

        // YÜK OPTİMİZASYONU: katalog gerçekten değişmediyse push'u ATLA. woocommerce_update_product
        // her ürün kaydında (stok/fiyat düzenlemesi, sipariş stok düşümü dâhil) tetikler; ama katalog
        // yalnız ürün listesi/ad/sku/tip'i taşır. Hash aynıysa gereksiz HTTP + panelde gereksiz
        // yeniden-yazma olmaz → yoğun mağazada bile katalog yükü sıfıra yakın. (Manuel buton hash'i
        // yok sayar → her zaman zorla tazeler; kurtarma yolu.)
        //
        // İKİ AYRI HASH (F8): ürün hash'i + şablon hash'i. Hash'i gövdenin TAMAMINDAN almak
        // (şablon dâhil) HER tetikte farklı sonuç verebiliyordu: admin_url() şeması
        // `is_ssl() || force_ssl_admin()` ile belirlenir; ters-proxy arkasında wp-admin isteğinde
        // https, Action Scheduler/wp-cron loopback isteğinde http çözülebilir → hash oynar → her
        // ürün kaydında TAM katalog DELETE+INSERT panele giderdi (tam da kaçınmak istediğimiz yük).
        // Şablon hash'i şema-normalize edilir (bkz. template_hash) ve AYRI karşılaştırılır → şablon
        // gerçekten değiştiğinde (HPOS açılıp kapandığında, admin adresi değiştiğinde) senkron YİNE
        // tetiklenir, panel eski/yanlış şablonda kalmaz.
        $products_same = (get_option(self::OPT_HASH) === $payload['product_hash']);
        if ($products_same && get_option(self::OPT_TPL_HASH) === $payload['template_hash']) {
            return; // ne katalog ne şablon değişti — atla
        }
        // REDDEDİLEN ŞABLON FRENİ: panel şablonu reddettiyse hash'i sabitlemiyoruz (bilerek — bir
        // sonraki senkron tekrar denesin, F9). Ama ürünler AYNI kaldığı sürece her ürün kaydı/
        // checkout stok düşümü bunu "değişiklik" sayıp TAM katalog push'u tetiklerdi (F8'in
        // önlemek istediği yük). Yeniden deneme günde bir ile sınırlanır; günlük heartbeat zaten
        // bu pencereyi açar, manuel "Ürünleri Panele Aktar" freni tümüyle yok sayar.
        if ($products_same && self::template_rejected_recently()) {
            return;
        }

        $res  = Wpteslimat_Panel_Client::post('/v1/site-mappings/catalog', $payload['body']);
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        if ($code >= 200 && $code < 300) {
            // Yalnız BAŞARILI push sonrası hash'i sabitle → başarısızsa sonraki tetik yeniden dener.
            $status = self::remember_template_status($res, $payload['template']);
            self::persist_hashes($payload, $status);
        } else {
            // Arka plan — sessiz kalmasın ama sipariş akışını etkilemesin. Bir sonraki ürün
            // düzenlemesi yeniden planlar; kalıcı hata operatöre manuel "Ürünleri Panele Aktar"
            // butonundaki bildirimle görünür olur.
            error_log(sprintf('[wpteslimat] Katalog senkronu başarısız (HTTP %d).', $code));
        }
    }

    /**
     * Manuel tetik işleyicisi (Ayarlar → "Ürünleri Panele Aktar"). Yetki (manage_woocommerce) + nonce +
     * klon/yapılandırma guard; kataloğu toplayıp panele push eder ve sonucu bildirimle geri yönlendirir.
     */
    public function handle_manual_sync() {
        if (!current_user_can('manage_woocommerce')) {
            wp_die(esc_html__('Bu işlem için yetkiniz yok.', 'wpteslimat'), '', ['response' => 403]);
        }
        check_admin_referer('wpteslimat_sync_catalog');

        if (!Wpteslimat_Settings::is_configured()) {
            self::redirect('unconfigured');
        }
        // Klon/staging'den ASLA senkronlama (§7): klon panel kataloğunu ezmesin.
        if (Wpteslimat_Settings::is_clone()) {
            self::redirect('clone');
        }

        $products = $this->collect_products();
        if ($products === null) {
            self::redirect('error', __('WooCommerce bulunamadı.', 'wpteslimat'));
        }

        $payload = $this->build_payload($products);

        $res  = Wpteslimat_Panel_Client::post('/v1/site-mappings/catalog', $payload['body']);
        $code = isset($res['code']) ? (int) $res['code'] : 0;
        if ($code >= 200 && $code < 300) {
            // Manuel push HER ZAMAN gönderir (zorla tazele) ama başarı sonrası hash'leri günceller →
            // hemen ardından tetiklenen otomatik senkron aynı kataloğu tekrar itmez. (run_sync ile
            // AYNI build_payload yolundan geçilir — aksi halde iki yol farklı hash üretip sonsuz
            // push yapardı.)
            $status = self::remember_template_status($res, $payload['template']);
            self::persist_hashes($payload, $status);
            $synced = isset($res['body']['synced']) ? (int) $res['body']['synced'] : count($products);
            self::redirect('ok', (string) $synced);
        }
        // Panel gövde sınırı (1 MB) aşıldı → 413. Sessiz "HTTP 413" yerine anlamlı mesaj: katalog
        // çok büyük; operatör ürün/varyasyon sayısını azaltmalı ya da destekle görüşmeli.
        if ($code === 413) {
            self::redirect('error', sprintf(
                /* translators: %d: gönderilmeye çalışılan ürün+varyasyon satırı sayısı */
                __('Katalog çok büyük (%d ürün/varyasyon) — panel gövde sınırını aştı. Ürün sayısını azaltın veya destekle görüşün.', 'wpteslimat'),
                count($products)
            ));
        }
        $err = (isset($res['body']['error']) && $res['body']['error'] !== '')
            ? (string) $res['body']['error']
            : sprintf(__('HTTP %d', 'wpteslimat'), $code);
        self::redirect('error', $err);
    }

    /**
     * Panele gidecek katalog senkron gövdesini + KARŞILAŞTIRMA HASH'LERİNİ tek noktada kurar.
     * run_sync ve handle_manual_sync AYNI yolu kullanır → iki yol farklı hash üretip sonsuz push
     * yapamaz (F8 şartı).
     *
     * `adminOrderUrlTemplate` OPSİYONELDİR → alanı tanımayan ESKİ panel sürümü onu yok sayar
     * (kırılma yok); tanıyan panel tahmin etmeyi bırakıp mağazanın bildirdiğini kullanır.
     * Şablon güvenle üretilemiyorsa alan HİÇ eklenmez (panel kendi mevcut davranışına düşer).
     *
     * @param array $products collect_products() satırları.
     * @return array{body:array, product_hash:string, template_hash:string, template:string|null}
     */
    private function build_payload(array $products) {
        $body     = ['products' => $products];
        $template = self::admin_order_url_template();
        if ($template !== null) {
            $body['adminOrderUrlTemplate'] = $template;
        }

        return [
            'body'          => $body,
            // Katalog parmak izi YALNIZ ürünlerden (şablon şeması istek bağlamına göre oynayabilir).
            'product_hash'  => md5((string) wp_json_encode($products)),
            'template_hash' => self::template_hash($template),
            'template'      => $template,
        ];
    }

    /**
     * Şablon parmak izi — ŞEMA NORMALİZE edilir (F8). admin_url() şeması
     * `is_ssl() || force_ssl_admin()` ile çözülür; ters-proxy arkasında (Caddy) wp-admin isteğinde
     * https, Action Scheduler/wp-cron loopback isteğinde http gelebilir. Ham değerden hash almak
     * her tetikte "değişti" derdi → gereksiz TAM katalog DELETE+INSERT. Şemayı atarak yalnız
     * GERÇEK değişiklikleri (HPOS açık/kapalı, admin yolu/host) yakalarız.
     *
     * @param string|null $template Gönderilecek şablon (yoksa null).
     * @return string md5 parmak izi.
     */
    private static function template_hash($template) {
        $normalized = ($template === null) ? '' : preg_replace('#^https?://#i', '//', (string) $template);
        return md5((string) $normalized);
    }

    /**
     * Başarılı push sonrası parmak izlerini sabitler.
     *
     * Panel şablonu REDDETTİYSE şablon hash'i SABİTLENMEZ (silinir) → bir sonraki senkron (ör.
     * günlük heartbeat ya da ilk ürün düzenlemesi) yeniden dener; operatör panelde site alan adını
     * düzeltince kendiliğinden toparlar. Ürün hash'i her başarılı push'ta sabitlenir (katalog
     * gerçekten yazıldı).
     *
     * @param array       $payload build_payload() çıktısı.
     * @param string|null $status  Panelin şablon kararı (bilinmiyorsa null → bugünkü davranış).
     */
    private static function persist_hashes(array $payload, $status) {
        update_option(self::OPT_HASH, $payload['product_hash'], false);

        if ($status === 'rejected_host' || $status === 'rejected_format') {
            delete_option(self::OPT_TPL_HASH);
            return;
        }
        update_option(self::OPT_TPL_HASH, $payload['template_hash'], false);
    }

    /**
     * (F9) Panel yanıtındaki ŞABLON DURUMUNU okur ve saklar — ayar sayfası artık koşulsuz
     * "bildirildi" demek yerine panelin GERÇEK kararını gösterir.
     *
     * Panel (bu dalgada) şu alanları döndürür:
     *   adminOrderUrlTemplateAccepted: bool
     *   adminOrderUrlTemplateStatus:   'accepted'|'kept_manual'|'rejected_host'|'rejected_format'|'absent'
     *
     * GERİYE DÖNÜK UYUM: alanları döndürmeyen ESKİ panelde durum "bilinmiyor" kaydedilir (option
     * silinir) → ayar sayfası bugünkü metnine düşer ve hash sabitleme davranışı da bugünküyle
     * AYNI kalır. `accepted=false` TEK BAŞINA belirsizdir (kept_manual, rejected_host,
     * rejected_format, absent — hepsi false üretir) → ondan "reddedildi" TÜRETİLMEZ (yoksa eski
     * panelde sahte uyarı + her senkronda gereksiz yeniden push olurdu).
     *
     * @param array       $res           Panel istemcisi yanıtı (['code'=>int,'body'=>array]).
     * @param string|null $sent_template Bu push'ta gönderilen şablon (yoksa null).
     * @return string|null Normalize edilmiş durum, bilinmiyorsa null.
     */
    private static function remember_template_status(array $res, $sent_template) {
        $body = (isset($res['body']) && is_array($res['body'])) ? $res['body'] : [];

        $status = null;
        if (isset($body['adminOrderUrlTemplateStatus']) && is_string($body['adminOrderUrlTemplateStatus'])
            && in_array($body['adminOrderUrlTemplateStatus'], self::TEMPLATE_STATUSES, true)) {
            $status = $body['adminOrderUrlTemplateStatus'];
        } elseif (isset($body['adminOrderUrlTemplateAccepted']) && $body['adminOrderUrlTemplateAccepted'] === true) {
            // Yalnız TRUE güvenle yorumlanabilir: gönderdiğimiz değer kaydedildi.
            $status = 'accepted';
        }

        if ($status === null) {
            delete_option(self::OPT_TPL_STATUS); // bilinmiyor (eski panel) → bugünkü metne düş
            return null;
        }

        update_option(self::OPT_TPL_STATUS, [
            'status'   => $status,
            'template' => ($sent_template === null) ? '' : (string) $sent_template,
            'time'     => time(),
        ], false);

        return $status;
    }

    /**
     * Saklanan şablon durumunu okur (bozuk/eski biçime karşı savunmalı).
     *
     * @return array{status:string|null, template:string, time:int}
     */
    private static function template_state() {
        $empty = ['status' => null, 'template' => '', 'time' => 0];

        $raw = get_option(self::OPT_TPL_STATUS, null);
        if (!is_array($raw)) return $empty;

        $status = isset($raw['status']) && is_string($raw['status']) ? $raw['status'] : '';
        if (!in_array($status, self::TEMPLATE_STATUSES, true)) return $empty;

        return [
            'status'   => $status,
            'template' => isset($raw['template']) && is_string($raw['template']) ? $raw['template'] : '',
            'time'     => isset($raw['time']) ? (int) $raw['time'] : 0,
        ];
    }

    /**
     * Şablon SON denemede panel tarafından reddedildi mi ve yeniden deneme penceresi henüz açılmadı mı?
     * (run_sync freni — bkz. "REDDEDİLEN ŞABLON FRENİ" notu.)
     */
    private static function template_rejected_recently() {
        $state = self::template_state();
        if ($state['status'] !== 'rejected_host' && $state['status'] !== 'rejected_format') return false;
        if ($state['time'] <= 0) return false; // zaman bilinmiyor → freni uygulama, dene
        return (time() - $state['time']) < self::TPL_RETRY_INTERVAL;
    }

    /**
     * (§12) Mağaza yönetim paneli SİPARİŞ bağlantısı şablonu — `{orderId}` yer tutucusuyla.
     *
     *   HPOS AÇIK  → .../wp-admin/admin.php?page=wc-orders&action=edit&id={orderId}
     *   HPOS KAPALI→ .../wp-admin/post.php?post={orderId}&action=edit
     *
     * admin_url() KULLANILIR → alt-dizin kurulumu, farklı admin adresi (WP_ADMIN_DIR / çoklu-site)
     * ve http/https şeması DOĞRU çözülür; panelin domain'den kök uydurmasına gerek kalmaz.
     *
     * GÜVENLİ TARAF: HPOS durumu tespit EDİLEMİYORSA (WooCommerce yok / eski sürüm / konteyner
     * çözülemedi) ya da üretilen adres panel sözleşmesini (http(s) + düz `{orderId}` + ≤500
     * karakter) sağlamıyorsa null döner → şablon GÖNDERİLMEZ. Yanlış link üretmektense link
     * olmaması yeğlenir (kullanıcı isteği).
     *
     * @return string|null Şablon, ya da güvenle üretilemiyorsa null.
     */
    public static function admin_order_url_template() {
        $hpos = self::hpos_enabled();
        if ($hpos === null) return null; // tespit edilemedi → TAHMİN ETME

        if (!function_exists('admin_url')) return null;

        $path = $hpos
            ? 'admin.php?page=wc-orders&action=edit&id=' . self::ORDER_ID_PLACEHOLDER
            : 'post.php?post=' . self::ORDER_ID_PLACEHOLDER . '&action=edit';

        $url = (string) admin_url($path);

        // ŞEMA KARARLILIĞI (F8): admin_url() şemasını `is_ssl() || force_ssl_admin()` ile çözer →
        // aynı mağazada wp-admin isteği https, Action Scheduler/wp-cron loopback isteği http
        // üretebilir. Bu yalnız hash'i değil PANELE YAZILAN DEĞERİ de oynatır (son koşan bağlam
        // kazanır; operatör bazen http linki alır). İstek bağlamından BAĞIMSIZ kaynak: DB'deki ham
        // `siteurl` (ve force_ssl_admin sabiti). Bilinemiyorsa DOKUNMA (belirsizken dokunma).
        $stable_scheme = self::stable_admin_scheme();
        if ($stable_scheme !== null) {
            $url = function_exists('set_url_scheme')
                ? (string) set_url_scheme($url, $stable_scheme)
                : preg_replace('#^https?://#i', $stable_scheme . '://', $url);
        }

        // admin_url() ham birleştirme yapar (encode etmez) ama 'admin_url' filtresi devredeyse
        // yer tutucu URL-encode edilmiş olabilir → düz metne geri çevir (küçük/büyük harf hex).
        if (strpos($url, self::ORDER_ID_PLACEHOLDER) === false) {
            $url = str_ireplace('%7BorderId%7D', self::ORDER_ID_PLACEHOLDER, $url);
        }

        // Panel sözleşmesi (sites.controller Zod): http(s) ile başlar, `{orderId}` içerir, ≤500 karakter.
        // Herhangi biri sağlanmıyorsa gönderme — panel zaten reddeder, sessiz 400 üretmeyelim.
        if (!preg_match('#^https?://#i', $url)) return null;
        if (strpos($url, self::ORDER_ID_PLACEHOLDER) === false) return null;
        if (strlen($url) > self::MAX_TEMPLATE_LEN) return null;

        return $url;
    }

    /**
     * İstek bağlamından BAĞIMSIZ yönetim paneli şeması (F8 yardımcısı).
     *
     * Sıra: (1) `force_ssl_admin()` → her hâlükârda https · (2) DB'deki ham `siteurl` option'ının
     * şeması (wp-admin / cron / loopback fark etmez, hep aynı değer) · (3) tespit edilemedi → null
     * (çağıran admin_url() şemasına DOKUNMAZ).
     *
     * @return string|null 'https' | 'http' | null
     */
    private static function stable_admin_scheme() {
        if (function_exists('force_ssl_admin') && force_ssl_admin()) return 'https';

        $raw = (string) get_option('siteurl', '');
        if ($raw === '') return null;

        $scheme = parse_url($raw, PHP_URL_SCHEME);
        $scheme = is_string($scheme) ? strtolower($scheme) : '';
        return ($scheme === 'http' || $scheme === 'https') ? $scheme : null;
    }

    /**
     * HPOS (WooCommerce özel sipariş tablosu) etkin mi?
     *
     * Sıra: (1) WooCommerce DI konteynerinden CustomOrdersTableController (kanonik kaynak) →
     * (2) OrderUtil yardımcısı (WooCommerce 6.9+ genel API) → (3) tespit edilemedi.
     *
     * @return bool|null true=HPOS açık, false=klasik (posts), null=TESPİT EDİLEMEDİ (şablon gönderilmez).
     */
    private static function hpos_enabled() {
        $controller = 'Automattic\WooCommerce\Internal\DataStores\Orders\CustomOrdersTableController';
        if (function_exists('wc_get_container') && class_exists($controller)) {
            try {
                $container = wc_get_container();
                if ($container && method_exists($container, 'get')) {
                    $svc = $container->get($controller);
                    if ($svc && method_exists($svc, 'custom_orders_table_usage_is_enabled')) {
                        return (bool) $svc->custom_orders_table_usage_is_enabled();
                    }
                }
            } catch (\Throwable $e) {
                // Konteyner çözümlemesi patlarsa (sürüm farkı) sessizce yardımcıya düş.
            }
        }

        $util = 'Automattic\WooCommerce\Utilities\OrderUtil';
        if (class_exists($util) && method_exists($util, 'custom_orders_table_usage_is_enabled')) {
            try {
                return (bool) call_user_func([$util, 'custom_orders_table_usage_is_enabled']);
            } catch (\Throwable $e) {
                // Yardımcı da patladı → tespit edilemedi.
            }
        }

        return null; // GÜVENLİ taraf: varsayım yapma.
    }

    /**
     * Yayınlanmış ürünlerden panel katalog satırlarını üretir. Bellek güvenli sayfalama (200'lük
     * partiler). Ürün + varyasyon satırları toplamı MAX_PRODUCTS'ta sınırlanır (aşılırsa loglanır).
     *
     * @return array|null Satır dizisi; WooCommerce yoksa null (çağıran push'u atlar → kataloğu boşaltmaz).
     */
    private function collect_products() {
        if (!function_exists('wc_get_products')) return null;

        $rows    = [];
        $page    = 1;
        $per_page = 200;
        $capped  = false;

        while (!$capped) {
            $products = wc_get_products([
                'status'  => 'publish',
                'limit'   => $per_page,
                'page'    => $page,
                'orderby' => 'ID',
                'order'   => 'ASC',
                'return'  => 'objects',
            ]);
            if (empty($products) || !is_array($products)) break;

            foreach ($products as $product) {
                if (!$product) continue;

                if ($product->is_type('variable')) {
                    // PARENT satırı (remoteVariationId = null). collect_lines varyasyon kaleminde
                    // get_parent_id() gönderir → burada da parent id.
                    $rows[] = $this->row(
                        (string) $product->get_id(),
                        null,
                        $product->get_name(),
                        $product->get_sku(),
                        'variable'
                    );
                    // Her varyasyon: remoteProductId = PARENT id, remoteVariationId = varyasyon id.
                    foreach ($product->get_children() as $vid) {
                        $variation = wc_get_product($vid);
                        if (!$variation) continue;
                        $rows[] = $this->row(
                            (string) $product->get_id(),   // PARENT id (collect_lines get_parent_id ile aynı)
                            (string) $variation->get_id(),  // varyasyon id (collect_lines get_id ile aynı)
                            $variation->get_name(),         // parent + öznitelikleri içerir
                            $variation->get_sku(),
                            'variation'
                        );
                    }
                } else {
                    // Basit (ve grouped/external gibi tekil tipler): tek satır. collect_lines'da
                    // get_parent_id() 0 → get_id()'e düşer; katalog da get_id() gönderir → eşleşir.
                    $rows[] = $this->row(
                        (string) $product->get_id(),
                        null,
                        $product->get_name(),
                        $product->get_sku(),
                        'simple'
                    );
                }

                // Sınır kontrolü ürün SINIRINDA (varyasyonlar tam eklendikten sonra) → tutarlı satırlar.
                if (count($rows) >= self::MAX_PRODUCTS) {
                    $capped = true;
                    break;
                }
            }

            if (count($products) < $per_page) break; // son sayfa
            $page++;
        }

        if ($capped) {
            if (count($rows) > self::MAX_PRODUCTS) {
                $rows = array_slice($rows, 0, self::MAX_PRODUCTS);
            }
            error_log(sprintf(
                '[wpteslimat] Katalog senkronu: satır sayısı %d sınırını aştı; katalog kesildi.',
                self::MAX_PRODUCTS
            ));
        }

        return $rows;
    }

    /** Tek katalog satırı üretir; ad 500, sku 120 UTF-16 birimine kırpılır (panel sınırı); boş sku → null. */
    private function row($product_id, $variation_id, $name, $sku, $kind) {
        $name = (string) $name;
        $sku  = ($sku === null) ? '' : (string) $sku;
        return [
            'remoteProductId'   => (string) $product_id,
            'remoteVariationId' => ($variation_id === null) ? null : (string) $variation_id,
            'name'              => self::truncate($name, 500),
            'sku'               => ($sku === '') ? null : self::truncate($sku, 120),
            'kind'              => $kind,
        ];
    }

    /**
     * Panel sınırıyla AYNI BİRİMDE kırpma — UTF-16 KOD BİRİMİ.
     *
     * NEDEN: panel doğrulaması (Zod `.max()/.slice()`) JavaScript dizesi üzerinde çalışır ve UTF-16
     * KOD BİRİMİ sayar; `mb_substr` ise KOD NOKTASI sayar. BMP dışı (astral) bir karakter — emoji,
     * bazı CJK uzantıları — UTF-16'da İKİ birimdir. Yani emoji taşıyan 251 karakterlik bir ürün adı
     * eklentide "251" iken panelde 502 görünür. Panel bu alanı artık kırpıyor (reddetmiyor), ama
     * KIRPMANIN NEREDE olacağını iki tarafın aynı birimde ölçmesi gerekir; aksi halde mağazanın
     * gönderdiği ad ile panelin sakladığı ad sessizce ayrışır ve katalog hash'i (OPT_HASH) her
     * senkronda "değişti" der → gereksiz TAM katalog DELETE+INSERT.
     *
     * Kırpma her zaman KARAKTER SINIRINDA yapılır (yarım karakter üretilmez). mbstring yoksa (çok
     * nadir) ham bayt kesimi çok baytlı karakteri ortadan bölebilir → `wp_check_invalid_utf8()` ile
     * geçersiz kuyruk atılır (class-updater.php `truncate_url()` ile aynı desen).
     */
    private static function truncate($s, $max) {
        $s   = (string) $s;
        $max = (int) $max;
        if ($max <= 0 || $s === '') return '';

        if (!function_exists('mb_substr') || !function_exists('mb_strlen')) {
            if (strlen($s) <= $max) return $s; // bayt sayısı sınırın altındaysa birim sayısı da altındadır
            $cut = substr($s, 0, $max);
            return function_exists('wp_check_invalid_utf8') ? wp_check_invalid_utf8($cut, true) : $cut;
        }

        $chars = mb_strlen($s, 'UTF-8');
        // Hızlı yol (olağan durum): astral karakter yoksa kod noktası = UTF-16 kod birimi.
        if ($chars <= $max && !preg_match('/[\x{10000}-\x{10FFFF}]/u', $s)) return $s;

        $units = 0;
        for ($i = 0; $i < $chars; $i++) {
            $ch = mb_substr($s, $i, 1, 'UTF-8');
            // UTF-8'de 4 baytlık dizi = kod noktası >= U+10000 = UTF-16'da surrogate ÇİFTİ (2 birim).
            $cost = (strlen($ch) === 4) ? 2 : 1;
            if ($units + $cost > $max) return mb_substr($s, 0, $i, 'UTF-8');
            $units += $cost;
        }
        return $s;
    }

    /**
     * Ayarlar sayfasında "Ürün Kataloğu" bölümünü + sonuç bildirimini basar.
     * Settings::page() tarafından çağrılır (bağımlılık tersine değil — buton burada, sır YOK).
     */
    public static function render_settings_section() {
        // Sonuç bildirimi (redirect query arg üzerinden).
        if (isset($_GET['wpteslimat_catalog'])) {
            $flag = sanitize_key(wp_unslash($_GET['wpteslimat_catalog']));
            $msg  = isset($_GET['wpteslimat_msg']) ? sanitize_text_field(wp_unslash($_GET['wpteslimat_msg'])) : '';
            if ($flag === 'ok') {
                echo '<div class="notice notice-success is-dismissible"><p>' . esc_html(sprintf(
                    /* translators: %s: aktarılan ürün sayısı */
                    __('%s ürün panele aktarıldı.', 'wpteslimat'),
                    $msg !== '' ? $msg : '0'
                )) . '</p></div>';
            } elseif ($flag === 'error') {
                echo '<div class="notice notice-error is-dismissible"><p>' . esc_html(
                    $msg !== ''
                        ? sprintf(__('Ürünler panele aktarılamadı: %s', 'wpteslimat'), $msg)
                        : __('Ürünler panele aktarılamadı.', 'wpteslimat')
                ) . '</p></div>';
            } elseif ($flag === 'clone') {
                echo '<div class="notice notice-warning is-dismissible"><p>' .
                    esc_html__('Klon/staging koruması etkin — katalog panele aktarılmadı.', 'wpteslimat') . '</p></div>';
            } elseif ($flag === 'unconfigured') {
                echo '<div class="notice notice-error is-dismissible"><p>' .
                    esc_html__('Önce panele bağlanın; katalog aktarımı yapılandırma gerektirir.', 'wpteslimat') . '</p></div>';
            }
        }

        $configured = Wpteslimat_Settings::is_configured();
        $is_clone   = Wpteslimat_Settings::is_clone();
        ?>
        <hr>
        <h2><?php esc_html_e('Ürün Kataloğu', 'wpteslimat'); ?></h2>
        <p><?php esc_html_e('Mağazadaki yayınlanmış ürünleri (ve varyasyonlarını) panele aktarır; böylece panelde ürünleri sipariş beklemeden, adıyla proaktif olarak eşleyebilirsiniz. Yalnız ürün adı, SKU ve tip gönderilir — sır, fiyat veya lisans verisi gönderilmez. Tam anlık görüntüdür (panel bu sitenin kataloğunu değiştirir). Ürün eklendiğinde/güncellendiğinde/silindiğinde, eklenti güncellendiğinde ve günde bir kez arka planda otomatik de senkronlanır (katalog değişmediyse panele istek gönderilmez).', 'wpteslimat'); ?></p>
        <?php
        // Şeffaflık: panele hangi sipariş bağlantısı şablonunun bildirildiğini VE panelin bu
        // şablonu kabul edip etmediğini operatör görsün (yanlış/eksik link şikâyetinde ilk
        // bakılacak yer). Sır içermez — yalnız admin adresi.
        $order_url_template = self::admin_order_url_template();
        $tpl_state = self::template_state();
        $tpl_status = $tpl_state['status'];
        ?>
        <?php if ($order_url_template === null): ?>
            <p><em><?php esc_html_e('Sipariş bağlantısı şablonu belirlenemedi (WooCommerce sürümü desteklemiyor) — panele gönderilmiyor. Panelde site ayarlarından elle tanımlayabilirsiniz.', 'wpteslimat'); ?></em></p>
        <?php elseif ($tpl_status === 'accepted'): ?>
            <p>
                <?php esc_html_e('Sipariş bağlantısı şablonu panele bildirildi ve kabul edildi:', 'wpteslimat'); ?>
                <code><?php echo esc_html($order_url_template); ?></code>
            </p>
        <?php elseif ($tpl_status === 'kept_manual'): ?>
            <p>
                <?php esc_html_e('Panelde elle girilmiş şablon kullanılıyor; mağazanın bildirdiği değer yok sayıldı.', 'wpteslimat'); ?>
                <br><span class="description"><?php
                    /* translators: %s: mağazanın panele bildirdiği şablon */
                    printf(esc_html__('Mağazanın bildirdiği: %s', 'wpteslimat'), '<code>' . esc_html($order_url_template) . '</code>');
                ?></span>
            </p>
        <?php elseif ($tpl_status === 'rejected_host'): ?>
            <div class="notice notice-warning inline"><p>
                <?php esc_html_e('Panel sipariş bağlantısı şablonunu reddetti — panelde kayıtlı site alan adı ile mağaza adresi eşleşmiyor olabilir. Panelde site alan adını güncelleyin.', 'wpteslimat'); ?>
                <br><code><?php echo esc_html($order_url_template); ?></code>
            </p></div>
        <?php elseif ($tpl_status === 'rejected_format'): ?>
            <div class="notice notice-warning inline"><p>
                <?php esc_html_e('Panel sipariş bağlantısı şablonunu reddetti (biçim).', 'wpteslimat'); ?>
                <br><code><?php echo esc_html($order_url_template); ?></code>
            </p></div>
        <?php elseif ($tpl_status === 'absent'): ?>
            <p><em><?php esc_html_e('Şablon belirlenemedi; panelde elle tanımlayın.', 'wpteslimat'); ?></em></p>
        <?php else: ?>
            <?php // Durum bilinmiyor: henüz senkron yapılmadı ya da panel sürümü durum döndürmüyor. ?>
            <p>
                <?php esc_html_e('Panele bildirilen sipariş bağlantısı şablonu:', 'wpteslimat'); ?>
                <code><?php echo esc_html($order_url_template); ?></code>
            </p>
        <?php endif; ?>
        <?php if (!$configured): ?>
            <p><em><?php esc_html_e('Önce panele bağlanın.', 'wpteslimat'); ?></em></p>
        <?php elseif ($is_clone): ?>
            <p><em><?php esc_html_e('Klon/staging koruması etkin — bu sitede katalog aktarımı devre dışı.', 'wpteslimat'); ?></em></p>
        <?php else: ?>
            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="wpteslimat_sync_catalog">
                <?php wp_nonce_field('wpteslimat_sync_catalog'); ?>
                <?php submit_button(__('Ürünleri Panele Aktar', 'wpteslimat'), 'secondary', 'submit', false); ?>
            </form>
        <?php endif; ?>
        <?php
    }

    /** Ayar sayfasına sonuç bayrağıyla (ve varsa mesajla) geri yönlendirir (connect deseniyle simetrik). */
    private static function redirect($flag, $detail = '') {
        $url = add_query_arg('wpteslimat_catalog', $flag, admin_url('options-general.php?page=wpteslimat'));
        if ($detail !== '') {
            $url = add_query_arg('wpteslimat_msg', rawurlencode($detail), $url);
        }
        wp_safe_redirect($url);
        exit;
    }
}

// ── Aktivasyon/deaktivasyon tetikleri (F6b) ──────────────────────────────────────────────────
// Aktivasyon isteğinde eklenti dosyası yüklenir ama `plugins_loaded` çoktan geçmiştir → sınıf
// örneklenmez. Bu yüzden kanca DOSYA DÜZEYİNDE, statik geri çağırmayla kaydedilir (ana eklenti
// dosyasına dokunmaya gerek yok). Aktivasyonda: heartbeat cron'u + ilk katalog senkronu planlanır
// → yeni kurulumda panel şablonsuz/katalogsuz kalmaz. Deaktivasyonda heartbeat temizlenir.
if (defined('WPTESLIMAT_FILE') && function_exists('register_activation_hook')) {
    register_activation_hook(WPTESLIMAT_FILE, ['Wpteslimat_Catalog_Sync', 'on_plugin_activated']);
    register_deactivation_hook(WPTESLIMAT_FILE, ['Wpteslimat_Catalog_Sync', 'on_plugin_deactivated']);
}
