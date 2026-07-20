import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jetlisans — Lisans Dağıtım Paneli',
  description: 'Merkezi lisans stok ve teslimat paneli',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Arayüz Türkçe-öncelikli (§17).
  return (
    <html lang="tr">
      <body>{children}</body>
    </html>
  );
}
