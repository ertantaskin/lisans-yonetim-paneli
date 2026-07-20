import type { Metadata } from 'next';
import { Sidebar } from '../components/sidebar';
import './globals.css';

export const metadata: Metadata = {
  title: 'Jetlisans — Lisans Dağıtım Paneli',
  description: 'Merkezi lisans stok ve teslimat paneli',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Arayüz Türkçe-öncelikli (§17).
  return (
    <html lang="tr">
      <body>
        <div className="flex min-h-screen">
          <Sidebar />
          <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
        </div>
      </body>
    </html>
  );
}
