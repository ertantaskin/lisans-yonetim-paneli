import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Rocket,
  Workflow,
  Plug,
  Boxes,
  PackagePlus,
  Link2,
  ShoppingCart,
  ClipboardCheck,
  RefreshCw,
  Truck,
  Wrench,
  Users,
  BarChart3,
  FileText,
  ShieldCheck,
  Keyboard,
  Lightbulb,
} from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Card, CardContent, CardHeader, CardDescription } from '../../components/ui/card';

export const dynamic = 'force-static';

/**
 * Kullanım Rehberi (/guide) — panel içi statik kılavuz. Operatörün tüm iş akışını
 * (site bağlama → ürün/stok → eşleme → sipariş/teslimat → inceleme/değişim → tedarik →
 * rapor/güvenlik) tek sayfada, gerçek sayfalara bağlantılarla anlatır. Salt-sunum; veri çekmez.
 */

const TOC: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'genel', label: 'Panel nasıl çalışır', icon: Workflow },
  { id: 'kurulum', label: 'İlk kurulum: site bağlama', icon: Plug },
  { id: 'urunler', label: 'Ürünler', icon: Boxes },
  { id: 'stokgiris', label: 'Stok girişi', icon: PackagePlus },
  { id: 'esleme', label: 'Ürün eşleştirme', icon: Link2 },
  { id: 'siparis', label: 'Siparişler ve teslimat', icon: ShoppingCart },
  { id: 'inceleme', label: 'İnceleme kuyruğu ve kota', icon: ClipboardCheck },
  { id: 'degisim', label: 'Değişim ve garanti', icon: RefreshCw },
  { id: 'tedarik', label: 'Tedarik zinciri', icon: Truck },
  { id: 'duzeltme', label: 'Stok düzeltmeleri', icon: Wrench },
  { id: 'musteri', label: 'Müşteriler', icon: Users },
  { id: 'rapor', label: 'Raporlar ve izleme', icon: BarChart3 },
  { id: 'sablon', label: 'Şablonlar ve ayarlar', icon: FileText },
  { id: 'surum', label: 'Sürüm ve dağıtım', icon: Rocket },
  { id: 'guvenlik', label: 'Güvenlik ilkeleri', icon: ShieldCheck },
  { id: 'kisayol', label: 'Kısayollar ve ipuçları', icon: Keyboard },
];

/** Bölüm kartı — başlık + ikon + açıklama + içerik. */
function Section({
  id,
  icon: Icon,
  title,
  description,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Card id={id} className="scroll-mt-24">
      <CardHeader>
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </h2>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="space-y-3 text-sm leading-relaxed text-foreground/90">
        {children}
      </CardContent>
    </Card>
  );
}

/** Numaralı adım listesi. */
function Steps({ children }: { children: React.ReactNode }) {
  return (
    <ol className="ml-1 list-inside list-decimal space-y-1.5 marker:font-medium marker:text-muted-foreground">
      {children}
    </ol>
  );
}

/** Madde listesi. */
function Bullets({ children }: { children: React.ReactNode }) {
  return <ul className="ml-1 list-inside list-disc space-y-1.5 marker:text-muted-foreground">{children}</ul>;
}

/** İpucu / not kutusu. */
function Tip({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-warning" />
      <div>{children}</div>
    </div>
  );
}

/** Sayfa içi bağlantı (gerçek rota). */
function R({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="font-medium text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground">
      {children}
    </Link>
  );
}

export default function GuidePage() {
  return (
    <div className="space-y-5">
      <PageHeader
        icon={BookOpen}
        title="Kullanım Rehberi"
        description="Panelin uçtan uca nasıl kullanılacağı: site bağlamadan sipariş teslimatına, değişimden raporlara kadar tüm akış."
      />

      {/* İçindekiler */}
      <Card>
        <CardHeader>
          <h2 className="text-sm font-semibold text-foreground">İçindekiler</h2>
          <CardDescription>Bir başlığa tıklayarak ilgili bölüme atlayın.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
            {TOC.map((t) => (
              <a
                key={t.id}
                href={`#${t.id}`}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-foreground/80 transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <t.icon className="size-4 text-muted-foreground" />
                {t.label}
              </a>
            ))}
          </div>
        </CardContent>
      </Card>

      <Section
        id="genel"
        icon={Workflow}
        title="Panel nasıl çalışır"
        description="Merkezî lisans dağıtım mantığı ve satış kanallarıyla (mağaza) ilişkisi."
      >
        <p>
          Bu panel, dijital lisansların (Windows/Office key, hesap, kod) tek doğruluk kaynağıdır.
          Ödeme ve sepet tamamen <strong>mağaza (satış kanalı)</strong> tarafındadır; panel ödemeye
          dokunmaz, yalnızca <strong>ödenmiş siparişi görür ve teslim eder</strong>. Panel{' '}
          <strong>platform-bağımsızdır</strong>: mağaza tarafı jenerik imzalı (HMAC) API ile konuşur —
          bugün hazır entegrasyon <strong>WooCommerce eklentisi</strong>dir; başka platformlar için de
          aynı kontratı konuşan bir eklenti/adaptör eklenebilir.
        </p>
        <p className="font-medium text-foreground">Tipik akış:</p>
        <Steps>
          <li>Müşteri mağazada öder → sipariş imzalı (HMAC) olarak panele iletilir.</li>
          <li>Panel, siteye+ürüne uygun stoktan <strong>atomik</strong> bir lisans ayırır (aynı key iki kez satılamaz).</li>
          <li>Müşteri, mağaza hesabındaki &quot;Siparişlerim&quot; ekranında çözülmüş lisansı görür.</li>
          <li>Panel, sipariş durumunu geri kanaldan (webhook) mağazaya bildirir.</li>
        </Steps>
        <Tip>
          Lisans verisi <strong>asla</strong> mağaza veritabanında durmaz; her zaman panelde şifreli
          tutulur. Bu yüzden bir key yalnızca panelden yönetilir (görüntüleme, askıya alma, iptal).
        </Tip>
      </Section>

      <Section
        id="kurulum"
        icon={Plug}
        title="İlk kurulum: site bağlama"
        description="Bir mağazayı (satış kanalı) panele güvenli şekilde bağlama."
      >
        <Steps>
          <li>
            <R href="/sites/new">Kanallar / Siteler → Yeni Site</R> sihirbazını açın. 3 adımdır:
            site bilgileri → tek kullanımlık <strong>bağlan kodu</strong> → bağlantı testi.
          </li>
          <li>
            WordPress&apos;te teslimat eklentisini kurup <strong>Ayarlar &rsaquo; Teslimat Eklentisi</strong>{' '}altında <strong>&quot;Panele Bağlan&quot;</strong>{' '}
            alanına bu kodu girin. Kod 15 dakika geçerlidir ve tek kullanımlıktır.
          </li>
          <li>
            Sihirbazın son adımındaki <strong>Bağlantı Testi</strong> yeşilse mağaza hazırdır.
          </li>
        </Steps>
        <p>
          Bağlı bir sitenin ayarlarını <R href="/sites">Siteler</R> listesinden açıp düzenleyebilirsiniz:
          günlük satış kotası, gönderen e-posta, geri kanal webhook adresi ve <strong>sandbox (test modu)</strong>.
          Sandbox açıkken o siteden gelen siparişler gerçek teslimat/mail üretmez.
        </p>
        <Tip>
          Bir siteyi klonlar/staging&apos;e kopyalarsanız, klon ortam otomatik olarak panele{' '}
          <strong>yazma yapmaz</strong> (iade/iptal canlı lisansı geri almaz). Bu koruma yerleşiktir.
        </Tip>
      </Section>

      <Section
        id="urunler"
        icon={Boxes}
        title="Ürünler"
        description="Ürün tanımlama ve ürün detay sayfasının ne işe yaradığı."
      >
        <p>
          <R href="/stock">Stok &amp; Ürünler</R> ekranı ürün listesidir. Sağ üstteki{' '}
          <strong>&quot;Yeni Ürün&quot;</strong> ile ürün oluşturursunuz. Formdaki alanlar 4 bölümde toplanır:
        </p>
        <Bullets>
          <li><strong>Temel bilgiler:</strong> SKU, ad, ürün tipi (lisans anahtarı / hesap / kod / özel), kullanım modu, teslimat politikası.</li>
          <li><strong>Kullanım modu:</strong> <em>Tek kullanımlık</em> (1 key = 1 müşteri) veya <em>Çok kullanımlık (MAK)</em> (1 key = N teslim, kapasite).</li>
          <li><strong>Teslimat politikası:</strong> stok siparişe yetmezse ne olacağı — kısmi otomatik, kısmi onaylı, ya da ya hep ya hiç.</li>
          <li><strong>Hesap alanları:</strong> hesap ürünlerinde müşteriye teslim edilecek alanlar (ör. kullanıcı adı, parola). &quot;Gizli&quot; işaretli alanlar panelde maskelenir; &quot;Zorunlu&quot; kaldırılırsa alan opsiyonel olur.</li>
          <li><strong>Süre &amp; garanti:</strong> süreli hesaplar için geçerlilik (gün) + süre bitince davranışı, garanti (Sorun Bildir) penceresi, düşük stok eşiği.</li>
          <li><strong>Stok &amp; gelişmiş:</strong> stoksuz/ön sipariş + yayın tarihi, key format doğrulaması (regex).</li>
        </Bullets>
        <p>
          Listedeki <strong>Detay</strong> bağlantısı o ürünün <strong>yönetim merkezini</strong> açar:
          stok kırılımı, satış hızı/tükenme tahmini, site eşlemeleri, ürünün partileri ve satın alma
          emirleri, stok düzeltmeleri ve <strong>lisans envanteri</strong> (tek tek anahtar/hesap kalemleri).
        </p>
        <p>
          Anahtar/hesap eklemek ayrı bir ekranda yapılır: <R href="/stock/import">Stok Girişi</R>. Ürün
          detayındaki <strong>&quot;Bu ürüne stok gir&quot;</strong> düğmesi de aynı ekranı, ürün
          ön-seçili olarak açar. Ayrıntı için bir sonraki bölüme bakın.
        </p>
        <Tip>
          Geçersiz kılınan (void) ve değiştirilen ölü anahtarlar silinmez;{' '}
          <R href="/quarantine">Karantina</R> ekranında sebebi ve kaynak siparişiyle birlikte durur.
        </Tip>
      </Section>

      <Section
        id="stokgiris"
        icon={PackagePlus}
        title="Stok girişi (anahtar/hesap ekleme)"
        description="Yeni anahtar/hesabın panele girildiği tek ekran — iki yol: hızlı giriş ve tedarikli giriş."
      >
        <p>
          <R href="/stock/import">Stok Girişi</R> sol menüde <strong>Envanter</strong> altındadır. Ürün
          detayındaki <strong>&quot;Bu ürüne stok gir&quot;</strong> ve <R href="/batches">Partiler</R>{' '}
          listesindeki <strong>&quot;Bu partiye stok gir&quot;</strong> bağlantıları da aynı ekranı ürün
          (ve varsa parti) ön-seçili açar.
        </p>
        <Steps>
          <li>Ürünü seçin (ad veya SKU ile aranır).</li>
          <li>
            <strong>Tedarik bilgisi</strong> adımında yolu seçin: <em>Partisiz</em>, <em>Yeni parti</em>{' '}
            veya <em>Mevcut parti</em> (aşağıda açıklanıyor).
          </li>
          <li>
            Anahtarları yapıştırın ya da <strong>.txt / .csv</strong> yükleyin. Hesap ürünlerinde satırlar
            alan-alan girilir (ör. kullanıcı adı + parola).
          </li>
          <li>
            <strong>&quot;Önizle (kuru çalıştır)&quot;</strong> ile doğrulayın: kaç anahtar kabul edilecek,
            kaçı mükerrer, kaçı reddedilecek. <strong>Hiçbir şey kaydedilmez.</strong>
          </li>
          <li>
            <strong>&quot;Onayla ve Dağıt&quot;</strong> ile girişi tamamlayın. Stok girer girmez bekleyen
            siparişler otomatik tamamlanmaya başlar.
          </li>
        </Steps>
        <p className="font-medium text-foreground">İki yol:</p>
        <Bullets>
          <li>
            <strong>Hızlı giriş (Partisiz):</strong> yalnız anahtarları girersiniz. Tedarikçi ve maliyet
            izi <strong>tutulmaz</strong> → bu anahtarlar maliyet raporlarında{' '}
            <strong>&quot;kapsanamayan&quot;</strong> görünür ve bu sonradan düzeltilemez; geri çekme
            (recall) ve tedarikçi karnesi de bu girişi kapsamaz. Elinizde maliyet/tedarikçi bilgisi yoksa
            veya tekil/deneme anahtarı giriyorsanız uygundur.
          </li>
          <li>
            <strong>Tedarikli giriş (Yeni parti):</strong> tedarikçi + alım tarihi + parti etiketi + birim
            maliyet girersiniz. Panel aynı adımda <strong>teslim alınmış</strong> bir{' '}
            <strong>Satın Alma Emri</strong> ve ona bağlı bir <strong>Parti</strong> açar; anahtarlar o
            partiye bağlanır. Maliyet raporu, tedarikçi karnesi ve geri çekme bu girişi kapsar.
          </li>
          <li>
            <strong>Mevcut parti:</strong> daha önce açılmış bir partiye ek anahtar girersiniz. Yalnız o
            ürünün <em>aktif</em> partileri listelenir (geri çekilmiş/iptal partiye ekleme yapılamaz).
          </li>
        </Bullets>
        <Tip>
          Tedarikli girişte açılan emir ve parti, listelerde <strong>&quot;Otomatik&quot;</strong> rozetiyle
          işaretlenir: mal zaten girilmiştir, bu emir ikinci kez <em>&quot;Teslim Al&quot;</em> istemez.
          Tedarikçi alanına yeni bir ad yazarsanız aynı adlı kayıt varsa yeniden kullanılır, yoksa
          oluşturulur. Birim maliyeti <strong>lira</strong> olarak girin (ör. 12,50) — panel kuruşa kendisi çevirir.
        </Tip>
      </Section>

      <Section
        id="esleme"
        icon={Link2}
        title="Ürün eşleştirme"
        description="Mağaza ürününü panel ürününe bağlama — teslimat bu bağa göre yapılır."
      >
        <p>
          Panel, gelen bir siparişin hangi panel ürününü teslim edeceğini <strong>eşlemeden</strong> bulur:{' '}
          <strong>Site</strong> + <strong>mağaza ürünü</strong> (varsa <strong>varyasyonu</strong>) → panel
          ürünü. <strong>Paket adedi</strong> ise 1 mağaza kaleminin kaç lisans teslim edeceğidir (varsayılan 1).
        </p>
        <p className="font-medium text-foreground">Eşleme iki yerden yapılır:</p>
        <Bullets>
          <li>
            <strong><R href="/mappings">Ürün Eşleştirme</R> ekranı:</strong> site seçersiniz, mağazanın
            ürün kataloğunu <strong>adıyla</strong> görüp sipariş beklemeden eşlersiniz. Aynı ekranda
            &quot;siparişte geldi ama eşlenmemiş&quot; ürünler ve <strong>eşleme bekleyen sipariş
            satırları</strong> listelenir; eşlemeyi kurduğunuzda bu eski satırlar geriye dönük çözülür.
          </li>
          <li>
            <strong>Ürün detayı → Site Eşlemeleri kartı:</strong> tek bir ürünün eşlemelerini yönetmek için —
            yeni eşleme ekleme (paket adedi ile), pasifleştirme/etkinleştirme ve kaldırma.
          </li>
        </Bullets>
        <Tip>
          Mağaza ürün ID&apos;sini <strong>elle yazmazsınız</strong> — mağazanın bildirdiği katalogdan/gerçek
          siparişten gelir (yazım hatası riski yok). <strong>Otomatik eşleştirme yoktur:</strong> hangi mağaza
          ürününün hangi lisansı teslim edeceğine her zaman operatör karar verir. Eşli olmayan bir ürünün
          siparişi <strong>teslim edilmez</strong>, bekleyen olarak kalır — yanlış lisans gitmez.
        </Tip>
      </Section>

      <Section
        id="siparis"
        icon={ShoppingCart}
        title="Siparişler ve teslimat"
        description="Sipariş durumları, kısmi teslimat ve bekleyen işler."
      >
        <p>
          <R href="/orders">Siparişler</R> tüm siparişleri (arama, filtre, sıralama ile) listeler; bir
          siparişe tıklayınca kalemler, atanan lisanslar, zaman çizelgesi ve gönderilen mailler görünür.
        </p>
        <Bullets>
          <li><strong>Durumlar:</strong> Bekliyor → Kısmi teslim → Tamamlandı (stok geldikçe otomatik ilerler).</li>
          <li>
            <strong><R href="/pending">Bekleyen Teslimatlar</R>:</strong> teslim edilememiş siparişler — iki
            sebebi olur: <em>stok yetmiyor</em> (stok gelince otomatik tamamlanır; elle{' '}
            <strong>&quot;Kalanları Ata&quot;</strong> da yapabilirsiniz) veya{' '}
            <em>mağaza ürünü eşlenmemiş</em> (satırda <strong>&quot;Eşleştir&quot;</strong> ile{' '}
            <R href="/mappings">Ürün Eşleştirme</R> ekranına geçip bağlarsınız).
          </li>
          <li>
            Sipariş detayında lisans doğrudan görünür (&quot;owner&quot; rolünde açık, diğer yöneticilerde
            maskeli) ve her görüntüleme <strong>denetim günlüğüne</strong> yazılır. Satır aksiyonları:{' '}
            <strong>Değiştir</strong>, <strong>Askıya Al</strong>, <strong>İptal</strong>; sipariş
            genelinde <strong>Maili Yeniden Gönder</strong>.
          </li>
        </Bullets>
        <Tip>
          Kısmi teslimat birinci sınıf bir akıştır: <em>kısmi otomatik</em> ürünlerde eldeki kadar teslim
          edilir, kalanı stok gelince tamamlanır. <em>Ya hep ya hiç</em> ürünlerde ya tamamı teslim edilir ya hiçbiri.
        </Tip>
      </Section>

      <Section
        id="inceleme"
        icon={ClipboardCheck}
        title="İnceleme kuyruğu ve satış kotası"
        description="Anormal hacmi otomatik teslim yerine manuel onaya alma."
      >
        <p>
          Site ayarlarında <strong>günlük satış kotası</strong> ve isteğe bağlı <strong>dinamik kota</strong>{' '}
          tanımlayabilirsiniz. Dinamik kota açıkken, son 30 günün ortalamasına göre eşik aşılırsa sipariş{' '}
          <strong>reddedilmez</strong>; <R href="/review">İnceleme Kuyruğu</R>&apos;na alınır (atama yapılmaz).
        </p>
        <Steps>
          <li>Kuyruktaki siparişi inceleyin.</li>
          <li><strong>Onayla</strong> → sipariş normal teslimat akışına girer (stok varsa hemen atanır).</li>
          <li><strong>Reddet</strong> → sipariş iptal edilir, lisans verilmez.</li>
        </Steps>
        <Tip>
          İlke: <strong>&quot;AI/sistem önerir, insan onaylar.&quot;</strong> Otomatik reddetme/askıya alma yoktur;
          şüpheli hacim yalnızca incelemeye alınır. Dinamik kota varsayılan olarak kapalıdır.
        </Tip>
      </Section>

      <Section
        id="degisim"
        icon={RefreshCw}
        title="Değişim ve garanti"
        description="Kusurlu lisansı taze biriyle değiştirme."
      >
        <Bullets>
          <li><strong>Müşteri talebi:</strong> müşteri My Account&apos;ta &quot;Sorun Bildir&quot; ile talep açar → <R href="/support">Destek</R> kuyruğunda görünür. Onayla / Reddet / Bilgi İste yapabilirsiniz. Onay, garanti penceresi içinde ve stok varsa çalışır.</li>
          <li><strong>Proaktif değişim:</strong> müşteri beklemeden, sipariş detayında bir atamayı <strong>&quot;Değiştir&quot;</strong> ile aynı üründen taze bir key ile değiştirebilirsiniz. Eski key karantinaya alınır, değişim geçmişi tutulur.</li>
        </Bullets>
        <Tip>
          Değişimde eski key iptal edilir ama satır &quot;iade&quot; sayılmaz; taze key aynı siparişe atanır.
          Stok yoksa işlem güvenle durur (eski key korunur) ve size bildirilir.
        </Tip>
      </Section>

      <Section
        id="tedarik"
        icon={Truck}
        title="Tedarik zinciri"
        description="Tedarikçi, satın alma emri, parti ve geri çekme — ve hangisinin ne zaman gerektiği."
      >
        <p className="font-medium text-foreground">Önce hangi yolu kullanacağınıza karar verin:</p>
        <Bullets>
          <li>
            <strong>Mal zaten elinizdeyse</strong> (anahtarları aldınız, girmek istiyorsunuz):{' '}
            <R href="/stock/import">Stok Girişi</R> yeter. Tedarikçi + tarih + maliyet girerseniz panel
            arka planda <strong>teslim alınmış</strong> bir Satın Alma Emri ve bir Parti açar — ayrıca emir
            açmanıza gerek yoktur. Bu kayıtlar listelerde <strong>&quot;Otomatik&quot;</strong> rozetlidir.
          </li>
          <li>
            <strong>Önceden sipariş verip malı sonra alacaksanız</strong> (ya da mal parça parça
            gelecekse): <R href="/purchase-orders">Satın Alma Emri</R> akışını kullanın. Emri açarsınız
            (beklenen adet + ETA), mal geldikçe <strong>kısmi teslim alırsınız</strong>; her teslim alma
            bir <strong>Parti</strong> oluşturur ve anahtarları o partiye girersiniz. Fazla teslim alma kilitlidir.
          </li>
        </Bullets>
        <p className="font-medium text-foreground">Ekranlar:</p>
        <Bullets>
          <li><strong><R href="/suppliers">Tedarikçiler</R>:</strong> tedarikçi kartı + karne (teslim performansı, geri-çekilme oranı, para birimi başına maliyet).</li>
          <li><strong><R href="/purchase-orders">Satın Alma</R>:</strong> açık/kapalı emirler ve teslim alma. &quot;Otomatik&quot; rozetli emirlerde teslim alma adımı yoktur (mal zaten girilmiştir).</li>
          <li><strong><R href="/batches">Partiler</R>:</strong> stok partileri — hangi anahtar hangi tedarikçiden, ne zaman geldi. Bir parti sorunluysa <strong>geri çekin</strong> (recall) → o partinin satılmamış anahtarları geçersiz olur; satılanlar için toplu değiştirme sihirbazı vardır.</li>
        </Bullets>
        <Tip>
          Partisiz (hızlı) giriş yaparsanız o anahtarlar hiçbir partiye bağlanmaz: maliyet raporunda
          &quot;kapsanamayan&quot; sayılır, geri çekme ve tedarikçi karnesi de onları kapsamaz. İzlenebilirlik
          istiyorsanız girişte tedarikçi ve maliyeti doldurun.
        </Tip>
      </Section>

      <Section
        id="duzeltme"
        icon={Wrench}
        title="Stok düzeltmeleri"
        description="Manuel, sebepli ve denetlenen stok müdahaleleri."
      >
        <p>
          Ürün detayındaki <strong>Stok Düzeltme Ekle</strong> ile elle müdahale yaparsınız:{' '}
          <em>düzeltme</em>, <em>geçersiz kıl (void)</em>, <em>hasarlı</em> veya <em>geri çekme</em>. Sebep
          zorunludur ve her kayıt <strong>denetim (audit) günlüğüne</strong> yazılır.
        </p>
        <Tip>
          Stokun <strong>gerçekten</strong> düşmesi için &quot;Stoktan düşülecek lisans&quot; alanında ilgili
          anahtarı seçmelisiniz; boş bırakırsanız kayıt yalnız deftere yazılır, stok değişmez (ekran bunu
          satır satır belirtir). Düşülen anahtarlar <R href="/quarantine">Karantina</R> ekranında görünür.
        </Tip>
      </Section>

      <Section
        id="musteri"
        icon={Users}
        title="Müşteriler"
        description="Müşteri 360 görünümü ve risk işaretleri."
      >
        <p>
          <R href="/customers">Müşteriler</R> ve müşteri detay sayfası, bir e-postaya bağlı tüm siparişleri,
          değişim taleplerini, <strong>risk skorunu</strong> (okuma-anında, tavsiye niteliğinde) ve değişim
          oranı gibi suistimal işaretlerini gösterir. Müşteriye etiket ve not ekleyebilirsiniz.
        </p>
        <Tip>Risk skoru yalnızca bilgilendirir; otomatik bir eylem tetiklemez.</Tip>
      </Section>

      <Section
        id="rapor"
        icon={BarChart3}
        title="Raporlar ve izleme"
        description="Stok, satış hızı, maliyet, anomali ve operasyon sağlığı."
      >
        <Bullets>
          <li><strong><R href="/reports">Raporlar</R>:</strong> stok, satış hızı ve tükenme tahmini.</li>
          <li><strong><R href="/reports/costs">Maliyet Raporu</R>:</strong> tedarik harcaması + stok değerleme + teslim edilen mal maliyeti. Satış fiyatı panelde yoktur (ödeme mağaza tarafında) → kâr değil <strong>maliyet</strong> gösterilir. Tedarikçi/maliyet bilgisi olmadan (partisiz) girilen stok burada <strong>&quot;kapsanamayan&quot;</strong> olarak dürüstçe ayrı gösterilir.</li>
          <li><strong><R href="/notifications">Bildirimler</R>:</strong> düşük stok ve kritik olaylar (Telegram tanımlıysa oraya da düşer).</li>
          <li><strong><R href="/security">Güvenlik</R>:</strong> anomali/velocity tespiti ve güvenlik olayları (otomatik askıya alma yok).</li>
          <li><strong><R href="/ops">Başarısız İşler</R>:</strong> başarısız iş/webhook kuyruğu ve yeniden deneme (replay).</li>
          <li><strong><R href="/ai">AI Operasyon</R>:</strong> destek triyajı, doğal dilden rapor, günlük anomali özeti — <em>yalnızca öneri</em>, varsayılan kapalıdır.</li>
        </Bullets>
      </Section>

      <Section
        id="sablon"
        icon={FileText}
        title="Şablonlar ve ayarlar"
        description="Teslimat maili şablonları ve panel ayarları."
      >
        <Bullets>
          <li><strong><R href="/templates">Şablonlar</R>:</strong> teslimat maili şablonlarını düzenleyin, canlı önizleyin ve test maili gönderin. Şablonda kullandığınız desteklenmeyen bir değişken varsa uyarılırsınız (gönderimde boş çıkar).</li>
          <li><strong><R href="/settings">Ayarlar</R>:</strong> panel geneli durum ve yapılandırma.</li>
          <li><strong><R href="/admins">Yöneticiler</R>:</strong> (yalnız &quot;owner&quot; rolüne görünür) çoklu-admin yönetimi, rol ve erişim.</li>
        </Bullets>
      </Section>

      <Section
        id="surum"
        icon={Rocket}
        title="Sürüm ve dağıtım"
        description="Mağaza eklentisinin güncellenmesi ve panelin kendi dağıtımı."
      >
        <Bullets>
          <li><strong><R href="/releases">Sürümler</R> → &quot;Kaynaktan yayınla&quot;:</strong> tek tuşla yeni eklenti sürümü yayınlar. Dosya hazırlamanız gerekmez — sunucu, depodaki eklenti kodundan paketi kendisi üretir. Sürüm numarası kodda tanımlıdır, formda girilmez.</li>
          <li><strong>Sitelerdeki kurulu sürüm:</strong> aynı sayfadaki tablo her mağazanın hangi eklenti sürümünü çalıştırdığını gösterir (&quot;güncel&quot; / &quot;eski&quot;). Bilgi, mağazanın panele yaptığı imzalı isteklerden gelir.</li>
          <li><strong>Mağaza tarafı:</strong> yayınlanan sürüm WordPress → Güncellemeler ekranında görünür. WordPress sürüm bilgisini 12 saat önbelleğe alır; hemen görmek için o ekrandaki <em>&quot;Tekrar denetle&quot;</em> bağlantısını kullanın.</li>
          <li><strong><R href="/deployments">Dağıtımlar</R>:</strong> panelin kendi sürümünü (API/Admin) canlıya alır ve dağıtım geçmişini gösterir. Sağlık kontrolü başarısız olursa dağıtım otomatik geri alınır.</li>
          <li>Her iki işlem de yalnız &quot;owner&quot; rolüne açıktır ve aynı kuyruğu kullanır: aynı anda tek iş çalışır.</li>
        </Bullets>
        <Tip>
          Yayın ya da dağıtım isteği anında çalışmaz: sunucudaki görevli en geç bir dakika içinde
          alır. Durumu ilgili sayfadaki iş tablosundan izleyin (sayfayı yenileyin).
        </Tip>
      </Section>

      <Section
        id="guvenlik"
        icon={ShieldCheck}
        title="Güvenlik ilkeleri"
        description="Panelin veriyi nasıl koruduğu."
      >
        <Bullets>
          <li>Lisans yükleri <strong>AES-256-GCM</strong> ile şifreli saklanır; bir key&apos;i her görüntüleme/kopyalama denetime düşer.</li>
          <li>Mağaza ↔ panel iletişimi <strong>HMAC-SHA256</strong> imzalıdır (zaman damgası + nonce ile tekrar saldırısına kapalı).</li>
          <li>Çifte satış yapısal olarak imkânsızdır (atomik kilit + idempotency anahtarı).</li>
          <li><strong>KVKK:</strong> bir müşterinin kişisel verisi maskeleyerek anonimleştirilebilir (kayıt silinmez, denetim korunur).</li>
        </Bullets>
      </Section>

      <Section
        id="kisayol"
        icon={Keyboard}
        title="Kısayollar ve ipuçları"
        description="Paneli daha hızlı kullanmak için."
      >
        <Bullets>
          <li><strong>Ctrl / ⌘ + K</strong> — her yerden global arama (sipariş no, e-posta, key son 5 hane). Hassas veri sonuçta gösterilmez.</li>
          <li><strong>Ctrl / ⌘ + B</strong> — sol menüyü aç/kapat (tercih hatırlanır).</li>
          <li>Liste ekranlarında filtre + kolon görünürlüğünü ayarlayıp <strong>kayıtlı görünüm</strong> olarak saklayabilirsiniz.</li>
          <li>Sağ üstten <strong>açık/koyu tema</strong> arasında geçiş yapabilirsiniz.</li>
        </Bullets>
        <Tip>
          Aynı anda birden fazla operatör aynı siparişe bakıyorsa panel sizi uyarır (çakışan işlem
          önlenir). Takıldığınız bir kavram için ilgili ekrandaki alan açıklamalarına ve bu rehbere dönebilirsiniz.
        </Tip>
      </Section>
    </div>
  );
}
