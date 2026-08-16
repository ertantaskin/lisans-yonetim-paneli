'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  TriangleAlert,
  Coins,
  Warehouse,
  PackageX,
  Building2,
  Boxes,
  CalendarDays,
  CalendarRange,
  Truck,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { StatTile } from '../../components/ui/stat-tile';
import { Alert, AlertDescription, AlertTitle } from '../../components/ui/alert';
import { EmptyState } from '../../components/ui/page-header';

// ── Sözleşme (backend ile AYNI): salt-okunur TEDARİK maliyeti, gelir/kâr YOK ──
interface BySupplier {
  supplierId: string;
  supplier: string;
  currency: string;
  spentCents: number;
  poCount: number;
}
interface ByMonth {
  month: string;
  currency: string;
  spentCents: number;
  /**
   * Maliyeti bilinmeyen (emirsiz ya da birim maliyeti girilmemiş) parti adedi. Uç eskiden
   * bu partileri INNER JOIN ile SESSİZCE eliyordu → aylık grafik "o ay bu kadar harcandı"
   * derken bazı alımlar hiç görünmüyordu. Opsiyonel: eski API ile de çalışır.
   */
  uncoveredQty?: number;
}
interface ByProduct {
  productId: string;
  product: string;
  currency: string;
  spentCents: number;
  qtyReceived: number;
}
interface Valuation {
  currency: string;
  valuedCents: number;
  valuedUnits: number;
  uncoveredUnits: number;
  /**
   * `status='available'` AMA stok ömrü (expires_at) dolmuş kapasite — ATAMA sorgusu bunları
   * ZATEN dışlar, yani satılamaz. Bu yüzden `valuedUnits`/`uncoveredUnits`'e GİRMEZ ve
   * "Stok Değeri" kartında görünmez.
   *
   * NEDEN YÜZEYE ÇIKIYOR: uç bu iki alanı döndürüyor ama ekran okumuyordu → bugün rafta duran
   * ama teslim EDİLEMEYECEK sermaye panelde hiçbir yerde görünmüyordu (fiilen zayi).
   *
   * OPSİYONEL (dağıtım sapması): eski API imajında alan gelmez → bant hiç çizilmez.
   */
  expiredUnits?: number;
  /** `expiredUnits`'in oranlanmış parasal karşılığı (yalnız maliyeti bağlanabilenler için). */
  expiredCents?: number;
}
interface Wastage {
  currency: string;
  wastedCents: number;
  events: number;
  uncoveredEvents: number;
}
interface DeliveredCogs {
  currency: string;
  cogsCents: number;
  deliveredUnits: number;
  uncoveredUnits: number;
}
/**
 * Uygulanan zaman penceresi (API `CostWindow` ile BİREBİR).
 *
 * OPSİYONEL (dağıtım sapması): admin, API'den ÖNCE dağıtılırsa alan gelmez — ekran hata
 * kartına düşmemeli, yalnız pencere bandını göstermez. Bu projenin standart savunması.
 */
interface CostWindow {
  from: string | null;
  to: string | null;
  allTime: boolean;
  isDefault: boolean;
  defaultMonths: number;
}
interface CostReport {
  generatedAt: string;
  window?: CostWindow;
  bySupplier: BySupplier[];
  byMonth: ByMonth[];
  byProduct: ByProduct[];
  valuation: Valuation[];
  wastage: Wastage[];
  deliveredCogs: DeliveredCogs[];
}

export type { CostReport, CostWindow };

// Grafik renk döngüsü (globals.css --chart-1..6, iki tema uyumlu).
const CHART_COLORS = [
  'var(--chart-1)',
  'var(--chart-2)',
  'var(--chart-3)',
  'var(--chart-4)',
  'var(--chart-5)',
  'var(--chart-6)',
];

/** Kuruş → para birimi metni (ör. 12000 TRY → "120,00 TRY"). Para birimi satır başına. */
function money(cents: number, currency: string): string {
  return `${(cents / 100).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

/** Sayı → tr-TR biçim (binlik ayraç). */
function fmtNum(n: number): string {
  return n.toLocaleString('tr-TR');
}

/** ISO → tr-TR tarih-saat. */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
}

/** ISO → tr-TR gün (saat yok — pencere sınırları gün hassasiyetinde okunur). */
function fmtDay(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('tr-TR', { dateStyle: 'medium' });
}

/**
 * Uygulanan pencerenin insan-okur karşılığı. SESSİZ KIRPMA YASAK: rapor daraltılmışsa
 * ekranda YAZAR (varsayılan pencere dahil — operatör hiçbir şey seçmemiş olsa bile).
 */
function windowText(w: CostWindow): string {
  if (w.allTime) return 'Tüm zamanlar (tarih sınırı yok)';
  if (w.from && w.to) return `${fmtDay(w.from)} – ${fmtDay(w.to)}`;
  if (w.from) return `${fmtDay(w.from)} tarihinden bugüne`;
  if (w.to) return `${fmtDay(w.to)} tarihine kadar`;
  return 'Tüm zamanlar (tarih sınırı yok)';
}

// Grafik datum'u (para birimi başına gruplanır → tek eksende karıştırılmaz).
interface Datum {
  key: string;
  value: number; // birim (kuruş/100) — çubuk yüksekliği
  cents: number;
  currency: string;
  sub?: string;
}

/** Para birimine göre grupla → [currency, rows][] (para birimi alfabetik). */
function groupByCurrency<T extends { currency: string }>(rows: T[]): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = map.get(r.currency);
    if (bucket) bucket.push(r);
    else map.set(r.currency, [r]);
  }
  return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Recharts tooltip — token temelli, para birimini biçimlendirir. */
function MoneyTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: Datum }>;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="font-medium text-popover-foreground">{p.key}</div>
      <div className="mt-1 tabular-nums font-semibold text-foreground">{money(p.cents, p.currency)}</div>
      {p.sub && <div className="text-muted-foreground">{p.sub}</div>}
    </div>
  );
}

/** Tek para birimi için maliyet çubuğu grafiği. */
function CostBars({ rows }: { rows: Datum[] }) {
  return (
    <div className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, left: -8, bottom: 8 }}>
          <XAxis
            dataKey="key"
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={{ stroke: 'var(--border)' }}
            interval={0}
            angle={-30}
            textAnchor="end"
            height={56}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => fmtNum(Number(v))}
          />
          <Tooltip cursor={{ fill: 'var(--muted)', opacity: 0.4 }} content={<MoneyTooltip />} />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {rows.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/**
 * Kart içi, para birimi başına ayrı grafik blokları. Birden fazla para birimi varsa
 * her biri kendi başlığıyla ayrı çizilir (tek eksende karıştırma yok).
 */
function ChartCard({
  title,
  icon: Icon,
  description,
  groups,
  multiCurrency,
}: {
  title: string;
  icon: LucideIcon;
  description: string;
  groups: Array<[string, Datum[]]>;
  multiCurrency: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 text-muted-foreground" /> {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {groups.map(([currency, rows]) => (
          <div key={currency}>
            {multiCurrency && (
              <div className="mb-1 text-xs font-medium text-muted-foreground">{currency}</div>
            )}
            <CostBars rows={rows} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/**
 * Maliyet raporu sunumu. Veri SUNUCUDA çekilir (sayfa bileşeni) ve prop olarak gelir:
 * zaman penceresi adres çubuğundan (`?months=`/`?from=&to=`/`?all=1`) sürüldüğü için
 * paylaşılabilir/yer imlenebilir olmalı — istemci içi fetch bunu URL'e yansıtamazdı.
 * Bu bileşen yalnız recharts yüzünden 'use client'.
 */
export function CostsView({ data }: { data: CostReport }) {
  // Para birimi kümesi + karışık mı? (tüm bölümlerin birleşimi)
  // NOT: boş ('') currency GERÇEK bir para birimi değil — maliyeti bağlanamayan
  // (partiye/PO'ya/snapshot'a bağlı olmayan) kayıtların kovasıdır. Kümeden çıkarılır ki
  // tek-para-birimli mağaza, yalnız uncovered kayıt yüzünden "karışık" sanılmasın.
  const currencies = React.useMemo(() => {
    if (!data) return [] as string[];
    const set = new Set<string>();
    for (const r of data.valuation) set.add(r.currency);
    for (const r of data.wastage) set.add(r.currency);
    for (const r of data.byMonth) set.add(r.currency);
    for (const r of data.bySupplier) set.add(r.currency);
    for (const r of data.byProduct) set.add(r.currency);
    for (const r of data.deliveredCogs ?? []) set.add(r.currency);
    set.delete(''); // uncovered kova karışık para birimi saydırmaz
    return [...set].sort((a, b) => a.localeCompare(b));
  }, [data]);
  // Karışık uyarısı yalnız GERÇEK ayrı para birimi sayısı >1 iken.
  const multiCurrency = currencies.length > 1;

  /**
   * Aylık harcamada KAPSANAMAYAN adet (emirsiz/maliyetsiz parti). Grafiğe GİRMEZ — parası
   * bilinmeyen bir alımı 0 ₺ diye çizmek "o ay hiç harcama yok" yalanını söylerdi; sayı
   * metin olarak yazılır (valuation/wastage'daki dürüstlük deseninin aynısı).
   */
  const uncoveredMonthQty = React.useMemo(
    () => (data?.byMonth ?? []).reduce((s, r) => s + (r.uncoveredQty ?? 0), 0),
    [data],
  );

  // Aylık harcama (para birimi başına, ay artan) → Datum grupları.
  // BOŞ para birimi ('') ELENİR: uç artık PO'suz partileri de döndürüyor (LEFT JOIN) ve
  // onların `spentCents`'i 0'dır → elenmeseydi hepsi sıfır olan bir hayalet grafik grubu çizilirdi.
  const monthGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.byMonth.filter((r) => r.currency !== '')).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => a.month.localeCompare(b.month))
        .map((r) => ({ key: r.month, value: r.spentCents / 100, cents: r.spentCents, currency })),
    ]);
  }, [data]);

  // Tedarikçi kırılımı (para birimi başına, harcama azalan, ilk 12).
  const supplierGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.bySupplier).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => b.spentCents - a.spentCents)
        .slice(0, 12)
        .map((r) => ({
          key: r.supplier,
          value: r.spentCents / 100,
          cents: r.spentCents,
          currency,
          sub: `${fmtNum(r.poCount)} satın alma emri`,
        })),
    ]);
  }, [data]);

  // Ürün kırılımı (para birimi başına, harcama azalan, ilk 12).
  const productGroups = React.useMemo<Array<[string, Datum[]]>>(() => {
    if (!data) return [];
    return groupByCurrency(data.byProduct).map(([currency, rows]): [string, Datum[]] => [
      currency,
      [...rows]
        .sort((a, b) => b.spentCents - a.spentCents)
        .slice(0, 12)
        .map((r) => ({
          key: r.product,
          value: r.spentCents / 100,
          cents: r.spentCents,
          currency,
          sub: `${fmtNum(r.qtyReceived)} birim alındı`,
        })),
    ]);
  }, [data]);

  const w = data.window;
  /*
   * Pencere bandı: rapor DARALTILMIŞSA (hatta operatör hiçbir şey seçmemiş olsa bile —
   * varsayılan 12 ay) ekran bunu YAZAR. "Tüm zamanlar" seçiliyken band gösterilmez:
   * gösterilecek bir daraltma yoktur.
   */
  const windowBanner =
    w && !w.allTime ? (
      <Alert variant="info">
        <CalendarRange />
        <div>
          <AlertTitle>Seçili dönem: {windowText(w)}</AlertTitle>
          <AlertDescription>
            {w.isDefault
              ? `Tarih seçilmedi → varsayılan olarak son ${w.defaultMonths} ay gösteriliyor. Daha eski kayıtlar bu tablolara GİRMİYOR; tümünü görmek için yukarıdan "Tüm zamanlar" seçin.`
              : 'Harcama, fire ve teslim edilen maliyet YALNIZ bu dönemi kapsar; dönem dışı kayıtlar tablolara girmez.'}{' '}
            <strong>Stok Değeri</strong> istisnadır: elde BUGÜN duran stoğun maliyetidir, tarih
            aralığından etkilenmez.
          </AlertDescription>
        </div>
      </Alert>
    ) : null;

  const hasAny =
    data.valuation.length > 0 ||
    data.wastage.length > 0 ||
    data.byMonth.length > 0 ||
    data.bySupplier.length > 0 ||
    data.byProduct.length > 0 ||
    (data.deliveredCogs?.length ?? 0) > 0;

  if (!hasAny) {
    /*
     * BOŞ SONUCUN İKİ FARKLI ANLAMI VAR ve karıştırılırsa operatör "kayıt yok" sanır:
     * (a) sistemde gerçekten maliyet kaydı yok, (b) kayıt var ama SEÇİLİ DÖNEM dışında.
     * Pencere uygulanmışken metin (b) ihtimalini açıkça söyler (bu projenin "boş tabloda
     * 'kayıt yok' ile 'süzgeçle eşleşen yok' ayrılır" kuralı).
     */
    return (
      <div className="space-y-6">
        {windowBanner}
        <EmptyState
          icon={Coins}
          title={w && !w.allTime ? 'Seçili dönemde maliyet kaydı yok' : 'Maliyet verisi yok'}
          description={
            w && !w.allTime
              ? 'Bu tarih aralığında teslim alınmış satın alma emri veya maliyet kaydı bulunmuyor. Aralığı genişletin ya da "Tüm zamanlar" seçin.'
              : 'Henüz teslim alınmış satın alma emri veya maliyet kaydı bulunmuyor.'
          }
        />
      </div>
    );
  }

  const uncoveredUnits = data.valuation.reduce((s, v) => s + v.uncoveredUnits, 0);
  const uncoveredEvents = data.wastage.reduce((s, w) => s + w.uncoveredEvents, 0);

  /*
   * ÖMRÜ DOLMUŞ (atanamaz) stok — para birimi başına AYRI satır.
   *
   * `uncovered` ile TOPLANMAZ: ikisi FARKLI kümedir. "Kapsanamayan" = maliyeti bilinmeyen ama
   * SATILABİLİR kapasite; "ömrü dolmuş" = maliyeti bilinse de SATILAMAZ kapasite. Tek sayıda
   * birleştirmek iki farklı operasyonel eylemi (maliyet gir ↔ zayi yaz) aynı satıra yıkardı.
   * Parasal karşılık da toplanmaz — para birimleri karışır (panel invaryantı).
   */
  const expiredRows = data.valuation
    .map((v) => ({
      currency: v.currency,
      units: v.expiredUnits ?? 0,
      cents: v.expiredCents ?? 0,
    }))
    .filter((r) => r.units > 0);
  const expiredUnitsTotal = expiredRows.reduce((s, r) => s + r.units, 0);

  // Teslim edilen COGS (§12, D17) — para birimi başına ayrı; '' kova = maliyet snapshot'ı
  // olmayan (partiye/PO'ya bağlanamayan) teslimatlar (AYRI uncovered uyarısı).
  const deliveredCogs = data.deliveredCogs ?? [];
  const deliveredUncovered = deliveredCogs.reduce((s, d) => s + d.uncoveredUnits, 0);

  return (
    <div className="space-y-6">
      {windowBanner}

      {multiCurrency && (
        <Alert variant="info">
          <Coins />
          <div>
            <AlertTitle>Karışık para birimi</AlertTitle>
            <AlertDescription>
              Kayıtlar birden fazla para birimi içeriyor ({currencies.join(', ')}). Tutarlar para
              birimi bazında AYRI gösterilir; farklı para birimleri toplanmaz.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Değerleme + Fire (StatTile, para birimi başına). Boş ('') currency kovası maliyeti
          bağlanamayan kayıtları taşır (parasal değeri daima 0); deliveredCogs ile aynı biçimde
          değer kartı olarak ÇİZİLMEZ — bunun yerine aşağıdaki "kapsanamayan" uyarısında raporlanır.
          Boş currency etiketi StatTile'da boş parantez ("()") olarak sızmasın diye elenir. */}
      <div className="grid gap-3 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-4">
        {data.valuation
          .filter((v) => v.currency !== '')
          .map((v) => (
            <StatTile
              key={`val-${v.currency}`}
              label={multiCurrency ? `Stok Değeri (${v.currency})` : 'Stok Değeri (maliyet)'}
              value={money(v.valuedCents, v.currency)}
              icon={Warehouse}
              tone="accent"
              // ANLIK pozisyon — tarih aralığı bu kartı DEĞİŞTİRMEZ (bkz. pencere bandı).
              hint={`${fmtNum(v.valuedUnits)} birim maliyetli · dönemden bağımsız`}
            />
          ))}
        {data.wastage
          .filter((w) => w.currency !== '')
          .map((w) => (
            <StatTile
              key={`waste-${w.currency}`}
              label={multiCurrency ? `Fire / İmha (${w.currency})` : 'Fire / İmha (maliyet)'}
              value={money(w.wastedCents, w.currency)}
              icon={PackageX}
              tone={w.wastedCents > 0 ? 'warning' : 'neutral'}
              hint={`${fmtNum(w.events)} olay`}
            />
          ))}
      </div>

      {/* Teslim edilen COGS (satılan mal maliyeti — para birimi başına ayrı) */}
      {deliveredCogs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Truck className="size-4 text-muted-foreground" /> Teslim Edilen Mal Maliyeti
            </CardTitle>
            {/* KÜME ADI DÜZELTİLDİ: "Aktif + teslim edilmiş" değil — `costs.service` AYAKTA
                atamaları (`STANDING_STATUSES` = active | suspended | expired, teslim tarihi
                dolu olanlar) sayar. Yalnız 'active' saymak askıdaki ve süresi dolmuş
                TESLİMATLARI maliyetten düşürüyordu; metin o eski davranışı anlatıyordu. */}
            <CardDescription>
              Müşteride duran teslimatların satılan mal maliyeti — aktif, askıya alınmış ve süresi
              dolmuş atamalar dahil (import anındaki birim maliyet anlık-görüntüsü üzerinden;
              yalnız maliyet, gelir/kâr içermez).
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {deliveredCogs.some((d) => d.currency !== '') && (
              <div className="grid gap-3 [&>*]:min-w-0 sm:grid-cols-2 lg:grid-cols-4">
                {deliveredCogs
                  .filter((d) => d.currency !== '')
                  .map((d) => (
                    <StatTile
                      key={`cogs-${d.currency}`}
                      label={multiCurrency ? `Teslim Edilen Maliyet (${d.currency})` : 'Teslim Edilen Maliyet'}
                      value={money(d.cogsCents, d.currency)}
                      icon={Truck}
                      tone="accent"
                      hint={`${fmtNum(d.deliveredUnits)} birim teslim edildi`}
                    />
                  ))}
              </div>
            )}
            {deliveredUncovered > 0 && (
              <Alert variant="warning">
                <TriangleAlert />
                <div>
                  <AlertTitle>Maliyeti bağlanamayan teslimat</AlertTitle>
                  <AlertDescription>
                    {fmtNum(deliveredUncovered)} teslim edilmiş birim bir maliyet
                    anlık-görüntüsüne (partiye/PO'ya) bağlı değil; teslim COGS toplamı
                    OLDUĞUNDAN DÜŞÜK görünebilir.
                  </AlertDescription>
                </div>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {/* Maliyeti bağlanamayan uyarısı */}
      {(uncoveredUnits > 0 || uncoveredEvents > 0) && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>Maliyeti bağlanamayan kayıtlar</AlertTitle>
            <AlertDescription>
              {uncoveredUnits > 0 && <>{fmtNum(uncoveredUnits)} birim</>}
              {uncoveredUnits > 0 && uncoveredEvents > 0 && ' ve '}
              {uncoveredEvents > 0 && <>{fmtNum(uncoveredEvents)} fire olayı</>} bir satın alma
              emrine (PO) bağlanamadı. Bu kayıtların birim maliyeti bilinmediğinden yukarıdaki
              toplamlar OLDUĞUNDAN DÜŞÜK görünebilir.
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Ömrü dolmuş (atanamaz) stok — AYRI bant. Yukarıdaki "kapsanamayan" ile birleştirilmez:
          o küme satılabilir ama maliyeti bilinmiyor, bu küme maliyeti bilinse de satılamıyor. */}
      {expiredRows.length > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <div>
            <AlertTitle>
              {fmtNum(expiredUnitsTotal)} birim ömrü dolmuş — atanamaz
            </AlertTitle>
            <AlertDescription>
              <p>
                Stokta duruyor (<code>available</code>) ama stok ömrü geçtiği için teslimatta
                ASLA seçilmez. Bu birimler yukarıdaki “Stok Değeri” kartına DAHİL DEĞİLDİR;
                fiilen zayidir — Kusurlu Stok akışında geçersiz kılınması gerekir.
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {expiredRows.map((r) => (
                  <li key={`expired-${r.currency || 'unknown'}`} className="tabular-nums">
                    {/* Para birimi başına AYRI satır; farklı para birimleri toplanmaz. Boş
                        kod = maliyeti bir PO'ya bağlanamayan kova → parasal karşılığı yok. */}
                    <strong>{fmtNum(r.units)} birim</strong>
                    {r.currency === ''
                      ? ' (maliyeti bağlanamayan)'
                      : ` · ${r.currency} — yaklaşık ${money(r.cents, r.currency)} maliyet`}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </div>
        </Alert>
      )}

      {/* Aylık harcama zaman serisi */}
      {monthGroups.length > 0 && (
        <ChartCard
          title="Aylık Tedarik Harcaması"
          icon={CalendarDays}
          description={
            uncoveredMonthQty > 0
              ? `Ay bazında satın alma emri harcaması (yalnız maliyet). ${uncoveredMonthQty} kalem maliyeti bilinmediği için grafiğe girmiyor — Stok Girişi'nde tedarikçi ve birim maliyet girilirse kapsanır.`
              : 'Ay bazında satın alma emri harcaması (yalnız maliyet).'
          }
          groups={monthGroups}
          multiCurrency={multiCurrency}
        />
      )}

      {/* Tedarikçi + Ürün kırılımı */}
      {supplierGroups.length > 0 && (
        <ChartCard
          title="Tedarikçi Kırılımı"
          icon={Building2}
          description="Tedarikçi bazında toplam harcama (en yüksek 12)."
          groups={supplierGroups}
          multiCurrency={multiCurrency}
        />
      )}

      {productGroups.length > 0 && (
        <ChartCard
          title="Ürün Kırılımı"
          icon={Boxes}
          description="Ürün bazında toplam tedarik maliyeti (en yüksek 12)."
          groups={productGroups}
          multiCurrency={multiCurrency}
        />
      )}

      <p className="text-xs text-muted-foreground">
        Oluşturulma: {fmtDateTime(data.generatedAt)} · Gelir/kâr içermez; yalnız tedarik maliyeti.
      </p>
    </div>
  );
}
