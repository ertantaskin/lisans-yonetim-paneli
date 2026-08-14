'use client';
import * as React from 'react';
import { ChevronDown, Plus, X } from 'lucide-react';
import { Button } from './button';
import { Card, CardContent } from './card';
import { cn } from '../../lib/utils';

/**
 * "Butonla açılan form" kabuğu (disclosure).
 *
 * NEDEN (kullanıcı geri bildirimi): liste ekranlarındaki "Yeni …" oluşturma formları HEP
 * AÇIK duruyordu; ekranın üstünde sürekli yer kaplayıp asıl içeriği (listeyi) aşağı itiyordu.
 * Oysa oluşturma seyrek bir iş — varsayılan KAPALI, istenince açılır.
 *
 * Gövde açıkken DOM'a girer (kapalıyken hiç render edilmez): form durumu her kapanışta
 * sıfırlanır ve kapalı formdaki alanlar sekme sırasına GİRMEZ (a11y). Alt bileşen sunucudan
 * gelen bir form olabilir — `children` olarak alınır, bu kabuk yalnız açılıp kapanmayı bilir.
 */
export function CollapsiblePanel({
  title,
  icon,
  openLabel,
  closeLabel = 'Kapat',
  description,
  defaultOpen = false,
  className,
  children,
}: {
  title: string;
  /**
   * İkon ELEMENT olarak alınır (`icon={<Plus />}`), bileşen olarak DEĞİL.
   *
   * NEDEN: bu bir istemci bileşeni; çağıranlar sunucu bileşeni (app dizinindeki sayfalar). Bir lucide
   * BİLEŞENİ (fonksiyon) sunucudan istemciye prop olarak geçirilemez — React "Functions cannot
   * be passed directly to Client Components" ile ÇALIŞMA ANINDA patlar (typecheck ve build
   * yakalamaz; sahada `/suppliers` bu yüzden hata sınırına düştü). Element serileştirilebilir.
   */
  icon?: React.ReactNode;
  /** Kapalıyken düğmenin metni (varsayılan: başlığın kendisi). */
  openLabel?: string;
  closeLabel?: string;
  description?: string;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const bodyId = React.useId();

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  /**
   * Bir sonraki render'da odağın NEREYE taşınacağı ('none' = dokunma).
   *
   * DENETİM BULGUSU (orta, a11y): kapalı ve açık hâller TAMAMEN ayrı ağaçlar; açılınca
   * tetikleyici düğme unmount oluyor ve odak `<body>`ye düşüyordu → klavye/ekran okuyucu
   * kullanıcısı formun neresinde olduğunu kaybedip sekmeyle sayfa başından geri geliyordu
   * (kullanım: /categories "Yeni Kategori", /admins "Yeni Admin", /suppliers "Yeni Tedarikçi").
   * İki ağaç KORUNDU (görsel tasarım değişmesin) ama odak elle taşınır: açılışta gövdedeki
   * ilk odaklanabilir alana, kapanışta tetikleyiciye geri.
   *
   * REF (state değil): odak taşıma bir YAN ETKİDİR, render'a girmemeli; ayrıca ilk render'da
   * (`defaultOpen`) odağın ÇALINMAMASI için "kullanıcı etkileşimi oldu mu" bilgisi gerekir —
   * bayrak yalnız tıklama işleyicilerinde kurulur.
   */
  const focusIntent = React.useRef<'none' | 'body' | 'trigger'>('none');

  React.useEffect(() => {
    const want = focusIntent.current;
    if (want === 'none') return;
    focusIntent.current = 'none';
    if (want === 'trigger') {
      triggerRef.current?.focus();
      return;
    }
    // Gövdedeki ilk odaklanabilir alan; yoksa (salt-metin gövde) Kapat düğmesi — odak her
    // hâlükârda panelin İÇİNDE kalır.
    const first = bodyRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? closeRef.current)?.focus();
  }, [open]);

  if (!open) {
    return (
      <div className={cn('mb-5', className)}>
        {/* `aria-controls` VERİLMEZ: gövde kapalıyken DOM'da yok, var olmayan bir id'yi
            işaret etmek yardımcı teknolojide kırık ilişki üretir. `aria-expanded` yeterli. */}
        <Button
          ref={triggerRef}
          variant="outline"
          onClick={() => {
            focusIntent.current = 'body';
            setOpen(true);
          }}
          aria-expanded={false}
        >
          {icon ?? <Plus aria-hidden />} {openLabel ?? title}
        </Button>
        {description && <p className="mt-1.5 text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  }

  return (
    <Card className={cn('mb-5 max-w-2xl', className)}>
      <CardContent className="p-5">
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <span className="text-muted-foreground [&_svg]:size-4">{icon ?? <Plus aria-hidden />}</span>{" "}
              {title}
            </h2>
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="sm"
            onClick={() => {
              focusIntent.current = 'trigger';
              setOpen(false);
            }}
            aria-expanded
            aria-controls={bodyId}
          >
            <X aria-hidden /> {closeLabel}
          </Button>
        </div>
        <div id={bodyId} ref={bodyRef}>
          {children}
        </div>
      </CardContent>
    </Card>
  );
}

/** Gövdedeki ilk odaklanabilir öğeyi bulmak için seçici (devre dışı/gizli olanlar hariç). */
const FOCUSABLE =
  'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** Kapalı/açık okunu gerektiren yerler için küçük yardımcı (şu an yalnız tip uyumu). */
export const CollapsibleChevron = ChevronDown;
