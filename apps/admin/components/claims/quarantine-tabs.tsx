'use client';
import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

/**
 * "Kusurlu Stok" iş istasyonunun sekmeleri.
 *
 * NEDEN ÜÇ SEKME (eskiden ikiydi): "Bekleyenler" sekmesinin İÇİNDE hem bildirilmeyi bekleyen
 * havuz hem de TÜM ölü kalemleri gösteren defter tablosu vardı → sekme "1" yazarken altındaki
 * liste 16 satır gösteriyordu ve operatör hangi sayının neyi anlattığını bilmiyordu (kullanıcı
 * geri bildirimi: "çok karışık"). Artık her sekmenin TEK işi var:
 *   Bildirilecekler → henüz fişe girmemiş kusur havuzu (iş listesi)
 *   Değişim Fişleri → kesilen fişler ve tedarikçi yanıtları (takip)
 *   Tüm Kayıtlar    → değişmez defter + süzgeç + dışa aktarma (arşiv/denetim)
 *
 * İSTEMCİ SARMALAYICI ama İÇERİK SUNUCUDA render edilir: sekme gövdeleri prop olarak
 * (ReactNode) gelir (ürün detayındaki `product-tabs.tsx` deseni) — büyük tablolar istemci
 * paketine taşınmaz, istemciye yalnız sekme durumu iner.
 */
export function QuarantineTabs({
  pendingCount,
  claimCount,
  ledgerCount,
  pending,
  claims,
  ledger,
}: {
  pendingCount: number;
  claimCount: number;
  ledgerCount: number;
  pending: React.ReactNode;
  claims: React.ReactNode;
  ledger: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="pending" className="space-y-4">
      <TabsList>
        <TabsTrigger value="pending">
          Bildirilecekler
          <span className="ml-1 tabular-nums text-muted-foreground">{pendingCount}</span>
        </TabsTrigger>
        <TabsTrigger value="claims">
          Değişim Fişleri
          <span className="ml-1 tabular-nums text-muted-foreground">{claimCount}</span>
        </TabsTrigger>
        <TabsTrigger value="ledger">
          Tüm Kayıtlar
          <span className="ml-1 tabular-nums text-muted-foreground">{ledgerCount}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending" className="space-y-4">
        {pending}
      </TabsContent>
      <TabsContent value="claims" className="space-y-4">
        {claims}
      </TabsContent>
      <TabsContent value="ledger" className="space-y-4">
        {ledger}
      </TabsContent>
    </Tabs>
  );
}
