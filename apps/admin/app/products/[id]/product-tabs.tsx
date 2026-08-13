'use client';
import * as React from 'react';
import { ClipboardList, KeyRound, Link2, Truck } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../../components/ui/tabs';

/**
 * Ürün detayının sekme kabuğu.
 *
 * İçerikler SUNUCUDA render edilir ve prop olarak gelir (bu bileşen yalnız hangi sekmenin
 * açık olduğunu bilir) → tablolar/formlar sunucu bileşeni olarak kalır, istemciye taşınmaz.
 *
 * Sekme sırası operatörün sıklık sırasıdır: Envanter (en sık) → Eşlemeler → Tedarik →
 * Hareketler (denetim izi, en seyrek).
 */
export function ProductTabs({
  inventory,
  mappings,
  supply,
  ledger,
}: {
  inventory: React.ReactNode;
  mappings: React.ReactNode;
  supply: React.ReactNode;
  ledger: React.ReactNode;
}) {
  return (
    <Tabs defaultValue="inventory">
      <TabsList>
        <TabsTrigger value="inventory">
          <KeyRound aria-hidden /> Envanter
        </TabsTrigger>
        <TabsTrigger value="mappings">
          <Link2 aria-hidden /> Eşlemeler
        </TabsTrigger>
        <TabsTrigger value="supply">
          <Truck aria-hidden /> Tedarik
        </TabsTrigger>
        <TabsTrigger value="ledger">
          <ClipboardList aria-hidden /> Hareketler
        </TabsTrigger>
      </TabsList>

      <TabsContent value="inventory">{inventory}</TabsContent>
      <TabsContent value="mappings">{mappings}</TabsContent>
      <TabsContent value="supply">{supply}</TabsContent>
      <TabsContent value="ledger">{ledger}</TabsContent>
    </Tabs>
  );
}
