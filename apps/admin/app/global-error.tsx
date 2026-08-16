'use client';
import { ErrorState } from '../components/ui/error-state';
import './globals.css';

/**
 * KÖK hata sınırı (denetim D3).
 *
 * NEDEN: `app/error.tsx` yalnız kök layout BAŞARIYLA render olduktan sonra devreye girer.
 * Kök layout'un KENDİSİ patlarsa (bu panelde gerçek bir yol: `layout.tsx` → `verifySession`
 * / `authEnabled` → `lib/auth.ts:sessionSecret()` ZAYIF `SESSION_SECRET`'te bilerek throw
 * eder — fail-closed) Next kendi İNGİLİZCE varsayılan sayfasını basıyordu: Türkçe metin yok,
 * "Tekrar dene" yok ve en önemlisi **`Hata kodu: <digest>` yok** — oysa bu panelin destek
 * akışının tamamı o digest'i sunucu logundaki kayda eşlemeye dayanıyor. Yani panelin en
 * ölümcül arızasında operatörün elinde tek bir teşhis ipucu bile kalmıyordu.
 *
 * İki zorunluluk:
 *  1. global-error kök layout'un YERİNE geçer → kendi `<html>`/`<body>` etiketlerini
 *     render etmek ZORUNDA.
 *  2. Aynı sebeple kök layout'un `./globals.css` importu da devreye girmez → burada AYRI
 *     import edilir (token'lar/Tailwind yüklenmezse ErrorState renksiz bir metin yığını olurdu).
 *
 * Sunum `app/error.tsx` ile AYNI: ortak `ErrorState` (Türkçe metin + redaksiyon mantığı +
 * digest + "Tekrar dene"). Yalnız başlık, arızanın kapsamını söyleyecek şekilde farklı.
 * NOT: font değişkenleri (`--font-geist`) kök layout'ta tanımlandığı için burada yoktur —
 * sistem fontuna düşer; hata sayfası için kabul edilebilir, kritik olan mesajın okunmasıdır.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="tr" suppressHydrationWarning>
      <body>
        <ErrorState
          error={error}
          reset={reset}
          title="Panel açılamadı"
          description="Panelin ana çatısı yüklenemedi — bu genellikle sunucu yapılandırmasından kaynaklanır (ör. eksik/zayıf SESSION_SECRET) ve sayfayı yenilemek tek başına çözmeyebilir. Aşağıdaki hata kodunu sistem yöneticisiyle paylaşın; kod sunucu loglarındaki kayda birebir karşılık gelir."
        />
      </body>
    </html>
  );
}
