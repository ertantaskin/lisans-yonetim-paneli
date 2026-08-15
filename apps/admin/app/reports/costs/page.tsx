import Link from 'next/link';
import { Coins } from 'lucide-react';
import { PageHeader } from '../../../components/ui/page-header';
import { Card } from '../../../components/ui/card';
import { Input } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { apiGet } from '../../../lib/api';
import { CostsView, type CostReport } from '../costs-view';

export const dynamic = 'force-dynamic';

/** Hazır dönem seçenekleri (ay). */
const MONTH_OPTIONS = [3, 6, 12, 24] as const;

/**
 * API'nin parametresiz varsayılanı (`CostsService.DEFAULT_WINDOW_MONTHS`) ile AYNI olmalı —
 * yalnız "hangi düğme etkin görünsün" kararında kullanılır. Ekrandaki METİN her zaman
 * API'nin döndürdüğü `window` alanından yazılır (TEK KAYNAK), yani bu sabit sapsa bile
 * kullanıcıya yanlış bir dönem yazılmaz.
 */
const DEFAULT_MONTHS = 12;

/** '' / boşluk → undefined. */
function trimmed(v?: string): string | undefined {
  const s = (v ?? '').trim();
  return s === '' ? undefined : s;
}

/**
 * "N ay önce"nin yerel gün karşılığı (`YYYY-MM-DD`). API gün girdisini YEREL gün başı
 * olarak yorumlar (bkz. `costs.service.parseBound`), bu yüzden saat taşımaya gerek yok ve
 * adres çubuğu okunabilir kalır.
 *
 * NOT: `setMonth` ay-sonu taşmasını normalleştirir (31 Mart − 1 ay → 3 Mart). Dönem
 * sınırında bir-iki günlük bu kayma rapor okumasını etkilemez; kesin aralık isteyen
 * operatör aşağıdaki özel tarih formunu kullanır.
 */
function monthsAgoDay(months: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - months);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Maliyet raporu — tedarik harcaması / stok değeri / fire / teslim edilen mal maliyeti.
 *
 * ZAMAN PENCERESİ ADRES ÇUBUĞUNDA (`?months=` · `?from=&to=` · `?all=1`): paylaşılabilir,
 * yer imlenebilir ve JS'siz çalışır (düz `<Link>` + native GET formu — SLA raporunun deseni).
 * Veri bu yüzden SUNUCUDA çekilir; `CostsView` yalnız recharts nedeniyle istemci bileşenidir.
 *
 * Parametre verilmezse API varsayılan pencereyi (son 12 ay) uygular — bu sessiz bir kırpma
 * DEĞİLDİR: uygulanan pencere yanıtta döner ve ekranın üstünde bantla yazılır.
 */
export default async function CostsReportPage({
  searchParams,
}: {
  searchParams: Promise<{ months?: string; from?: string; to?: string; all?: string }>;
}) {
  const sp = await searchParams;
  const from = trimmed(sp.from);
  const to = trimmed(sp.to);
  const allTime = trimmed(sp.all) === '1';
  // Özel aralık, hazır dönem seçeneğini EZER (operatörün en son yazdığı şey kazanır).
  const custom = !allTime && Boolean(from || to);

  const rawMonths = Number(trimmed(sp.months));
  const pickedMonths = (MONTH_OPTIONS as readonly number[]).includes(rawMonths)
    ? rawMonths
    : undefined;
  const activeMonths = allTime || custom ? null : (pickedMonths ?? DEFAULT_MONTHS);

  // API sorgusu: yalnız GERÇEKTEN seçilmiş olanı gönder. Hiçbiri yoksa parametresiz çağrı →
  // API varsayılanı uygular ve `window.isDefault=true` döner (ekran bunu ayrıca yazar).
  const qs = new URLSearchParams();
  if (allTime) qs.set('all', '1');
  else if (custom) {
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
  } else if (pickedMonths) qs.set('from', monthsAgoDay(pickedMonths));
  const query = qs.toString();

  let data: CostReport | null = null;
  let error: string | null = null;
  try {
    data = await apiGet<CostReport>(`/v1/admin/reports/costs${query ? `?${query}` : ''}`);
  } catch (e) {
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }

  const chip = (active: boolean) =>
    active
      ? 'rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground'
      : 'rounded-lg border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground';

  return (
    <div>
      <PageHeader
        icon={Coins}
        title="Maliyet Raporu"
        description="Gelir HARİÇ — yalnız tedarik maliyeti (PO). Kâr/marj panelde hesaplanmaz. Para birimleri ayrı raporlanır, toplanmaz."
      >
        <nav aria-label="Dönem" className="flex flex-wrap items-center gap-1">
          {MONTH_OPTIONS.map((m) => (
            <Link
              key={m}
              href={`/reports/costs?months=${m}`}
              aria-current={activeMonths === m ? 'page' : undefined}
              className={chip(activeMonths === m)}
            >
              {m} ay
            </Link>
          ))}
          <Link
            href="/reports/costs?all=1"
            aria-current={allTime ? 'page' : undefined}
            className={chip(allTime)}
          >
            Tüm zamanlar
          </Link>
        </nav>
      </PageHeader>

      {/* Özel aralık: native GET formu → JS'siz çalışır, sonuç adres çubuğunda paylaşılabilir.
          Gün girdisi API'de yerel gün başı/gün SONU olarak yorumlanır (bitiş günü kapsam DIŞI
          kalmasın diye). */}
      <form
        action="/reports/costs"
        method="get"
        className="mb-4 flex flex-wrap items-end gap-2"
        aria-label="Özel tarih aralığı"
      >
        <div className="min-w-0">
          <label htmlFor="cost-from" className="mb-1 block text-xs font-medium text-muted-foreground">
            Başlangıç
          </label>
          <Input id="cost-from" type="date" name="from" defaultValue={from ?? ''} className="w-44" />
        </div>
        <div className="min-w-0">
          <label htmlFor="cost-to" className="mb-1 block text-xs font-medium text-muted-foreground">
            Bitiş
          </label>
          <Input id="cost-to" type="date" name="to" defaultValue={to ?? ''} className="w-44" />
        </div>
        <Button type="submit" variant="outline" size="sm">
          Uygula
        </Button>
        {custom && (
          <Button asChild variant="ghost" size="sm">
            <Link href="/reports/costs">Aralığı temizle</Link>
          </Button>
        )}
      </form>

      {error || !data ? (
        <Card className="p-6">
          <p className="text-sm text-destructive">
            API&apos;ye ulaşılamadı: {error ?? 'Veri yok'}
          </p>
        </Card>
      ) : (
        <CostsView data={data} />
      )}
    </div>
  );
}
