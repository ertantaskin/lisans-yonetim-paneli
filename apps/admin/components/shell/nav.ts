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
  BarChart3,
  Bell,
  Truck,
  ClipboardList,
  ClipboardCheck,
  PackageCheck,
  MailWarning,
  Settings,
  ShieldCheck,
  ShieldAlert,
  ShieldOff,
  Sparkles,
  BookOpen,
  Rocket,
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
      { label: 'Ürün Eşleştirme', href: '/mappings', icon: Link2 },
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
      { label: 'Karantina', href: '/quarantine', icon: ShieldOff },
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
