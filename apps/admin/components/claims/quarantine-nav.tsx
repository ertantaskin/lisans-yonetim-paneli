'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Archive, FileText, Inbox } from 'lucide-react';
import { cn } from '../../lib/utils';

/**
 * "Kusurlu Stok" iş istasyonunun bölüm navigasyonu — ÜÇ GERÇEK ROTA.
 *
 * NEDEN SEKME DEĞİL (üç ölçülmüş gerekçe; eskiden tek sayfada `Tabs` vardı):
 *  1. **Kırık breadcrumb:** `/quarantine/claims` bir rota DEĞİLDİ ama fiş detayının breadcrumb'ı
 *     ("Kusurlu Stok › Değişim Fişleri › Detay") son-olmayan segmenti Link yaptığı için oraya
 *     link basıyordu → 404. Bu, projede `/products`'ta bire bir yaşanan hata sınıfı.
 *  2. **Gereksiz sorgu:** tek sayfa her açılışta ÜÇ veri kümesini birden çekiyordu (defter +
 *     fiş listesi + tedarikçiler). Yalnız havuza bakmak için de en ağır sorgu (defter) koşuyordu.
 *  3. **Havuz defterin JS süzgeciydi** (`rows.filter(r => !r.claimId)`): defter sunucu tavanına
 *     dayanınca havuz da SESSİZCE eksiliyordu. Artık havuz sunucudaki `claimed=none` süzgecini
 *     kullanır ve kendi kırpılma uyarısını taşır.
 *
 * SAYAÇ YOK (bilinçli): her sayfa YALNIZ kendi verisini çeker; diğer bölümlerin sayısını
 * bilmez. Sahte ya da bayat bir rakam basmaktansa sayacı her sayfanın KENDİ başlığına
 * bıraktık ("satılmış 6 birim" hatasının dersi: aynı ekranda iki farklı tanım = güvensiz sayı).
 *
 * BÖLÜM TANIMLARI ÇUBUĞUN ÜSTÜNDE DEĞİL: eskiden burada üç tanımı tek satırda anlatan bir
 * paragraf vardı; dar ekranda sağdan KESİLİYORDU ve her sayfanın kendi başlığı zaten aynı şeyi
 * (üstelik o bölüme özel sayılarla) anlatıyordu — yani hem gereksiz tekrar hem bozuk görünüm.
 *
 * GÖRÜNÜM `ui/tabs.tsx` çubuğuyla aynı (operatör için kopukluk olmasın) ama öğeler gerçek
 * `<Link>`: yeni sekmede açılabilir, yer imlenebilir, tarayıcı geri tuşu çalışır.
 */
const SECTIONS = [
  { href: '/quarantine', label: 'Bildirilecekler', icon: Inbox },
  { href: '/quarantine/claims', label: 'Değişim Fişleri', icon: FileText },
  { href: '/quarantine/records', label: 'Tüm Kayıtlar', icon: Archive },
] as const;

export function QuarantineNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Kusurlu stok bölümleri" className="mb-5">
      {/*
        SARMA VAR, KAYDIRMA YOK: üç öğe geniş ekranda tek satıra sığar, dar ekranda alt satıra
        SARAR. Önceki sürüm `overflow-x-auto` kullanıyordu ve masaüstünde bile görünür bir
        kaydırma çubuğu artefaktı bırakıyordu (kullanıcı bulgusu). Kap artık kırpmadığı için
        odak halkası yerine panelin STANDART outline'ı kullanılabiliyor (tek odak göstergesi
        kuralı — bkz. globals.css).
      */}
      <ul className="flex flex-wrap items-center gap-1 rounded-lg border border-border bg-muted/40 p-1">
        {SECTIONS.map((s) => {
          // '/quarantine' TAM eşleşme olmalı (prefix olsaydı her alt rotada da aktif görünürdü);
          // alt bölümler prefix ile eşleşir → '/quarantine/claims/<id>' detayında da "Değişim
          // Fişleri" aktif kalır.
          const active =
            s.href === '/quarantine'
              ? pathname === '/quarantine'
              : pathname === s.href || pathname.startsWith(s.href + '/');
          const Icon = s.icon;
          return (
            <li key={s.href}>
              <Link
                href={s.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex items-center gap-2 whitespace-nowrap rounded-md px-3.5 py-2 text-sm font-medium transition-colors',
                  '[&_svg]:size-4 [&_svg]:shrink-0',
                  active
                    ? // Aktif bölüm: yükseltilmiş yüzey + ince kenar → gri zeminden AÇIKÇA ayrışır.
                      'bg-background text-foreground shadow-sm ring-1 ring-border'
                    : 'text-muted-foreground hover:bg-background/60 hover:text-foreground',
                )}
              >
                <Icon />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
