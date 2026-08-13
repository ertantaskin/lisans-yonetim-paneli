'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, Users } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../../components/ui/card';
import { LicenseItemsTable } from '../../../components/inventory/license-items-table';

/**
 * Parti detayının İKİ lisans tablosu — tek bir tazeleme sinyalini paylaşırlar.
 *
 * NEDEN İSTEMCİ SARMALAYICI: sayfa bir sunucu bileşenidir, iki tabloyu doğrudan render
 * edebilir; ama aynı kalem HER İKİ tabloda da listelenir (canlı ataması olan bir anahtar
 * hem "müşterilerdeki" listesinde hem "bu partideki" listesinde vardır). Tablolar kendi
 * istemci state'lerini tuttuğu için birinden değişim yapıldığında diğeri BAYAT kalıyordu:
 * operatör aynı anahtarı ikinci listeden tekrar tıklayınca API'den kriptik bir 400 alıyordu
 * (veri güvenliydi — ikinci taze anahtar YAKILMAZ, guard yakalar — ama ekran yalan söylüyordu).
 *
 * Çözüm: paylaşılan bir sayaç. Her mutasyon `onMutated` ile sayacı artırır, artan `refreshKey`
 * İKİ tabloyu birden yeniden çeker. `router.refresh()` ise sunucu tarafındaki SAYAÇ ŞERİDİNİ
 * (Stokta / Müşterilerde / Düşmüş) tazeler — o veriyi tablolar değil, sayfanın kendisi çeker.
 */
export function BatchLicensePanels({
  batchId,
  batchLabel,
  customerCount,
  recalled,
}: {
  batchId: string;
  batchLabel: string;
  customerCount: number;
  recalled: boolean;
}) {
  const router = useRouter();
  const [refreshKey, setRefreshKey] = React.useState(0);

  const handleMutated = React.useCallback(() => {
    setRefreshKey((k) => k + 1);
    router.refresh();
  }, [router]);

  return (
    <>
      {/* ── Müşterilerdeki anahtarlar (değişim karar listesi) ──
          Geri çekme YALNIZ stoğu geçersiz kılar; teslim edilmiş anahtarlara dokunmaz çünkü
          bir kısmı çalışıyor olabilir. Bu kart operatörün iş listesidir ve bir anahtar
          değiştirildikçe kendiliğinden kısalır (eski atama artık canlı değildir). */}
      {customerCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle icon={Users}>Müşterilerdeki lisanslar</CardTitle>
            <CardDescription>
              Bu partiden çıkmış ve <strong>şu anda müşterilerin elinde olan</strong>{' '}
              {customerCount} anahtar. {recalled ? 'Parti geri çekildi ama b' : 'B'}
              unlar çalışmaya devam ediyor ve müşteri görmeye devam ediyor — otomatik iptal
              edilmezler. Sorunlu olanı satırdaki{' '}
              <strong>“Yeni anahtarla değiştir”</strong> ile yenileyin: müşteriye başka bir
              partiden taze anahtar atanır, eski anahtar karantinaya gider ve bu listeden düşer.
              Uygun stok yoksa işlem yapılmaz, müşteri boşta kalmaz.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <LicenseItemsTable
              batchId={batchId}
              lockedHolder="customer"
              refreshKey={refreshKey}
              onMutated={handleMutated}
            />
          </CardContent>
        </Card>
      )}

      {/* ── Partinin TÜM lisansları ── */}
      <Card>
        <CardHeader>
          <CardTitle icon={KeyRound}>Bu partideki lisanslar</CardTitle>
          <CardDescription>
            Yalnız <strong>{batchLabel}</strong> partisinden gelen kalemlerin tamamı — stoktakiler,
            müşterilerdekiler, geçersiz kılınanlar ve karantinadakiler dahil. Bozuk anahtarları
            satırları işaretleyip topluca stoktan düşebilirsiniz (yalnız stokta bekleyenler
            seçilebilir; teslim edilmiş anahtar buradan öldürülmez).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <LicenseItemsTable
            batchId={batchId}
            refreshKey={refreshKey}
            onMutated={handleMutated}
          />
        </CardContent>
      </Card>
    </>
  );
}
