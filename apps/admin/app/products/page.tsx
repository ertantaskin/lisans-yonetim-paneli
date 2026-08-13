import { redirect } from 'next/navigation';

/**
 * `/products` TASARLANMIŞ BİR EKRAN DEĞİL — ürün listesi `/stock` ("Stok & Ürünler")
 * altında yaşar (ürün DataTable + "Yeni Ürün"). Bu dosya bir ÖLÜ LİNKİ kapatır:
 * `/products/[id]` sayfasındayken üst bar breadcrumb'ı yol parçalarından üretildiği için
 * "products" segmentine link basıyordu ve o adreste page.tsx olmadığı için 404 dönüyordu
 * (kullanıcı bildirdi). İkinci bir ürün listesi EKLENMEDİ — aynı veriyi iki adreste
 * göstermek, hangisinin doğru olduğu belirsiz iki ekran üretirdi.
 *
 * GERÇEK yönlendirmeyi `middleware.ts` yapar (temiz 307, render'dan ÖNCE). Bu sayfa YEDEK:
 * buradaki `redirect()` tek başına yeterli DEĞİL — async root layout stream'e başladığı için
 * Next 307 yerine meta-refresh gövdesi üretiyor (dev'de ölçüldü: 200 + boş kabuk; kök yol
 * için de aynı sebeple middleware kullanılıyor). Yine de duruyor ki middleware matcher'ı
 * ileride daraltılırsa adres 404'e geri dönmesin.
 *
 * Kalıcı yönlendirme DEĞİL (307): ileride ürünler kendi ekranına taşınırsa tarayıcı
 * önbelleğinde yapışıp kalmasın.
 */
export default function ProductsIndexPage() {
  redirect('/stock');
}
