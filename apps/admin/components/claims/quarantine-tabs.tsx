'use client';
import * as React from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

/**
 * "Kusurlu Anahtarlar" iş istasyonunun iki sekmesi.
 *
 * İSTEMCİ SARMALAYICI ama İÇERİK SUNUCUDA render edilir: iki sekmenin gövdesi prop olarak
 * (ReactNode) gelir. Böylece karantina tablosu ve fiş listesi sunucu tarafında hazırlanır,
 * istemciye yalnız sekme durumu iner (ürün detayındaki `product-tabs.tsx` deseni).
 */
export function QuarantineTabs({
  pendingCount,
  claimCount,
  pending,
  claims,
}: {
  pendingCount: number;
  claimCount: number;
  pending: React.ReactNode;
  claims: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="pending" className="space-y-4">
      <TabsList>
        <TabsTrigger value="pending">
          Bekleyenler
          <span className="ml-1 tabular-nums text-muted-foreground">{pendingCount}</span>
        </TabsTrigger>
        <TabsTrigger value="claims">
          Fişler
          <span className="ml-1 tabular-nums text-muted-foreground">{claimCount}</span>
        </TabsTrigger>
      </TabsList>
      <TabsContent value="pending" className="space-y-4">
        {pending}
      </TabsContent>
      <TabsContent value="claims" className="space-y-4">
        {claims}
      </TabsContent>
    </Tabs>
  );
}
