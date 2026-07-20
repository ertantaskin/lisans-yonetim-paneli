import {
  LayoutDashboard,
  Inbox,
  ShoppingCart,
  Boxes,
  Globe,
  Users,
  LifeBuoy,
  FileText,
  BarChart3,
  Bell,
  Truck,
  ClipboardList,
  PackageCheck,
  Settings,
  ShieldCheck,
  ShieldAlert,
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
      { label: 'Bekleyen Teslimatlar', href: '/pending', icon: Inbox },
      { label: 'Siparişler', href: '/orders', icon: ShoppingCart },
    ],
  },
  {
    title: 'Envanter',
    items: [
      { label: 'Stok & Ürünler', href: '/stock', icon: Boxes },
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
      { label: 'Bildirimler', href: '/notifications', icon: Bell },
    ],
  },
  {
    title: 'Sistem',
    items: [
      { label: 'Güvenlik', href: '/security', icon: ShieldAlert },
      { label: 'Yöneticiler', href: '/admins', icon: ShieldCheck, ownerOnly: true },
    ],
  },
  {
    title: 'Yakında',
    items: [
      { label: 'Şablonlar', href: '#', icon: FileText, soon: true },
      { label: 'Ayarlar', href: '#', icon: Settings, soon: true },
    ],
  },
];

export const DASHBOARD_ICON = LayoutDashboard;
