'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
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
 * GÖRÜNÜM `ui/tabs.tsx` çubuğuyla aynı (operatör için kopukluk olmasın) ama öğeler gerçek
 * `<Link>`: yeni sekmede açılabilir, yer imlenebilir, tarayıcı geri tuşu çalışır.
 */
const SECTIONS = [
  { href: '/quarantine', label: 'Bildirilecekler' },
  { href: '/quarantine/claims', label: 'Değişim Fişleri' },
  { href: '/quarantine/records', label: 'Tüm Kayıtlar' },
] as const;

export function QuarantineNav() {
  const pathname = usePathname();

  return (
    <div className="mb-4 space-y-2">
      {/* Hangi bölüm ne işe yarar — sekme jsdoc'undaki üç cümle, tek satırda. */}
      <p className="text-xs text-muted-foreground">
        <strong className="font-medium text-foreground">Bildirilecekler</strong> henüz fişe girmemiş
        kusur havuzudur (iş listesi) · <strong className="font-medium text-foreground">Değişim
        Fişleri</strong> kesilen fişler ve tedarikçi yanıtlarıdır (takip) ·{' '}
        <strong className="font-medium text-foreground">Tüm Kayıtlar</strong> değişmez defterdir
        (süzgeç, dışa aktarma, denetim).
      </p>

      <nav aria-label="Kusurlu stok bölümleri">
        <ul className="inline-flex h-9 w-full items-center gap-1 overflow-x-auto rounded-lg border border-border bg-muted/40 p-1 sm:w-auto">
          {SECTIONS.map((s) => {
            // '/quarantine' TAM eşleşme olmalı (prefix olsaydı her alt rotada da aktif görünürdü);
            // alt bölümler prefix ile eşleşir → '/quarantine/claims/<id>' detayında da "Değişim
            // Fişleri" aktif kalır.
            const active =
              s.href === '/quarantine'
                ? pathname === '/quarantine'
                : pathname === s.href || pathname.startsWith(s.href + '/');
            return (
              <li key={s.href}>
                <Link
                  href={s.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium transition-colors',
                    // `ui/tabs.tsx` ile AYNI istisna: kap `overflow-x-auto` taşıdığı için global
                    // odak outline'ı üst/alttan kırpılıyor → içeri çizilen halka kullanılır.
                    'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                    active
                      ? 'bg-background text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {s.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
