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
import { itemCount } from '../../../lib/labels';

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
  kind,
}: {
  batchId: string;
  batchLabel: string;
  customerCount: number;
  recalled: boolean;
  /** Partinin ürün tipi — metinler "anahtar/hesap/kod" der; yoksa nötr "kalem". */
  kind?: string;
}) {
  const router = useRouter();
  const [refreshKey, setRefreshKey] = React.useState(0);

  const handleMutated = React.useCallback(() => {
    setRefreshKey((k) => k + 1);
    router.refresh();
  }, [router]);

  return (
    <>
      {/* ── Müşterilerdeki kalemler (değişim karar listesi) ──
          Geri çekme YALNIZ stoğu geçersiz kılar; teslim edilmiş kalemlere dokunmaz çünkü
          bir kısmı çalışıyor olabilir. Bu kart operatörün iş listesidir ve bir kalem
          değiştirildikçe kendiliğinden kısalır (eski atama artık canlı değildir). */}
      {customerCount > 0 && (
        <Card>
          <CardHeader>
            <CardTitle icon={Users}>Müşterilerdeki lisanslar</CardTitle>
            <CardDescription>
              Bu partiden çıkmış ve <strong>şu anda müşterilerin elinde olan</strong>{' '}
              {itemCount(customerCount, kind)}. {recalled ? 'Parti geri çekildi ama b' : 'B'}
              unlar çalışmaya devam ediyor ve müşteri görmeye devam ediyor — otomatik iptal
              edilmezler. Sorunlu olanı satırdaki <strong>“Siparişe git”</strong> ile açıp orada{' '}
              <strong>“Değiştir”</strong> deyin: müşteriye stoktaki uygun ilk kalem atanır, eskisi
              karantinaya gider ve bu listeden düşer. Uygun stok yoksa işlem yapılmaz, müşteri
              boşta kalmaz.
              {/*
                TOPLU DEĞİŞTİRME ŞARTA BAĞLI (denetim bulgusu): bu cümle koşulsuz yazılıyordu ve
                menü öğesi YALNIZ geri çekilmiş partide var (API de `status='recalled'` değilse
                reddediyor). Aktif partide operatör listeye gidip aradığını bulamıyordu.
              */}
              {recalled ? (
                <>
                  {' '}
                  Tümünü birden yenilemek için <strong>Partiler</strong> listesindeki satır
                  menüsünde <strong>“Toplu Değiştir (satılanları)”</strong> vardır.
                </>
              ) : (
                <>
                  {' '}
                  Parti henüz geri çekilmediği için <strong>aynı partiden</strong> bir kalem
                  atanabilir — kusur partinin tamamındaysa önce partiyi <strong>geri çekin</strong>;
                  toplu değiştirme yalnız geri çekilmiş partide açılır.
                </>
              )}
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
            müşterilerdekiler, geçersiz kılınanlar ve karantinadakiler dahil. Bozuk olanları
            satırları işaretleyip topluca stoktan düşebilirsiniz (yalnız stokta bekleyenler
            seçilebilir; teslim edilmiş kalem buradan öldürülmez).
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
