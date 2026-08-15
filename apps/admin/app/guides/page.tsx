import Link from 'next/link';
import { BookOpen, Boxes } from 'lucide-react';
import { PageHeader } from '../../components/ui/page-header';
import { Alert, AlertDescription } from '../../components/ui/alert';
import { Button } from '../../components/ui/button';
import { HowItWorks } from '../../components/ui/help-note';
import { GuidesManager } from '../../components/guides-manager';
import { getGuides } from './queries';
import type { GuideRow } from '../../lib/guides';

export const dynamic = 'force-dynamic';

/**
 * Kurulum Rehberleri (§7) — lisansla BİRLİKTE müşteriye giden talimat metinleri.
 *
 * Anahtarı teslim etmek yetmiyor: müşteri "Office 365'e nasıl giriş yaparım", "Windows
 * anahtarını nereye girerim" cevabını da almalı. Metin ÜRÜNE GÖMÜLMEZ, ayrı kayıttır —
 * aynı anlatı onlarca SKU'da ortaktır ve bir adım değişince tek yerden düzelmelidir.
 */
export default async function GuidesPage() {
  let guides: GuideRow[] = [];
  let error: string | null = null;
  try {
    guides = await getGuides();
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={BookOpen}
        title="Kurulum Rehberleri"
        description="Lisansla birlikte müşteriye giden kurulum ve etkinleştirme talimatları. Bir rehber birden çok ürüne bağlanabilir; metni düzeltmek bağlı tüm ürünlerde anında geçerli olur."
      >
        <Button asChild variant="outline">
          <Link href="/stock">
            <Boxes className="size-4" /> Stok & Ürünler
          </Link>
        </Button>
      </PageHeader>

      <HowItWorks
        compact
        steps={[
          {
            title: 'Rehberi yaz',
            text: 'Adım adım talimat: nereye giriş yapılacak, anahtar nereye girilecek, nelere dikkat edilecek. Hazır taslaklardan başlayabilirsiniz.',
          },
          {
            title: 'Ürüne bağla',
            text: 'Ürün eklerken/düzenlerken rehberi listeden seçin. Hiçbir ürüne bağlı olmayan rehber müşteriye ulaşmaz — listede uyarı olarak işaretlenir.',
          },
          {
            title: 'Teslimatla gider',
            text: 'Sipariş teslim edilince rehber mağaza sipariş sayfasında görünür, teslimat e-postasına eklenir ve indirilen .txt dosyasına yazılır.',
          },
        ]}
      />

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>API&apos;ye ulaşılamadı: {error}</AlertDescription>
        </Alert>
      ) : (
        <GuidesManager guides={guides} />
      )}
    </div>
  );
}
