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
  Settings,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  label: string;
  href: string;
  icon: LucideIcon;
  soon?: boolean;
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
    title: 'Sistem',
    items: [{ label: 'Yöneticiler', href: '/admins', icon: ShieldCheck }],
  },
  {
    title: 'Yakında',
    items: [
      { label: 'Müşteriler', href: '#', icon: Users, soon: true },
      { label: 'Destek', href: '#', icon: LifeBuoy, soon: true },
      { label: 'Şablonlar', href: '#', icon: FileText, soon: true },
      { label: 'Raporlar', href: '#', icon: BarChart3, soon: true },
      { label: 'Ayarlar', href: '#', icon: Settings, soon: true },
    ],
  },
];

export const DASHBOARD_ICON = LayoutDashboard;
