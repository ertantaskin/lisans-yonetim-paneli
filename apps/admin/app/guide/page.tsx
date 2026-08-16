import * as React from 'react';
import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  Rocket,
  Workflow,
  Plug,
  Boxes,
  BookMarked,
  FolderTree,
  LayoutDashboard,
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
  TriangleAlert,
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
  { id: 'dashboard', label: 'Genel Bakış (canlı iş istasyonu)', icon: LayoutDashboard },
  { id: 'kurulum', label: 'İlk kurulum: site bağlama', icon: Plug },
  { id: 'kategori', label: 'Kategoriler', icon: FolderTree },
  { id: 'kurulum-rehberi', label: 'Kurulum rehberleri', icon: BookMarked },
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

/**
 * Uyarı kutusu — `Tip`'in aksine "dikkat etmezsen ZARAR görürsün" içindir (yanlış güvene
 * kapılıp canlı stok yakmak gibi). Ton dili §17: warning = "insanın bilmesi gereken", yeni
 * hue eklenmez; `text-warning` + soluk tint, panelin diğer uyarı kutularıyla (ör. sipariş
 * detayı değişim uyarısı) birebir aynı yüzey.
 */
function Warn({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
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
        id="dashboard"
        icon={LayoutDashboard}
        title="Genel Bakış (canlı iş istasyonu)"
        description="Sol menünün ilk girdisi — gün boyu açık tutulmak için tasarlanmıştır."
      >
        <p>
          <R href="/dashboard">Genel Bakış</R> gelen siparişleri ve destek taleplerini{' '}
          <strong>canlı</strong> gösterir: iki liste kendi kendine tazelenir (yaklaşık{' '}
          <strong>15 saniyede bir</strong>; sekme arka plandayken <strong>dakikada bir</strong>).
          Sayfayı yenilemenize gerek yoktur; başlıktaki <strong>&quot;Yenile&quot;</strong> düğmesi
          yalnızca hemen görmek istediğinizde gerekir.
        </p>
        <p className="font-medium text-foreground">Yeni siparişi kaçırmamak için:</p>
        <Bullets>
          <li>
            Yeni gelen satır <strong>&quot;Yeni&quot;</strong> rozeti ve renkli sol şeritle
            işaretlenir. Bu işaret <strong>kendiliğinden kaybolmaz</strong>: siz satıra tıklayana
            ya da kart başlığındaki <strong>&quot;Okundu&quot;</strong> düğmesine basana kadar
            durur. Kart başlığında ayrıca <strong>&quot;N yeni&quot;</strong> yazar.
          </li>
          <li>
            Sipariş kartının altındaki <strong>&quot;Tümü&quot; / &quot;İşlem bekleyen&quot;</strong>{' '}
            düğmeleriyle listeyi daraltabilirsiniz. <em>İşlem bekleyen</em> = sizin ya da sistemin
            hâlâ bir şey yapması gereken sipariş (incelemede bekleyen, mağaza ürünü eşlenmemiş,
            teslimatı eksik). Teslim edilmiş siparişler bu görünümde yer kaplamaz.
          </li>
          <li>
            Görülmemiş kayıt varken <strong>tarayıcı sekmesinin başlığında (3) gibi bir sayaç</strong>{' '}
            belirir — başka bir sekmedeyken bile artar.
          </li>
          <li>
            Yeni kayıt düştüğü anda <strong>sağ alt köşede bildirim</strong> çıkar ve doğrudan
            siparişe götürür. Panelin hangi ekranında olursanız olun görünür.
          </li>
          <li>
            Üst bardaki <strong>zil simgesi</strong> okunmamış bildirim sayısını taşır; açınca son
            bildirimleri görür, <strong>&quot;Tümünü okundu işaretle&quot;</strong> diyebilir ve{' '}
            <strong>&quot;Bildirim sesi&quot;</strong> tercihini açabilirsiniz (varsayılan kapalı).
            Tamamı için <R href="/notifications">Bildirimler</R>.
          </li>
        </Bullets>
        <p>
          Sayfanın üstünde kırmızı bir bant görürseniz, <strong>eşleme bekleyen sipariş</strong> var
          demektir: o satırlar siz mağaza ürününü panel ürününe bağlayana kadar teslim edilemez.
          Bant, iş bitince kendiliğinden söner. Altta ince bir şeritte bugünkü sipariş sayısı,
          atanabilir stok, güvenlik olayı ve <em>panelde eşlenmemiş mağaza ürünü</em> sayısı durur —
          sonuncusu bir uyarı değil, bilgidir (mağazanızdaki her ürünün eşlenmesi gerekmez, yalnız
          lisans teslim edilenler eşlenir).
        </p>
        <Tip>
          Aynı sipariş üzerinde başka bir operatör çalışıyorsa panel sizi uyarır. Listeye tıklamak
          hem siparişi açar hem de o satırın &quot;Yeni&quot; işaretini kaldırır.
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
        </p>
        {/*
          DÜRÜSTLÜK DÜZELTMESİ (denetim bulgusu): burada "sandbox açıkken siparişler gerçek
          teslimat/mail üretmez" yazıyordu. `sandbox` alanı API'de YALNIZ mail yolunda okunur
          (mail.service.ts / mail.processor.ts); `orders.service.ts` ona HİÇ bakmaz → atama,
          stok tüketimi ve müşteriye dönen teslimat aynen çalışır. Yanlış güven = canlı envanter
          yanması. Site formundaki uyarıyla (site-config-form.tsx) birebir aynı gerçeği anlatır.
        */}
        <Warn>
          <strong>Sandbox siparişi durdurmaz — yalnız maili yönlendirir.</strong> Açıkken teslimat
          e-postası gerçek müşteriye gitmez (alıcı panelin gönderen adresine çevrilir, konuya{' '}
          <strong>[TEST MODU]</strong> öneki eklenir). Ama sipariş normal işlenir:{' '}
          <strong>gerçek stok tüketilir</strong>, <strong>gerçek lisans atanır</strong> ve müşteri
          o lisansı mağazanın &quot;Siparişlerim&quot; ekranında çözülmüş hâlde görebilir. Canlı bir
          mağazayı &quot;test moduna alıp&quot; deneme siparişi geçmeyin — bunun için ayrı bir test
          sitesi kullanın.
        </Warn>
        <Tip>
          Bir siteyi klonlar/staging&apos;e kopyalarsanız, klon ortam otomatik olarak panele{' '}
          <strong>yazma yapmaz</strong> (iade/iptal canlı lisansı geri almaz). Bu koruma yerleşiktir.
        </Tip>
      </Section>

      <Section
        id="kategori"
        icon={FolderTree}
        title="Kategoriler"
        description="Ürünleri gruplayan kovalar — Stok & Ürünler ekranı bunlara göre açılır."
      >
        <p>
          Ürün sayısı arttıkça düz bir liste okunmaz olur. <R href="/categories">Kategoriler</R>{' '}
          ekranından grup açarsınız (ör. <em>Windows lisansları</em>, <em>Office lisansları</em>,{' '}
          <em>Oyun hesapları</em>) ve <R href="/stock">Stok &amp; Ürünler</R> bu gruplarla açılır.
          Sol menüde <strong>Envanter</strong> altındadır; Stok &amp; Ürünler başlığındaki{' '}
          <strong>&quot;Kategoriler&quot;</strong> düğmesi de buraya götürür.
        </p>
        <Bullets>
          <li>
            <strong>Kategori bir kovadır, etiket değil:</strong> bir ürün <strong>en fazla bir</strong>{' '}
            kategoriye girer. Böylece &quot;kaç ürün&quot; sayaçları çakışmaz.
          </li>
          <li>
            <strong>Alanlar:</strong> <em>Kategori adı</em> (karta başlık olur),{' '}
            <em>Sabitleme sırası</em> (0 = otomatik: stoğu çok olan kategori üstte; bir grubu hep en
            üstte tutmak isterseniz 1, 2, 3… verin) ve <em>Açıklama</em> (kartın altında görünür,
            isteğe bağlı).
          </li>
          <li>
            <strong>Silmek ürünleri silmez:</strong> kategori kaldırılınca içindeki ürünler{' '}
            <strong>&quot;Kategorisiz&quot;</strong> olur; stokları ve siparişleri etkilenmez. Onay
            kutusu kaç ürünün etkileneceğini yazar.
          </li>
          <li>
            Kategori adı ürün formunda <strong>serbest yazılamaz</strong>, yalnız buradaki listeden
            seçilir — böylece ikiz kategori (&quot;Office&quot; / &quot;office&quot;) oluşmaz ve adı
            değiştirdiğinizde her yerde birden değişir.
          </li>
        </Bullets>
        <Tip>
          Kategori zorunlu değildir. Hiç kategori açmasanız da ürünleriniz{' '}
          <strong>&quot;Kategorisiz&quot;</strong> kartında toplanır — hiçbir ürün kaybolmaz.
        </Tip>
      </Section>

      <Section
        id="kurulum-rehberi"
        icon={BookMarked}
        title="Kurulum rehberleri"
        description="Lisansla birlikte müşteriye giden kurulum ve etkinleştirme talimatı."
      >
        <p>
          Anahtarı teslim etmek çoğu zaman yetmez: müşteri <em>&quot;Office 365&apos;e nasıl giriş
          yaparım&quot;</em>, <em>&quot;Windows anahtarını nereye girerim&quot;</em> diye sorar.{' '}
          <R href="/guides">Kurulum Rehberleri</R> ekranında bu talimatı bir kez yazar, ürüne
          bağlarsınız; teslimatla birlikte otomatik gider.
        </p>
        <Bullets>
          <li>
            <strong>Üç yüzeyde birden görünür:</strong> mağazadaki sipariş sayfasında (ürün kartının
            içinde, katlanır bölüm), <strong>teslimat e-postasında</strong> ve müşterinin indirdiği{' '}
            <strong>.txt</strong> dosyasında. Üçü de aynı metinden üretilir, ayrışmaz.
          </li>
          <li>
            <strong>Rehber ürüne gömülü değildir:</strong> ayrı bir kayıttır ve birden çok ürüne
            bağlanabilir. &quot;Office 2021 etkinleştirme&quot; anlatısı onlarca SKU&apos;da aynıdır;
            bir adımı düzelttiğinizde bağlı <strong>tüm</strong> ürünlerde anında geçerli olur.
          </li>
          <li>
            <strong>Hazır taslaklar:</strong> Office 365, Office 2021/2019, Windows 10/11 ve genel
            hesap teslimatı için başlangıç metinleri hazırdır — tek tıkla doldurup kendinize göre
            düzenlersiniz.
          </li>
          <li>
            <strong>Biçimleme:</strong> satır başına <code>1.</code> yazmak adım listesi,{' '}
            <code>-</code> madde listesi, <code>##</code> ara başlık,{' '}
            <code>**kalın**</code> vurgu üretir. Adresleri <code>https://</code> ile tam yazın ki
            mağaza sayfasında tıklanabilir olsun. HTML etiketleri çalışmaz (güvenlik).
          </li>
          <li>
            <strong>Uzunluk sınırı 4.000 karakterdir</strong> ve bu bir tercih değil zorunluluktur:
            uzun e-postaları Gmail gibi istemciler kırpıp &quot;tümünü göster&quot; arkasına atar —
            kırpılan yer de genelde rehberin bulunduğu sondur. Metin uzuyorsa sadeleştirin veya
            ikinci bir rehbere bölün.
          </li>
          <li>
            <strong>Hiçbir ürüne bağlı olmayan rehber müşteriye ulaşmaz.</strong> Liste bunu{' '}
            <em>&quot;Ürüne bağlı değil&quot;</em> etiketiyle işaretler — yazıp bağlamayı unutmak
            sessiz bir kayıp olurdu.
          </li>
        </Bullets>
        <Tip>
          Rehber ile <R href="/templates">şablon</R> aynı şey değildir: şablon e-postanın{' '}
          <strong>çatısıdır</strong> (konu, selamlama, imza) ve site/ürün kapsamlıdır; rehber ürüne
          bağlı <strong>talimat metnidir</strong> ve mağaza sayfasında da görünür. Şablonunuzda{' '}
          <code>{'{{guides}}'}</code> yazarsanız rehber tam oraya yerleşir; yazmazsanız e-postanın
          sonuna eklenir (sessizce kaybolmaz).
        </Tip>
      </Section>

      <Section
        id="urunler"
        icon={Boxes}
        title="Ürünler"
        description="Ürün tanımlama ve ürün detay sayfasının ne işe yaradığı."
      >
        <p>
          <R href="/stock">Stok &amp; Ürünler</R> ekranı <strong>kategori kartlarıyla</strong> açılır:
          bir karta girince o grubun ürün tablosu gelir, üstteki arama kutusu ise{' '}
          <strong>tüm kategorilerde</strong> arar (ürün adı, SKU, kategori adı). Sağ üstteki{' '}
          <strong>&quot;Yeni Ürün&quot;</strong> ile ürün oluşturursunuz. Formdaki alanlar 4 bölümde toplanır:
        </p>
        <Bullets>
          <li><strong>Temel bilgiler:</strong> SKU, ad, <strong>kategori</strong> (listeden seçilir; boş bırakılırsa ürün &quot;Kategorisiz&quot; olur), ürün tipi (lisans anahtarı / hesap / kod / özel), kullanım modu, teslimat politikası.</li>
          <li><strong>Kullanım modu:</strong> <em>Tek kullanımlık</em> (1 key = 1 müşteri) veya <em>Çok kullanımlık (MAK)</em> (1 key = N teslim, kapasite).</li>
          <li><strong>Teslimat politikası:</strong> stok siparişe yetmezse ne olacağı — kısmi otomatik, kısmi onaylı, ya da ya hep ya hiç.</li>
          <li><strong>Hesap alanları:</strong> hesap ürünlerinde müşteriye teslim edilecek alanlar (ör. kullanıcı adı, parola). &quot;Gizli&quot; işaretli alanlar panelde maskelenir; &quot;Zorunlu&quot; kaldırılırsa alan opsiyonel olur.</li>
          <li><strong>Süre &amp; garanti:</strong> süreli hesaplar için geçerlilik (gün) + süre bitince davranışı, garanti (Sorun Bildir) penceresi, düşük stok eşiği.</li>
          <li><strong>Stok &amp; gelişmiş:</strong> stoksuz/ön sipariş + yayın tarihi, key format doğrulaması (regex).</li>
        </Bullets>
        <p>
          Listedeki <strong>Detay</strong> bağlantısı o ürünün <strong>yönetim merkezini</strong> açar.
          Üstte stok kırılımı ve satış hızı/tükenme tahmini, altında dört sekme:
        </p>
        <Bullets>
          <li><strong>Envanter:</strong> o ürünün tek tek anahtar/hesap kalemleri (varsayılan sekme). Buradan arama yapabilir, duruma göre süzebilir, satırları işaretleyip <strong>topluca stoktan düşebilirsiniz</strong> (bkz. &quot;Stok düzeltmeleri&quot; bölümü).</li>
          <li><strong>Eşlemeler:</strong> o ürünün mağaza eşlemeleri (ekleme, pasifleştirme, kaldırma).</li>
          <li><strong>Tedarik:</strong> ürünün partileri ve satın alma emirleri.</li>
          <li><strong>Hareketler:</strong> defter kayıtları — geçmiş stok düzeltmeleri ve yeni kayıt formu.</li>
        </Bullets>
        {/*
          DÜZELTME (denetim bulgusu): burada koşulsuz "anahtarın tamamı / son 5 hanesi" yazıyordu.
          Ekranın kendi ipucu (components/inventory/license-items-table.tsx) doğrusunu söylüyor:
          HESAP ürünlerinde bu arama ÇALIŞMAZ — kalem düz metni kanonik bir JSON'dur ve hesap
          kaleminde `payload_suffix_hash` yazılmaz, dolayısıyla parolanın/kullanıcı adının son
          haneleri ASLA eşleşmez. Rehber panelin sahip olmadığı bir yeteneği vaat ediyordu.
        */}
        <p>
          Envanterde arama <strong>anahtarın tamamıyla</strong> ya da <strong>son 5 hanesiyle</strong>{' '}
          yapılabilir; ayrıca ürün adı/SKU, müşteri e-postası, mağaza sipariş numarası ve parti kodu
          aranır. Anahtarlar şifreli saklandığı için ortadan birkaç hane ile arama yapılamaz; büyük/küçük
          harf ve boşluk farkı sorun değildir. <strong>Hesap ürünlerinde</strong> anahtar/son-hane
          araması <strong>çalışmaz</strong> (kimlik bilgileri çok alanlı saklanır, &quot;son 5 hane&quot;
          parolanın değil kaydın kuyruğudur) — bu kalemleri ürün adı/SKU, müşteri e-postası veya
          sipariş numarasıyla arayın.
        </p>
        <p>
          Anahtar/hesap eklemek ayrı bir ekranda yapılır: <R href="/stock/import">Stok Girişi</R>. Ürün
          detayındaki <strong>&quot;Bu ürüne stok gir&quot;</strong> düğmesi de aynı ekranı, ürün
          ön-seçili olarak açar. Ayrıntı için bir sonraki bölüme bakın.
        </p>
        <Tip>
          Geçersiz kılınan (void) ve değiştirilen ölü kalemler silinmez; Kusurlu Stok ekranının{' '}
          <R href="/quarantine/records">Tüm Kayıtlar</R> bölümünde sebebi ve kaynak siparişiyle
          birlikte durur. Tedarikçiye bildirilmeyi bekleyenler ise{' '}
          <R href="/quarantine">Bildirilecekler</R> bölümündedir; oradan <strong>değişim fişi</strong>{' '}
          kesip süreci takip edebilirsiniz — bkz. aşağıdaki bölüm.
        </Tip>
        <Tip>
          <strong>Terim:</strong> panelde tek bir stok satırına <strong>kalem</strong> denir. Ürün
          tipine göre bu bir <em>lisans anahtarı</em>, bir <em>hesap</em> ya da bir{' '}
          <em>kod/hediye çeki</em> olabilir. Ekranlar tek tipten oluşan bir listede o tipin adını
          (&quot;3 hesap&quot;), karışık listede nötr adı (&quot;3 kalem&quot;) kullanır.
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
            <strong>&quot;Önizle (kuru çalıştır)&quot;</strong> ile doğrulayın: kaç kalem kabul edilecek,
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
            <strong>Hızlı giriş (Partisiz):</strong> yalnız kalemleri girersiniz. Tedarikçi ve maliyet
            izi <strong>tutulmaz</strong> → bu kalemler maliyet raporlarında{' '}
            <strong>&quot;kapsanamayan&quot;</strong> görünür ve bu sonradan düzeltilemez; geri çekme
            (recall), tedarikçi karnesi ve <strong>değişim fişi</strong> de bu girişi kapsamaz.
            Elinizde maliyet/tedarikçi bilgisi yoksa veya tekil/deneme kalemi giriyorsanız uygundur.
          </li>
          <li>
            <strong>Tedarikli giriş (Yeni parti):</strong> tedarikçi + alım tarihi + parti etiketi + birim
            maliyet girersiniz. Panel aynı adımda <strong>teslim alınmış</strong> bir{' '}
            <strong>Satın Alma Emri</strong> ve ona bağlı bir <strong>Parti</strong> açar; kalemler o
            partiye bağlanır. Maliyet raporu, tedarikçi karnesi ve geri çekme bu girişi kapsar.
          </li>
          <li>
            <strong>Mevcut parti:</strong> daha önce açılmış bir partiye ek kalem girersiniz. Yalnız o
            ürünün <em>aktif</em> partileri listelenir (geri çekilmiş/iptal partiye ekleme yapılamaz).
          </li>
        </Bullets>
        <Tip>
          Tedarikli girişte açılan emir ve parti, listelerde <strong>&quot;Otomatik&quot;</strong> rozetiyle
          işaretlenir: mal zaten girilmiştir, bu emir ikinci kez <em>&quot;Teslim Al&quot;</em> istemez.
          Tedarikçi alanına yeni bir ad yazarsanız aynı adlı kayıt varsa yeniden kullanılır, yoksa
          oluşturulur. Birim maliyeti <strong>lira</strong> olarak girin (ör. 12,50) — panel kuruşa kendisi çevirir.
          Parti etiketi alım tarihinden otomatik gelir (<code>2026-08-13-A</code>); aynı gün ikinci bir
          giriş yaparsanız harf ilerler (<code>-B</code>). Elle yazarsanız öneri donar,
          &quot;Otomatik&quot; düğmesiyle geri dönersiniz.
        </Tip>
        <p>
          <strong>Sınırlar:</strong> tek seferde en çok <strong>10.000 kayıt</strong> (~700 KB)
          girilebilir; girdi alanının altındaki sayaç kaç kayıt gideceğini, kaç boş satırın atlandığını
          ve mükerrer görüneni canlı gösterir. Çok kullanımlık (MAK) üründe sayaç ayrıca{' '}
          <strong>kullanım hakkını</strong> hesaplar: 3 anahtar × 500 kullanım = 1.500 birim.
        </p>
        <p>
          Hesap ürünlerinde girdi varsayılan olarak <strong>&quot;Tablo&quot;</strong> biçimindedir
          (Excel&apos;den doğrudan yapıştırılabilir) ve bu biçimde tek seferde en çok{' '}
          <strong>500 satır</strong> tutulur — daha fazlası ekranı yavaşlatacağı için sessizce
          kırpılmaz, uyarılırsınız. Daha büyük listeler için aynı adımdaki{' '}
          <strong>&quot;JSON (gelişmiş)&quot;</strong> biçimini kullanın: orada tek sınır 10.000
          kayıt / ~700 KB&apos;dır.
        </p>
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
            ürün kataloğunu <strong>adıyla</strong> görüp sipariş beklemeden eşlersiniz. Katalog
            mağazadan gelir: WordPress&apos;te <strong>Ayarlar &rsaquo; Teslimat Eklentisi &rsaquo;
            &quot;Ürünleri Panele Aktar&quot;</strong> düğmesiyle hemen gönderilir; ürün eklendiğinde
            veya değiştirildiğinde kendiliğinden de gider. Liste boş görünüyorsa önce bu düğmeye basın.
            Aynı ekranda
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
            {/* DÜZELTİLDİ: "her görüntüleme denetime yazılır" YANLIŞ vaatti. A1 kararı gereği
                `reveal` kaydı YALNIZ gerçekten düz metin döndüğünde (owner) yazılır; maskeli
                görüntüleme iz bırakmaz. Denetim izine güvenip "kim baktı" sorusunu yanıtlamaya
                çalışan operatör eksik veriyle karar verirdi. */}
            Sipariş detayında lisans doğrudan görünür (&quot;owner&quot; rolünde açık, diğer yöneticilerde
            maskeli). <strong>Denetim günlüğüne</strong> yalnız düz metin gösterilen görüntülemeler
            (yani owner&apos;ınkiler) yazılır — maskeli görüntüleme iz bırakmaz. Satır aksiyonları:{' '}
            <strong>Değiştir</strong>, <strong>Askıya Al</strong>, <strong>İptal</strong>; sipariş
            genelinde <strong>Maili Yeniden Gönder</strong>.
          </li>
        </Bullets>
        <Tip>
          Kısmi teslimat birinci sınıf bir akıştır: <em>kısmi otomatik</em> ürünlerde eldeki kadar teslim
          edilir, kalanı stok gelince tamamlanır. <em>Ya hep ya hiç</em> ürünlerde ya tamamı teslim edilir ya hiçbiri.
        </Tip>

        <p className="font-medium text-foreground">İade ve iptal:</p>
        <p>
          İade <strong>mağazada</strong> yapılır — panelde iade/para iadesi düğmesi yoktur. Siparişi
          mağazada iade ettiğinizde mağaza panele imzalı bir bildirim gönderir ve panel o birimlerin
          lisansını <strong>geri alır</strong>.
        </p>
        <Bullets>
          <li>
            <strong>Tam iade:</strong> siparişin tüm kalemleri kapanır ve o siparişe verilmiş bütün
            lisanslar geri alınır — <em>askıya alınmış</em> olanlar dahil (askıdaki bir lisans sonradan
            &quot;Geri aç&quot; ile canlanabilirdi).
          </li>
          <li>
            <strong>Kısmi iade:</strong> yalnız iade edilen adet kadar lisans geri alınır. Aynı kalemdeki
            diğer lisanslar <strong>müşterinin elinde geçerli kalır</strong>.
          </li>
          <li>
            <strong>İade edilen birim geri gelmez:</strong> o birim kapanmış sayılır; sonradan stok
            girseniz bile teslimat motoru oraya yeni bir lisans koymaz. Müşteri yeniden satın almalıdır.
          </li>
          <li>
            <strong>Çok kullanımlık (MAK) üründe kapasite havuza dönmez:</strong> iade edilen bir
            kullanım hakkı yeniden satılabilir stoğa eklenmez — hak bir kez harcanmıştır.
          </li>
          <li>
            <R href="/review">İnceleme Kuyruğu</R>&apos;nda bekleyen bir sipariş iade edilirse kuyruktan
            da düşer; sonradan yanlışlıkla &quot;Onayla&quot; denip lisans verilmesi mümkün değildir.
          </li>
        </Bullets>
        <Tip>
          Sipariş detayındaki <strong>&quot;İptal&quot;</strong> panel tarafında tekil bir lisansı geri
          alır; <strong>mağazada para iadesi yapmaz</strong>. Geri alınan anahtar silinmez, karantinaya
          düşer ve <R href="/quarantine/records">Kusurlu Stok &rsaquo; Tüm Kayıtlar</R> bölümünde
          sebebiyle listelenir.
        </Tip>
      </Section>

      <Section
        id="inceleme"
        icon={ClipboardCheck}
        title="İnceleme kuyruğu ve satış kotası"
        description="Anormal hacmi otomatik teslim yerine manuel onaya alma."
      >
        {/*
          DÜZELTME (denetim bulgusu, site-config-form.tsx ile aynı sınıf): bu paragraf yalnız
          DİNAMİK kotayı anlatıp "reddedilmez" diyordu; SERT tavanın (salesDailyQuota) zıt
          davranışı hiçbir kullanıcı metninde yazmıyordu. orders.service.ts:375 aşımda
          `SalesQuotaExceededException` fırlatır → 429 + tx rollback: ÖDENMİŞ sipariş panele
          hiç kaydedilmez. İki mekanizma artık yan yana ve ayrımı açık.
        */}
        <p>
          Site ayarlarında <strong>iki ayrı</strong> mekanizma vardır ve davranışları{' '}
          <strong>zıttır</strong>:
        </p>
        <Bullets>
          <li>
            <strong>Günlük satış kotası (sert tavan):</strong> o gün oluşturulan sipariş sayısı bu
            değere ulaştığında sonraki sipariş <strong>REDDEDİLİR</strong> — incelemeye alınmaz,
            mağaza 429 yanıtı alır ve sipariş panele <strong>hiç kaydedilmez</strong> (müşteri
            ödemiş olsa bile). Gün sonunda (yerel gece yarısı) sayaç sıfırlanır. Sayaç o gün
            oluşturulan <em>tüm</em> siparişleri sayar — eşlenmemiş, incelemedeki ve iade
            edilenler dahil, yalnız teslim edilenler değil. Boş bırakmak = limitsiz (önerilen).
          </li>
          <li>
            <strong>Dinamik kota (isteğe bağlı):</strong> son 30 günün ortalamasına göre hesaplanan
            eşik aşılırsa sipariş <strong>reddedilmez</strong>;{' '}
            <R href="/review">İnceleme Kuyruğu</R>&apos;na alınır (atama yapılmaz, siz karar
            verirsiniz). Eşik = ortalama günlük satış × çarpan; <strong>20&apos;lik taban yalnız
            yeni/az geçmişli sitelerde</strong> geçerlidir, geçmiş biriktikçe eşik tamamen
            ortalamaya göre hesaplanır.
          </li>
        </Bullets>
        <Steps>
          <li>Kuyruktaki siparişi inceleyin.</li>
          <li><strong>Onayla</strong> → sipariş normal teslimat akışına girer (stok varsa hemen atanır).</li>
          <li><strong>Reddet</strong> → sipariş iptal edilir, lisans verilmez.</li>
        </Steps>
        {/* DÜZELTME: "Otomatik reddetme yoktur" cümlesi, yukarıda belgelenen SERT tavanla
            doğrudan çelişiyordu (salesDailyQuota aşımı 429 ile otomatik REDDEDER). İlke
            anomali/risk tespiti ve dinamik kota için geçerlidir; operatörün kendi elleriyle
            koyduğu sayısal tavan bilinçli bir istisnadır. Cümle kapsamlandı. */}
        <Tip>
          İlke: <strong>&quot;AI/sistem önerir, insan onaylar.&quot;</strong> Panel{' '}
          <em>kendi kararıyla</em> sipariş reddetmez, müşteri askıya almaz; risk/anomali tespiti
          yalnızca işaretler, şüpheli hacim yalnızca incelemeye alınır. <strong>Tek istisna sizin
          elle koyduğunuz sert tavandır</strong> — o sayı aşıldığında sipariş otomatik reddedilir.
          Dinamik kota varsayılan olarak kapalıdır; sert tavan da boş (limitsiz) gelir.
        </Tip>
      </Section>

      <Section
        id="degisim"
        icon={RefreshCw}
        title="Değişim ve garanti"
        description="Kusurlu lisansı taze biriyle değiştirme."
      >
        <Bullets>
          <li><strong>Müşteri talebi:</strong> müşteri My Account&apos;ta &quot;Sorun Bildir&quot; ile talep açar → <R href="/support">Destek</R> kuyruğunda görünür. Onayla / Reddet / Bilgi İste yapabilirsiniz. {/* DÜZELTME (denetim bulgusu): "onay için TEK
          teknik şart stoktur" cümlesi yanlıştı — replacements.service.ts:535 çok-kullanımlı (MAK)
          üründe talebi stoktan BAĞIMSIZ olarak 400 ile reddeder. Aynı bölümün 4 madde altındaki
          MAK istisnası zaten doğruydu; cümle ona hizalandı. */}
          Onay için stok gerekir — <strong>tek şart bu değildir</strong>: çok kullanımlı (MAK)
          ürünlerde stok olsa bile otomatik değişim yapılamaz (aşağıdaki maddeye bakın).</li>
          <li><strong>Garanti penceresi kararı size aittir:</strong> panel her talebe &quot;Garanti içi / Garanti dışı&quot; rozetini bilgi olarak basar (teslim tarihi + ürünün garanti gün sayısı; lisansın geçerlilik süresi dolmuşsa garanti içi sayılmaz). Bu rozet onayı <em>engellemez</em> — garanti dışı bir talebi de onaylayabilirsiniz. İlke aynı: <strong>&quot;sistem önerir, insan onaylar.&quot;</strong></li>
          <li><strong>Proaktif değişim:</strong> müşteri beklemeden, sipariş detayında bir atamayı <strong>&quot;Değiştir&quot;</strong> ile aynı üründen taze bir key ile değiştirebilirsiniz. Eski key karantinaya alınır, değişim geçmişi tutulur. <strong>Değişim YALNIZ sipariş detayından yapılır</strong> — lisans envanteri (ürün detayı → Envanter, <R href="/stock">Stok</R> → &quot;Son Eklenen Lisanslar&quot;, parti detayı) bir <em>stok</em> ekranıdır ve müşteriye dokunan işlem sunmaz; teslim edilmiş satır orada &quot;Siparişe git&quot; kısayolu gösterir.</li>
          <li><strong>Hesap ürününde parola değiştiyse &quot;Değiştir&quot; kullanmayın.</strong> Değişim müşteriye <em>başka bir hesap</em> verir; eski hesap müşterinin elinde çalışmaya devam eder (bilgileri zaten kopyalamıştır) ve müşterinin o hesapta biriktirdiği veri kaybolur. Doğru araç: <strong>sipariş detayında</strong> o lisansın satırındaki <strong>&quot;Kimlik bilgilerini güncelle&quot;</strong> (envanterden buraya taşındı — müşteriye dokunan her işlem sipariş bağlamındadır). Aynı hesap, aynı atama, yeni bilgiler — sebep denetim kaydına ve siparişin zaman çizelgesine yazılır. <strong>Owner yetkisi gerekir</strong> ve müşteri yeni bilgileri otomatik görmez: güncelleme sonrası siparişten <R href="/orders">teslimat mailini yeniden gönderin</R>.</li>
          <li>
            <strong>Çok kullanımlı (MAK) lisansta otomatik değişim YOKTUR.</strong> Panel bunu
            bilerek reddeder: MAK&apos;ta bir anahtar birden çok aktivasyon taşır, geri alınan
            kapasite <em>aynı</em> paylaşımlı anahtara döner — yeni atama yine o kusurlu anahtarı
            seçerdi. Bu yüzden &quot;Değiştir&quot; düğmesi MAK atamalarında kapalı gelir ve destek
            talebi &quot;Onayla&quot; ile çözülemez.
          </li>
        </Bullets>
        <p className="font-medium text-foreground">MAK lisansta kusurlu anahtar: ne yapmalı?</p>
        <Steps>
          <li>
            <strong>Müşteriyi çalışır hâle getirin:</strong> mağazanın sipariş ekranındaki ürün
            kaleminin altında <strong>&quot;+1 Bonus&quot;</strong> ile ek aktivasyon verin. Bonus
            ayrı (sentetik) bir satıra yazılır — mağaza adedi şişmez, iade uzlaştırması etkilenmez.
          </li>
          <li>
            <strong>Kusurlu anahtarı kapatın:</strong> anahtar hâlâ stoktaysa lisans envanterinden{' '}
            <strong>geçersiz kılın</strong> (sebep zorunlu) — böylece bir daha satılmaz ve{' '}
            <R href="/quarantine">Kusurlu Stok</R> havuzuna düşer.
          </li>
          <li>
            <strong>Tedarikçiye bildirin:</strong> <R href="/quarantine">Kusurlu Stok</R> →
            &quot;Bildirilecekler&quot; sekmesinden değişim fişi kesin, tedarikçi yanıtını fişe
            işleyin.
          </li>
          <li>
            <strong>Destek talebini kapatın:</strong> talebi &quot;Reddet&quot; ile <em>ne yaptığınızı
            yazarak</em> kapatın (gerekçe müşteriye görünür; ör. &quot;ek aktivasyon tanımlandı&quot;).
          </li>
        </Steps>
        <Tip>
          Değişimde eski key iptal edilir ama satır &quot;iade&quot; sayılmaz; taze key aynı siparişe atanır.
          Stok yoksa işlem güvenle durur (eski key korunur) ve size bildirilir.{' '}
          <strong>&quot;İptal&quot; değişim aracı DEĞİLDİR:</strong> iade semantiğinde koşar — müşterinin
          hakkı yanar ve MAK&apos;ta o birim kapasite kalıcı kaybolur. Kusurlu lisans için
          &quot;Değiştir&quot; (tek kullanımlık) ya da yukarıdaki MAK akışını kullanın.
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
          <li>
            <strong><R href="/purchase-orders">Satın Alma</R>:</strong> açık/kapalı emirler ve teslim
            alma. &quot;Otomatik&quot; rozetli emirlerde teslim alma adımı yoktur (mal zaten
            girilmiştir). Emir detayındaki <strong>&quot;Tamamlanma&quot;</strong> tarihi, emrin{' '}
            <em>tamamı</em> teslim alındığında dolar — kısmi teslim almalarda boş kalır; her
            sevkiyatın kendi tarihi aynı sayfadaki parti listesinde durur.
          </li>
          <li><strong><R href="/batches">Partiler</R>:</strong> stok partileri — hangi kalem hangi tedarikçiden, ne zaman geldi. Bir parti sorunluysa <strong>geri çekin</strong> (recall): yalnız <em>stoktaki</em> kalemler geçersiz kılınır. <strong>Müşterilerdekiler KORUNUR</strong> — bir kısmı çalışıyor olabilir, otomatik iptal etmek müşteriyi lisanssız bırakırdı. Onları parti detayındaki <strong>“Müşterilerdeki lisanslar”</strong> listesinden tek tek inceleyip gerekeni satırdaki <strong>“Siparişe git”</strong> ile açar ve sipariş detayındaki <strong>“Değiştir”</strong> ile yenilersiniz (değişim kararı sipariş bağlamı ister: hangi müşteri, hangi satır, garanti penceresi — bu yüzden envanter listesinden yapılmaz); hepsini birden yenilemek isterseniz Partiler listesindeki satır menüsünde <strong>Toplu Değiştir</strong> vardır. Aday kümesi iki durumu <em>dışlar</em>: <strong>askıya alınmış atamalar</strong> (askıyı bilerek koydunuz, değişim onu sessizce geri açardı) ve <strong>çok kullanımlı (MAK) ürünler</strong> (geri alınan kapasite aynı paylaşımlı anahtara döneceği için yeni atama yine kusurlu anahtarı seçerdi). İkisi de elle işlenir — bu yüzden &quot;Toplu Değiştir&quot; sayacı, partideki müşteri sayısından küçük olabilir.</li>
        </Bullets>

        <p className="font-medium text-foreground">Kusurlu stok → tedarikçiye değişim fişi:</p>
        <p>
          <R href="/quarantine">Kusurlu Stok</R> ekranı bozuk çıkan kalemleri tedarikçiye{' '}
          <strong>toplu bildirmenin</strong> yoludur ve <strong>üç bölümden</strong> oluşur (her
          biri ayrı bir sayfa; ekranın üstündeki bölüm çubuğundan geçilir, yer imlenebilir):
        </p>
        <Bullets>
          <li>
            <strong><R href="/quarantine">Bildirilecekler</R></strong> — henüz hiçbir fişe girmemiş
            kusur havuzu, tedarikçi ve parti kırılımıyla (parti satırını açarsanız içindeki
            kalemleri görürsünüz). Bu bölüm <em>iş listesidir</em> ve sol menüdeki “Kusurlu Stok”
            doğrudan buraya gelir.
          </li>
          <li>
            <strong><R href="/quarantine/claims">Değişim Fişleri</R></strong> — kesilmiş fişler,
            durumları ve tedarikçi yanıtları.
          </li>
          <li>
            <strong><R href="/quarantine/records">Tüm Kayıtlar</R></strong> — bildirilmiş olsun
            olmasın TÜM ölü kalemlerin değişmez defteri; süzgeç ve dışa aktarma buradadır. Her
            satır kendi <strong>bildirim durumunu</strong> gösterir (Bildirilmedi / Fişte /
            Yanıtlandı).
          </li>
        </Bullets>
        <p>
          Akış: <strong>“Fiş oluştur”</strong> deyip tedarikçi ve tarih aralığı seçtiğinizde o
          pencerede biriken tüm kusurlular otomatik gelir (istemediğinizi çıkarırsınız) ve{' '}
          <code>DEG-YYYYAAGG-NN</code> numaralı bir fiş kesilir. Fişi <strong>.txt veya .csv</strong>{' '}
          olarak indirip tedarikçiye gönderin (panel göndermez), sonra “Tedarikçiye gönderdim” deyin — yanıt ancak bundan
          sonra girilebilir. Tedarikçi cevap verdikçe kalemleri <em>Yenisi geldi / Bedeli iade
          edildi / Tedarikçi kabul etmedi</em> olarak işaretlersiniz.{' '}
          <strong>Kabul edilmeyen kalem bildirilecekler havuzuna GERİ DÖNER</strong> ve yeniden
          bildirilebilir; yenilenen kapanır. Fişe giren kalem bir daha aynı listeye düşmez — aynı
          kusuru iki kez bildirmezsiniz.
        </p>
        <Tip>
          Tedarikçiye giden dosyada <strong>müşteri e-postası ve sipariş numarası BULUNMAZ</strong> (KVKK):
          yalnız ürün, tür (anahtar/hesap/kod), kalem değeri, parti, kusur gerekçesi ve tarih. Fiş
          içeriği kesildiği andaki <strong>anlık görüntüdür</strong> — ürün adı değişse ya da parti
          silinse bile gönderdiğiniz dosyayla panelde gördüğünüz liste birebir aynı kalır.
          Tedarikçinin kusur oranını ve ortalama çözülme süresini{' '}
          <R href="/suppliers">tedarikçi karnesinde</R> görürsünüz.
        </Tip>
        <Tip>
          Partisiz (hızlı) giriş yaparsanız o kalemler hiçbir partiye bağlanmaz: maliyet raporunda
          &quot;kapsanamayan&quot; sayılır, geri çekme ve tedarikçi karnesi de onları kapsamaz —
          <strong> tedarikçisi bilinmediği için fiş de kesilemez</strong>. İzlenebilirlik
          istiyorsanız girişte tedarikçi ve maliyeti doldurun.
        </Tip>
      </Section>

      <Section
        id="duzeltme"
        icon={Wrench}
        title="Stok düzeltmeleri"
        description="Bozuk kalemleri stoktan düşmek ile deftere not yazmak iki AYRI işlemdir."
      >
        <p>
          Elle stok müdahalesinin <strong>iki ayrı yolu</strong> vardır ve ikisi aynı şey değildir.
          Birini seçmeden önce sorun şu: <em>gerçekten satılabilir stoğu mu düşürüyorum, yoksa
          sadece kayıt mı bırakıyorum?</em>
        </p>

        <p className="font-medium text-foreground">1) Gerçekten stoktan düşmek (bozuk kalemler):</p>
        <Steps>
          <li>
            Ürün detayına girin (<R href="/stock">Stok &amp; Ürünler</R> &rsaquo; ürün &rsaquo;{' '}
            <strong>Detay</strong>) ve <strong>Envanter</strong> sekmesinde kalın.
          </li>
          <li>
            Düşeceğiniz kalemleri bulun — arama, <strong>Durum</strong> ve sıralama süzgeçleri
            (ör. parti kodu ya da tedarikçi adıyla arayarak) bu iş için vardır.
          </li>
          <li>
            Satır başındaki kutucukları işaretleyin. Yalnız <strong>&quot;Stokta&quot;</strong> olan
            kalemler seçilebilir; teslim edilmiş bir lisans buradan düşülemez (o akış sipariş
            detayındaki <strong>&quot;Değiştir&quot;</strong>dir).
          </li>
          <li>
            Üstte beliren çubuktan <strong>&quot;Geçersiz kıl&quot;</strong> ya da{' '}
            <strong>&quot;Hasarlı işaretle&quot;</strong> deyin. Açılan onay kutusu ne düşüleceğini
            listeler ve <strong>sebep ister (zorunlu)</strong>.
          </li>
        </Steps>
        <p>
          Onaylanan kalemler artık teslim edilmez ve <R href="/quarantine">Kusurlu Stok</R> ekranına
          sebebiyle düşer: tedarikçiye henüz bildirilmemişse{' '}
          <R href="/quarantine">Bildirilecekler</R> havuzunda, her hâlükârda{' '}
          <R href="/quarantine/records">Tüm Kayıtlar</R> defterinde. İşlem <strong>geri alınamaz</strong>.
        </p>
        <Tip>
          Seçim <strong>yalnız o an görünen sayfaya</strong> aittir: sayfa değiştirir ya da süzgeci
          değiştirirseniz seçim sıfırlanır (bu, farklı sayfalardaki seçimlerin sessizce kaybolmasını
          önler). Sonuç kutusu kaç kalemin düşüldüğünü, kaçının atlandığını dürüstçe yazar — yeşil
          onay yalnız istediğiniz her kalem işlendiyse çıkar.
        </Tip>

        <p className="font-medium text-foreground">
          1b) Çok kullanımlı (MAK) bir anahtarın kapasitesini düzeltmek:
        </p>
        <p>
          Tedarikçi bir MAK anahtarına sonradan aktivasyon tanımlayabilir (&quot;1000 haklıydı,
          900 kalmıştı, tekrar 1000 yaptılar&quot;). Envanterde o satırdaki{' '}
          <strong>&quot;Kapasite&quot;</strong> düğmesiyle <strong>kalan kullanım hakkını</strong>{' '}
          yazarsınız; panel toplam kapasiteyi <em>kullanılan + kalan</em> diye hesaplar ve kaydetmeden
          önce yeni toplamı gösterir. <strong>Kullanılan hak asla sıfırlanmaz</strong> — o sayı
          müşterilerin elindeki gerçek aktivasyonları temsil eder; düşürmek aynı aktivasyonları
          ikinci kez satılabilir gösterir ve mutabakatta kalıcı alarm üretirdi. Kapasitesi tükenmiş
          (<strong>&quot;Tükendi&quot;</strong>) bir anahtar kapasite verildiğinde otomatik olarak
          yeniden <strong>&quot;Stokta&quot;</strong> olur. Kapasiteyi <em>düşürmek</em> de
          mümkündür (tedarikçi hakkı geri aldıysa) ama tabanı kullanılan haktır ve ekran görünür
          uyarı basar. <strong>Owner yetkisi gerekir</strong>; sebep zorunludur ve eski/yeni
          kapasiteyle birlikte <R href="/audit">Denetim İzi</R>ne yazılır.
        </p>

        <p className="font-medium text-foreground">2) Yalnız deftere not yazmak:</p>
        <p>
          Ürün detayının <strong>Hareketler</strong> sekmesindeki <strong>Stok Düzeltme Ekle</strong>{' '}
          formu <strong>satılabilir stoğu değiştirmez</strong>. Yalnızca kayıt bırakır: <em>Kayıt türü</em>{' '}
          (<strong>Düzeltme</strong> veya <strong>Geri çekme</strong>), <em>Adet</em> ve zorunlu{' '}
          <em>Sebep</em> girip <strong>&quot;Deftere Yaz&quot;</strong> dersiniz. Sayım farkı, tedarikçiyle
          yapılan yazışma gibi izini bırakmak istediğiniz olaylar içindir; kaydedince ekran da
          &quot;satılabilir stok DEĞİŞMEDİ&quot; diye uyarır. Geçmiş kayıtlar aynı sekmedeki{' '}
          <strong>Stok Düzeltmeleri</strong> kartında listelenir.
        </p>
        <Tip>
          Bir tedarikçi partisinin tamamı bozuksa tek tek işaretlemek yerine{' '}
          <R href="/batches">Partiler</R> ekranından o partiyi <strong>geri çekin</strong>: stoktaki
          kalemler topluca geçersiz kılınır (müşterilerdekiler korunur — bkz. &quot;Tedarik zinciri&quot;).
          Her düzeltme, kim yaptıysa onun adıyla denetim kaydına yazılır.
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
          <li><strong><R href="/reports/sla">Teslimat Süresi</R>:</strong> siparişin düşmesiyle son anahtarın teslim edilmesi arasında geçen süre. Stoktan anında karşılananlar ile <strong>beklemek zorunda kalanlar ayrı</strong> gösterilir; ortalamanın yanında <strong>ortanca ve p95</strong> vardır (birkaç uzun bekleme ortalamayı gizler). Hâlâ tamamlanmamış siparişler henüz süreye giremez — ekran bunu ayrıca uyarır. İncelemedeki siparişler, iptal satırlar, bonus kalemler ve değişimle verilen taze anahtarlar hesaba katılmaz (kaç tanesinin elendiği yazılır).</li>
          <li><strong><R href="/reports/reorder">Yeniden Sipariş</R>:</strong> &quot;neyi, ne zaman, ne kadar sipariş etmeliyim&quot;. Son 30 günün hızı + o ürünün tedarikçisinin <strong>gerçekleşen tedarik süresi</strong> ile hesaplanır; formül ekranda açıkça yazılıdır. Tedarik süresi henüz bilinmiyorsa (kapanmış satın alma emri yoksa) <strong>miktar önerilmez</strong> — yalnız tükenme tahmini gösterilir.</li>
          <li><strong><R href="/reports/costs">Maliyet Raporu</R>:</strong> tedarik harcaması + stok değerleme + teslim edilen mal maliyeti. Satış fiyatı panelde yoktur (ödeme mağaza tarafında) → kâr değil <strong>maliyet</strong> gösterilir. Tedarikçi/maliyet bilgisi olmadan (partisiz) girilen stok burada <strong>&quot;kapsanamayan&quot;</strong> olarak dürüstçe ayrı gösterilir.</li>
          <li><strong><R href="/notifications">Bildirimler</R>:</strong> düşük stok ve kritik olaylar (Telegram tanımlıysa oraya da düşer).</li>
          <li><strong><R href="/security">Güvenlik</R>:</strong> anomali/velocity tespiti, başarısız giriş denemeleri ve güvenlik olayları (otomatik askıya alma yok).</li>
          <li><strong><R href="/audit">Denetim İzi</R>:</strong> &quot;kim, neyi, ne zaman yaptı&quot;. Güvenlik ekranından farkı: orası <em>tespit edilen riski</em>, burası <em>gerçekleşmiş insan eylemini</em> gösterir (iade, iptal, değişim, stok girişi, anonimleştirme, giriş…). Kayıtlar <strong>değiştirilemez</strong> ve panelde silme yolu yoktur; aktör, hedef, tarih ve iz kimliğine göre süzebilirsiniz. {/* DÜZELTME (denetim bulgusu): burada "kayıt silinmez" deniyor ve örnek olarak "anahtar görüntüleme" veriliyordu — ikisi bir arada YANLIŞTI. maintenance/retention.service.ts:272-285 günlük olarak `action='reveal' AND meta->>'auto'='true'` satırlarını RETENTION_AUDIT_REVEAL_DAYS (varsayılan 90) sonrasında siler; silinenler tam da sipariş detayı açılışında yazılan otomatik görüntüleme izleridir. Gerçek denetim aksiyonları korunur. */}
            <strong>Saklama istisnası:</strong> sipariş/envanter ekranı açıldığında kendiliğinden
            yazılan <em>otomatik görüntüleme</em> izleri gürültü sayılır ve{' '}
            <strong>90 gün</strong> sonra budanır (süre <code>RETENTION_AUDIT_REVEAL_DAYS</code> ile
            değiştirilebilir). Operatörün yaptığı gerçek eylemler (iade, iptal, değişim, stok
            girişi, giriş…) bu budamaya <strong>girmez</strong> — onlar korunur.</li>
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
          <li><strong><R href="/admins/security">Hesap Güvenliğim</R>:</strong> kendi hesabınıza <strong>iki faktörlü giriş</strong> (doğrulama uygulaması) ekleyin. Açtıktan sonra girişte parolanın ardından 6 haneli kod sorulur. Telefonunuzu kaybederseniz &quot;owner&quot; rolündeki bir yönetici sıfırlayabilir; sıfırlama o hesabın açık oturumlarını da kapatır.</li>
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
          {/* DÜZELTME (denetim bulgusu U2): burada "Gecelik yedek otomatiktir" yazıyordu.
              GERÇEK: gecelik iş SUNUCUDA ELLE kurulan bir crontab satırıdır
              (`scripts/backup-runner.sh`, docs/RUNBOOK-DR.md §4.3); depoda onu kendiliğinden
              kuran hiçbir şey yok ve panelin kendi metni (/deployments) "gecelik otomatik
              yedeği KURUN" diyor. Rehbere güvenen operatör cron'u hiç kurmuyor → yedeksizlik,
              bu panelde geri alınamaz TEK kayıp sınıfı. Metin gerçeğe çevrildi. */}
          <li><strong><R href="/deployments">Yedekleme</R>:</strong> aynı sayfadaki &quot;Son yedek&quot; ve &quot;Son tatbikat&quot; kartları veritabanı yedeğinin ne zaman alındığını, boyutunu ve <strong>dışarı kopyalanıp kopyalanmadığını</strong> gösterir. &quot;Şimdi yedek al&quot; ile istediğiniz an elle tetikleyebilirsiniz. <strong>Gecelik yedek KENDİLİĞİNDEN çalışmaz</strong> — sunucuda bir kez kurulması gerekir (<code>scripts/backup-runner.sh</code> için zamanlanmış görev; adımlar <code>docs/RUNBOOK-DR.md §4.3</code>). Kurulmadığı sürece yalnız elle aldığınız yedekler vardır. Yedek eskiyse ya da hiç yoksa <R href="/deployments">Dağıtımlar</R> ekranında kırmızı bant çıkar. <strong>Tatbikat</strong>, yedeği ayrı bir veritabanına geri yükleyip gerçekten açılabildiğini kanıtlar — hiç denenmemiş bir yedek, yedek sayılmaz.</li>
          <li>Bu işlemlerin hepsi yalnız &quot;owner&quot; rolüne açıktır ve aynı kuyruğu kullanır: aynı anda tek iş çalışır (yedek sürerken dağıtım isteği reddedilir).</li>
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
          {/* DÜZELTME (denetim bulgusu): "her görüntüleme denetime düşer" §Siparişler bölümündeki
              (zaten düzeltilmiş) anlatımla ÇELİŞİYORDU. A1 kararı gereği `reveal` kaydı YALNIZ
              gerçekten düz metin döndüğünde (owner rolü) yazılır; owner-olmayan yönetici maskeli
              görür ve iz bırakmaz. İki bölüm artık aynı gerçeği söylüyor. */}
          <li>Lisans yükleri <strong>AES-256-GCM</strong> ile şifreli saklanır. Düz metin lisans yalnız <strong>owner</strong> rolüne gösterilir ve <strong>her düz metin görüntüleme denetim izine yazılır</strong>; diğer yöneticiler maskeli görür (maskeli görüntüleme iz bırakmaz).</li>
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
          {/* DÜZELTME (denetim bulgusu): "key son 5 hane" koşulsuz vaat ediliyordu, ama
              search/search.service.ts:96-98 aranan metin EN AZ 3 RAKAM içermiyorsa anahtar
              aramasını hiç çalıştırmaz (yanlış eşleşme gürültüsü filtresi — bilinçli). Harf
              ağırlıklı bir son-5'te sonuç sessizce boş gelir, hata çıkmaz; operatör "anahtar
              panelde yok" sanırdı. Kısıt artık yazılı. */}
          <li><strong>Ctrl / ⌘ + K</strong> — her yerden global arama (sipariş no, e-posta, anahtarın son 5 hanesi). Hassas veri sonuçta gösterilmez. <strong>Anahtar araması için aradığınız metinde en az 3 rakam olmalıdır</strong> (harf ağırlıklı son-5 sonuç döndürmez — hata da vermez, liste boş kalır); böyle anahtarları <R href="/stock">Envanter</R> ekranından tam değerle arayın.</li>
          <li><strong>Ctrl / ⌘ + B</strong> — sol menüyü aç/kapat (tercih hatırlanır).</li>
          <li>
            <strong>Kayıtlı görünüm</strong> — <R href="/orders">Siparişler</R>,{' '}
            <R href="/stock">Stok</R>, <R href="/customers">Müşteriler</R>,{' '}
            <R href="/mappings">Eşleştirme</R> ve <R href="/quarantine/records">Kusurlu stok kayıtları</R>{' '}
            ekranlarında: filtre/aramayı ayarlayıp başlıktaki <strong>Görünümler</strong> menüsünden
            adlandırarak saklarsınız, sonra tek tıkla geri yüklersiniz. Görünümler kişiseldir —
            yalnız siz görürsünüz.
          </li>
          {/* DÜZELTME (denetim bulgusu U3): bu madde "bu ekranlarda filtreler adrese yansır"
              diyordu ama 5 ekranın 4'ünde tablo içi arama/facet adrese yazılmıyordu. Artık
              /orders, /stock ve /customers gerçekten yazıyor (DataTable `syncUrl`); kalan iki
              ekranda hangi süzgecin kapsam DIŞI kaldığı burada da, menüde de açıkça yazılır. */}
          <li>
            <R href="/orders">Siparişler</R>, <R href="/stock">Stok</R> ve{' '}
            <R href="/customers">Müşteriler</R> ekranlarında filtreler{' '}
            <strong>adres çubuğuna yansır</strong>: süzgeçli adresi yer imlerine ekleyebilir ya da
            bir iş arkadaşınıza gönderebilirsiniz — aynı listeyi görür.{' '}
            <R href="/mappings">Eşleştirme</R> ve{' '}
            <R href="/quarantine/records">Kusurlu stok kayıtları</R> ekranlarında ise yalnız üstteki
            (sunucu) süzgeçler adrese yazılır; liste üzerindeki <em>hızlı süzgeçler</em> yazılmaz ve
            görünüme girmez — menü bunu kaydederken de söyler.
          </li>
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
