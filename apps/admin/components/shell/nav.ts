import {
  LayoutDashboard,
  Inbox,
  ShoppingCart,
  Boxes,
  Link2,
  Globe,
  Users,
  LifeBuoy,
  FileText,
  FolderTree,
  BarChart3,
  Bell,
  Truck,
  ClipboardList,
  ClipboardCheck,
  PackageCheck,
  PackagePlus,
  MailWarning,
  Settings,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Sparkles,
  BookOpen,
  Rocket,
  ScrollText,
  KeyRound,
  Ship,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  soon?: boolean;
  /** Yalnız owner rolüne görünür (auth açıkken). */
  ownerOnly?: boolean;
}
export interface NavSection {
  title: string;
  items: NavItem[];
}

/** Sol menü bilgi mimarisi (§17). "soon" = yol haritasında, henüz yok. */
export const NAV: NavSection[] = [
  {
    title: 'Operasyon',
    items: [
      { label: 'Genel Bakış', href: '/dashboard', icon: LayoutDashboard },
      { label: 'Bekleyen Teslimatlar', href: '/pending', icon: Inbox },
      { label: 'İnceleme Kuyruğu', href: '/review', icon: ClipboardCheck },
      { label: 'Siparişler', href: '/orders', icon: ShoppingCart },
    ],
  },
  {
    title: 'Envanter',
    items: [
      { label: 'Stok & Ürünler', href: '/stock', icon: Boxes },
      // Kategoriler ürün listesinin GİRİŞ seviyesini belirler (kullanıcı kararı: ad tek
      // yerden yönetilsin) → Stok & Ürünler'in hemen altında, aynı grupta.
      { label: 'Kategoriler', href: '/categories', icon: FolderTree },
      // Stok girişi operasyonun EN SIK yapılan işi ama menüde hiç yoktu → operatör önce
      // ürünü bulup detayına inmek zorundaydı (keşfedilebilirlik sorunu). Artık kendi
      // ekranı var; ürün/parti seçimi ekranın içinde yapılır (?product= / ?batch= ile de gelir).
      { label: 'Stok Girişi', href: '/stock/import', icon: PackagePlus },
      { label: 'Ürün Eşleştirme', href: '/mappings', icon: Link2 },
      // Karantina lisans/hesap kalemleriyle ilgilidir (arızalı → tedarikçiye iade/değişim akışı),
      // güvenlik olaylarıyla değil → "Sistem" yerine Envanter altında (kullanıcı geri bildirimi).
      // AD: "Kusurlu Anahtarlar" DEĞİL — ekran hesap/kod kalemlerini de taşır (kullanıcı
      // geri bildirimi: "sadece anahtar değil, hesap/varyasyon da olabilir").
      // MENÜ HEDEFİ = İŞ LİSTESİ: '/quarantine' artık yalnız "Bildirilecekler" havuzudur;
      // fiş takibi '/quarantine/claims', değişmez defter '/quarantine/records' (üç ayrı rota,
      // sayfa içi alt navigasyonla gezilir). Menüden gelen operatör doğrudan yapılacak işi görür.
      { label: 'Kusurlu Stok', href: '/quarantine', icon: ShieldOff },
      { label: 'Kanallar / Siteler', href: '/sites', icon: Globe },
    ],
  },
  {
    title: 'Tedarik Zinciri',
    items: [
      { label: 'Tedarikçiler', href: '/suppliers', icon: Truck },
      { label: 'Satın Alma', href: '/purchase-orders', icon: ClipboardList },
      { label: 'Partiler', href: '/batches', icon: PackageCheck },
    ],
  },
  {
    title: 'Müşteri İlişkileri',
    items: [
      { label: 'Destek', href: '/support', icon: LifeBuoy },
      { label: 'Müşteriler', href: '/customers', icon: Users },
    ],
  },
  {
    title: 'Raporlar & İzleme',
    items: [
      { label: 'Raporlar', href: '/reports', icon: BarChart3 },
      { label: 'AI Operasyon', href: '/ai', icon: Sparkles },
      { label: 'Bildirimler', href: '/notifications', icon: Bell },
      { label: 'Başarısız İşler', href: '/ops', icon: MailWarning },
    ],
  },
  {
    title: 'Sistem',
    items: [
      { label: 'Güvenlik', href: '/security', icon: ShieldAlert },
      // Denetim izi (§8): "kim, neyi, ne zaman yaptı" — güvenlik OLAYLARININ (anomali/kota)
      // yanına konur ama onunla aynı şey DEĞİLDİR: /security tespit edilen riski, /audit
      // gerçekleşmiş İNSAN eylemini gösterir. Salt-okunur (append-only tablo).
      { label: 'Denetim İzi', href: '/audit', icon: ScrollText },
      // HERKESE açık (ownerOnly DEĞİL): kendi ikinci faktörünü kurma ekranı. `/admins`
      // owner-only olduğu için buraya yalnız oradan link verilseydi owner-olmayan yöneticiler
      // 2FA'yı hiç açamazdı — özellik fiilen tek kişilik kalırdı.
      { label: 'Hesap Güvenliğim', href: '/admins/security', icon: KeyRound },
      { label: 'Yöneticiler', href: '/admins', icon: ShieldCheck, ownerOnly: true },
    ],
  },
  {
    title: 'Yapılandırma',
    items: [
      { label: 'Şablonlar', href: '/templates', icon: FileText },
      { label: 'Sürümler', href: '/releases', icon: Rocket },
      { label: 'Dağıtımlar', href: '/deployments', icon: Ship },
      { label: 'Ayarlar', href: '/settings', icon: Settings },
      { label: 'Kullanım Rehberi', href: '/guide', icon: BookOpen },
    ],
  },
];

export const DASHBOARD_ICON = LayoutDashboard;
