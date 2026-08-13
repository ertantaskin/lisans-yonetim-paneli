import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  ArrowLeft,
  ShoppingCart,
  KeyRound,
  Mail,
  History,
  RefreshCw,
  LifeBuoy,
  Archive,
  ShieldAlert,
  Store,
  PackageCheck,
  ExternalLink,
  Gift,
  UserRound,
} from 'lucide-react';
import { apiGet, ApiError, type OrderDetail } from '../../../lib/api';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { StatusBadge, Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { EmptyState } from '../../../components/ui/page-header';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../../components/ui/table';
import { AssignmentLicenseCell } from '../../../components/assignment-license-cell';
import {
  assignmentStatusLabel,
  auditActionLabel,
  eventTypeLabel,
  pendingReasonAction,
  pendingReasonLabel,
  siteTypeLabel,
} from '../../../lib/labels';
import { CompleteLineButton, AssignmentActions, ResendButton } from './order-actions';
import { OrderReplacements } from './order-replacements';
import {
  LineDiagnosisStrip,
  OrderResolveBanner,
  type LineDiagnosis,
  type OrderDiagnosis,
} from './line-diagnosis';

/**
 * Sipariş detayı — backend `detail()` yanıtının GENİŞLETİLMİŞ alanları.
 *
 * `lib/api.ts` merkezî sözlüğe (paralel işçi) ait olduğu için burada kesişim (intersection)
 * tipiyle genişletilir: alanlar opsiyonel tanımlanır → lib/api.ts sonradan aynı alanları
 * zorunlu ilan ederse kesişim daralır ve tip yine tutarlı kalır (çakışma olmaz).
 */
type Line = OrderDetail['lines'][number] & {
  /** MAĞAZADAKİ ürün bilgisi (kullanıcı isteği): push'ta gelen ham kimlik + ad. */
  remoteProductId?: string | null;
  remoteVariationId?: string | null;
  remoteName?: string | null;
  isBonus?: boolean;
  originRemoteLineId?: string | null;
  availableStock?: number | null;
  /** Satırın neden beklediği (detail() tanısı) — tanı ucu erişilemezse yedek kaynak. */
  pendingReason?: string | null;
  productSku?: string | null;
  productKind?: string | null;
};

type Assignment = OrderDetail['assignments'][number] & {
  isBonus?: boolean;
  remoteName?: string | null;
  remoteLineId?: string | null;
  replaced?: boolean;
  replaceReason?: string | null;
};

type HistoryRow = OrderDetail['history'][number] & {
  isBonus?: boolean;
  remoteName?: string | null;
  productName?: string | null;
};

type AuditRow = {
  id: string;
  action: string;
  actor: string;
  targetType: string | null;
  targetId: string | null;
  op: string | null;
  reason: string | null;
  createdAt: string;
};

type Detail = Omit<
  OrderDetail,
  'order' | 'lines' | 'assignments' | 'history' | 'auditTrail'
> & {
  order: OrderDetail['order'] & {
    /** Mağaza yönetim panelinde siparişi açan link (SALT LİNK — panel mağazaya bağlanmaz). */
    storeAdminUrl?: string | null;
  };
  lines: Line[];
  assignments: Assignment[];
  history: HistoryRow[];
  /** "Kim yaptı" denetim izi (§8) — zaman çizelgesine karışır. */
  auditTrail?: AuditRow[];
};

/** ISO tarihi tr-TR biçimler; süresi geçmişse amber vurgu bilgisi döner. */
function fmtValidUntil(iso: string | null): { text: string; expired: boolean } {
  if (!iso) return { text: '', expired: false };
  const d = new Date(iso);
  return {
    text: d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' }),
    expired: d.getTime() < Date.now(),
  };
}

const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });

/** Zaman çizelgesi etiketleri — TEK KAYNAK `lib/labels.ts` (ham enum operatöre çıkmaz). */
const eventTitle = (t: string) => eventTypeLabel(t);

const auditTitle = (a: AuditRow) =>
  a.op === 'pending_resolve'
    ? 'Ürün eşlemesi geriye dönük uygulandı'
    : auditActionLabel(a.action);

/**
 * Tek aktif lisans satırı — kompakt: anahtar + yanında Göster, sağda ikon aksiyonlar.
 *
 * `siblingActiveCount`: AYNI sipariş kalemindeki DİĞER canlı (aktif|askıda) atama sayısı —
 * iptal onay metni buna göre dallanır (kardeş varsa satır terminal yapılmaz). Bu sayfa
 * atamaları zaten satır bazında grupluyor; ekstra istek yok.
 */
function LicenseRow({
  a,
  orderId,
  siblingActiveCount,
}: {
  a: Assignment;
  orderId: string;
  siblingActiveCount: number;
}) {
  const vu = fmtValidUntil(a.validUntil);
  const isMulti = a.maxUses > 1;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <AssignmentLicenseCell kind={a.kind} payload={a.payload} fields={a.fields} />
      </div>
      <StatusBadge status={a.status} />
      {isMulti && (
        <span className="text-xs tabular-nums text-muted-foreground">
          {a.useCount}/{a.maxUses} kullanım
        </span>
      )}
      {vu.text && (
        <span className={`text-xs ${vu.expired ? 'text-warning' : 'text-muted-foreground'}`}>
          {vu.text}
          {vu.expired ? ' (doldu)' : ''}
        </span>
      )}
      <div className="ml-auto">
        <AssignmentActions
          assignmentId={a.id}
          orderId={orderId}
          status={a.status}
          siblingActiveCount={siblingActiveCount}
        />
      </div>
    </div>
  );
}

export const dynamic = 'force-dynamic';

export default async function OrderDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  // Detay + "neden bekliyor" tanısı PARALEL. Tanı OPSİYONEL katmandır: uç hata verirse
  // (eski API imajı, geçici hata) sayfa eski davranışıyla tam çalışmaya devam eder.
  const [detailRes, diagRes] = await Promise.allSettled([
    apiGet<Detail>(`/v1/admin/orders/${id}`),
    apiGet<OrderDiagnosis>(`/v1/admin/pending-lines/diagnose/${id}`),
  ]);

  let data: Detail | null = null;
  let error: string | null = null;
  if (detailRes.status === 'fulfilled') {
    data = detailRes.value;
  } else {
    const e = detailRes.reason;
    if (e instanceof ApiError && e.status === 404) notFound();
    error = e instanceof Error ? e.message : 'Bağlantı hatası';
  }
  const diagnosis: OrderDiagnosis | null = diagRes.status === 'fulfilled' ? diagRes.value : null;

  if (error || !data) {
    return (
      <div className="space-y-4">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/orders">
            <ArrowLeft /> Siparişler
          </Link>
        </Button>
        <Card className="p-6">
          <p className="text-sm text-destructive">Sipariş yüklenemedi: {error}</p>
        </Card>
      </div>
    );
  }

  const { order, lines, assignments, events, emails, history, replacements } = data;
  const auditTrail = data.auditTrail ?? [];

  const diagByLine = new Map<string, LineDiagnosis>(
    (diagnosis?.lines ?? []).map((l) => [l.lineId, l] as const),
  );

  // Atamaları satır (ürün kalemi) bazında grupla → ürün-merkezli tek görünüm (Satırlar + Aktif
  // Lisanslar birleşti; kullanıcı "ikisi çakışıyor, karışık" dedi). Aktif/askıda ürün kartında;
  // iptal/değiştirilen/expired olanlar en altta katlanır "Geçmiş" bölümünde (karmaşa yaratmasın).
  const asgByLine = new Map<string, Assignment[]>();
  for (const a of assignments) {
    const arr = asgByLine.get(a.lineId);
    if (arr) arr.push(a);
    else asgByLine.set(a.lineId, [a]);
  }
  const isActive = (a: Assignment) => a.status === 'active' || a.status === 'suspended';
  const terminalAsg = assignments.filter((a) => !isActive(a));
  // Bonus (sentetik) satırlar en sona; asıl ürün kalemleri önce.
  const isBonusLine = (l: Line) => l.isBonus ?? l.remoteLineId.startsWith('bonus:');
  const sortedLines = [...lines].sort((x, y) => Number(isBonusLine(x)) - Number(isBonusLine(y)));

  // Çok ürün kalemli siparişte kartları ayırt edilebilir kılmak için ürün kalemi başına ince bir
  // sol kenar aksan rengi (chart paleti — monokrom UI'da nötr kalır; kullanıcı isteği). Yalnız
  // birden çok GERÇEK ürün kalemi (bonus hariç) varsa uygulanır; tek üründe gereksiz.
  const CARD_ACCENTS = [
    'var(--chart-1)',
    'var(--chart-2)',
    'var(--chart-3)',
    'var(--chart-4)',
    'var(--chart-5)',
  ];
  const productLineCount = sortedLines.filter((l) => !isBonusLine(l)).length;
  const lineAccent = new Map<string, string | null>();
  {
    let pIdx = 0;
    for (const l of sortedLines) {
      lineAccent.set(
        l.id,
        productLineCount > 1 && !isBonusLine(l)
          ? CARD_ACCENTS[pIdx++ % CARD_ACCENTS.length]
          : null,
      );
    }
  }

  const openReplacements = replacements.filter(
    (r) => r.status === 'open' || r.status === 'info_requested',
  ).length;
  // Destek kartında "ilgili lisans" satırı için okunabilir özet (sır göstermez: key tipinde
  // yalnız son 4 hane; hesap tipinde hiç değer yok).
  const licenseLabels: Record<string, string> = {};
  for (const a of assignments) {
    const tail = a.kind === 'key' && a.payload ? ` · …${a.payload.slice(-4)}` : '';
    licenseLabels[a.id] =
      `${a.productName ?? 'Lisans'}${tail} — ${assignmentStatusLabel(a.status)}`;
  }

  const totalQty = lines.reduce((s, l) => s + l.qty, 0);
  const totalFulfilled = lines.reduce((s, l) => s + l.fulfilledQty, 0);
  const activeCount = assignments.filter(isActive).length;
  const fullyDelivered = totalFulfilled >= totalQty && totalQty > 0;
  const createdAt = fmtDateTime(order.createdAt);

  // Zaman çizelgesi: teslimat olayları + "kim yaptı" denetim izi TEK kronolojik akışta
  // (kullanıcı isteği: "lisans değişimi/eklemesi yapan kullanıcının bilgisi tutulmalı").
  const timeline = [
    ...events.map((e) => ({
      key: `e:${e.id}`,
      at: e.createdAt,
      title: eventTitle(e.type),
      detail: e.message,
      actor: null as string | null,
    })),
    ...auditTrail.map((a) => ({
      key: `a:${a.id}`,
      at: a.createdAt,
      title: auditTitle(a),
      detail: a.reason,
      actor: a.actor || null,
    })),
  ].sort((x, y) => new Date(x.at).getTime() - new Date(y.at).getTime());

  return (
    <div className="space-y-4">
      {/* ── Başlık: mağaza sipariş no (h1) + belirgin Site & kanal-farkında çipler ── */}
      <div className="space-y-2.5">
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link href="/orders">
            <ArrowLeft /> Siparişler
          </Link>
        </Button>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span
              className="hidden size-10 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-xs sm:flex"
              aria-hidden
            >
              <ShoppingCart className="size-5" />
            </span>
            <div className="space-y-1.5">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                Sipariş #{order.remoteOrderId}
              </h1>
              {/* Site + kanal-farkında mağaza sipariş no belirgin çipler (platform-bağımsız:
                  siteType woocommerce/marketplace/reseller → etiket; null → "Mağaza"). */}
              <div className="flex flex-wrap items-center gap-2">
                {order.siteDomain && (
                  <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground">
                    <Store className="size-3.5 text-muted-foreground" />
                    {order.siteDomain}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-foreground">
                  <ShoppingCart className="size-3.5 text-muted-foreground" />
                  {order.siteType ? siteTypeLabel(order.siteType) : 'Mağaza'} #{order.remoteOrderId}
                </span>
                {/* Mağaza panelinde aç — YALNIZ site ayarlarında şablon tanımlıysa. Şablon yoksa
                    panel adres TAHMİN ETMEZ (yanlış link yerine link yok); ama düğmenin neden
                    olmadığı da sessiz kalmasın diye tek satırlık sessiz ipucu + doğru ekran. */}
                {order.storeAdminUrl ? (
                  <a
                    href={order.storeAdminUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    Mağaza panelinde aç
                  </a>
                ) : (
                  order.siteId && (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                      <ExternalLink className="size-3.5" aria-hidden />
                      Mağaza bağlantısı tanımlı değil —{' '}
                      <Link
                        href={`/sites/${order.siteId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        site ayarlarından şablonu girin
                      </Link>
                    </span>
                  )
                )}
                <span className="text-xs text-muted-foreground">
                  {order.customerEmail} · {createdAt}
                </span>
              </div>
            </div>
          </div>
          <StatusBadge status={order.status} className="mt-1" />
        </div>

        {/* Tek satırlık ince özet şeridi.
            NEDEN elle sınıf: üç öğe de StatStripItem şekline oturmuyor (1. öğede ton YALNIZ
            ikonu boyar, 3. öğe etiketsiz bir <Link>) — primitife taşımak render'ı değiştirirdi.
            Bu yüzden yalnız YÜZEY sınıfları `ui/stat-tile.tsx` StatStrip ile birebir hizalandı
            (rounded-xl + py-2.5 + shadow-xs); eskiden rounded-lg/py-2 ve gölgesizdi, yani
            aynı sayfadaki Card'ların yanında farklı bir kart yüzeyi çiziyordu. */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-border bg-card px-4 py-2.5 text-sm shadow-xs">
          <span className="inline-flex items-center gap-1.5">
            <PackageCheck className={`size-4 ${fullyDelivered ? 'text-success' : 'text-warning'}`} />
            <span className="text-muted-foreground">Teslim</span>
            <strong className="tabular-nums text-foreground">
              {totalFulfilled}/{totalQty}
            </strong>
            <span className="text-xs text-muted-foreground">
              {fullyDelivered ? 'tamamlandı' : 'kısmi/bekliyor'}
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <KeyRound className="size-4 text-muted-foreground" />
            <strong className="tabular-nums text-foreground">{activeCount}</strong>
            <span className="text-muted-foreground">aktif lisans</span>
            {terminalAsg.length > 0 && (
              <span className="text-xs text-muted-foreground">· {terminalAsg.length} geçmiş</span>
            )}
          </span>
          {openReplacements > 0 && (
            <Link
              href="#destek"
              className="inline-flex items-center gap-1.5 text-warning hover:underline"
            >
              <LifeBuoy className="size-4" />
              <strong>{openReplacements}</strong> yanıt bekleyen destek talebi
            </Link>
          )}
        </div>
      </div>

      {/* İnceleme (held) uyarısı — teslimat neden durdu + doğru ekran. */}
      {order.heldForReview && (
        <div className="flex items-start gap-2.5 rounded-lg border border-warning/50 bg-warning/10 px-4 py-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warning" />
          <div className="text-foreground">
            Bu sipariş <strong>güvenlik incelemesinde</strong> — teslimat manuel onay bekliyor.{' '}
            <Link
              href="/review"
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              İnceleme Kuyruğu
            </Link>
            'ndan onaylayın veya reddedin. (Onaya kadar teslimat yapılmaz.)
          </div>
        </div>
      )}

      {/* Eşleme sonradan yapılmış ama satırlar eşleme öncesinden kalmış → tek tıkla çöz. */}
      {diagnosis && (
        <OrderResolveBanner orderId={order.id} count={diagnosis.resolvableCount} />
      )}

      {/* ── İki kolon: sol (geniş) ürünler+lisanslar; sağ (dar) destek + referans ── */}
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-3">
        {/* SOL (geniş) — ana çalışma alanı */}
        {/* `min-w-0` ŞART: grid çocuğunun varsayılan `min-width:auto` değeri, otomatik
            minimumunu İÇERİĞİNİN min-content genişliği yapar. Ölçüldü (375px): ızgara 343px
            iken bu sütun 380px'e taşıyor, sayfa `overflow-x-clip` emniyeti yüzünden KAYMIYOR
            → taşan 21px sessizce KIRPILIYOR ve lisans satırındaki "İptal" düğmesine mobilde
            erişilemiyordu. (SidebarInset'te aynı hata bir seviye yukarıda düzeltilmişti.) */}
        <div className="min-w-0 space-y-4 lg:col-span-2">
          <section className="space-y-3">
            <div className="flex items-center gap-2 px-0.5">
              <KeyRound className="size-4 text-muted-foreground" />
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                Ürünler ve Lisanslar
              </h2>
            </div>

            {sortedLines.map((l) => {
              const lineAsg = asgByLine.get(l.id) ?? [];
              const activeLine = lineAsg.filter(isActive);
              const bonus = isBonusLine(l);
              const accent = lineAccent.get(l.id);
              const diag = diagByLine.get(l.id) ?? null;
              // "Kalanları Ata" yalnız gerçekten eksik + işlenebilir satırda (held/canceled/bonus hariç).
              const incomplete =
                l.status !== 'fulfilled' && !l.canceled && !order.heldForReview && !bonus;

              // MAĞAZADAKİ ürün (kullanıcı isteği): ad yoksa ham kimliğe düş; varyasyon ekle.
              const storeName = l.remoteName?.trim() || null;
              const storeRef = storeName ?? (l.remoteProductId ? `#${l.remoteProductId}` : null);
              const variation = l.remoteVariationId ? ` · varyasyon ${l.remoteVariationId}` : '';
              // Panel ürünü eşlenmemişse ANA başlık mağaza adı olur (operatör neyin eksik
              // olduğunu ilk bakışta görsün); eşliyse panel ürün adı ana başlıktır.
              const mainTitle = l.productId
                ? (l.productName ?? '—')
                : (storeRef ?? 'Ürün eşlenmemiş');

              return (
                <Card
                  key={l.id}
                  className="overflow-hidden"
                  style={accent ? { borderLeftWidth: '4px', borderLeftColor: accent } : undefined}
                >
                  {/* Ürün başlığı: panel adı + MAĞAZADAKİ ad + teslim durumu + Kalanları Ata */}
                  <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2 border-b border-border bg-muted/40 px-4 py-2.5">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="max-w-full truncate font-semibold text-foreground"
                          title={mainTitle}
                        >
                          {mainTitle}
                        </span>
                        {bonus && (
                          <Badge variant="accent">
                            <Gift aria-hidden /> Bonus
                          </Badge>
                        )}
                        {!l.productId && !bonus && (
                          <Badge variant="danger">
                            <ShieldAlert aria-hidden /> Eşlenmemiş
                          </Badge>
                        )}
                      </div>

                      {/* Mağazadan (WooCommerce/pazar yeri) gelen ürün bilgisi. */}
                      {l.productId && storeRef && (
                        <p
                          className="max-w-full truncate text-xs text-muted-foreground"
                          title={`${storeRef}${variation}`}
                        >
                          <Store className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                          Mağazadaki ad:{' '}
                          <span className="text-foreground/80">{storeRef}</span>
                          {variation}
                        </p>
                      )}
                      {!l.productId && l.remoteProductId && storeName && (
                        <p className="max-w-full truncate text-xs text-muted-foreground">
                          <Store className="mr-1 inline size-3 align-[-2px]" aria-hidden />
                          Mağaza ürün kimliği: #{l.remoteProductId}
                          {variation}
                        </p>
                      )}

                      <p className="text-xs text-muted-foreground">
                        {bonus
                          ? 'Bonus lisans (ek teslimat — mağazada karşılığı yok)'
                          : `kalem #${l.remoteLineId} · ${l.qty} adet`}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm tabular-nums text-muted-foreground">
                        <strong className="text-foreground">
                          {l.fulfilledQty}/{l.qty}
                        </strong>{' '}
                        teslim
                      </span>
                      {/* İptal edilen satır: TON KURALI gereği neutral (kapanmış kayıt, eylem
                          yok) — kırmızı "ölü/hatalı" demektir ve aynı durum panelin geri
                          kalanında zaten gri "İptal" görünüyordu. Etiket de elle yazılmıyor:
                          StatusBadge → labels.ts (TEK KAYNAK) + Ban ikonu. */}
                      {l.canceled ? (
                        <StatusBadge status="canceled" />
                      ) : (
                        <StatusBadge status={l.status} />
                      )}
                      {incomplete && <CompleteLineButton lineId={l.id} orderId={order.id} />}
                    </div>
                  </div>

                  {/* "Neden bekliyor" tanı şeridi — sebep + ne yapmalı + tek tık aksiyon. */}
                  <LineDiagnosisStrip
                    diagnosis={diag}
                    orderId={order.id}
                    siteId={diagnosis?.siteId ?? order.siteId}
                    fallbackTitle={
                      !diag && l.pendingReason ? pendingReasonLabel(l.pendingReason) : null
                    }
                    fallbackMessage={
                      !diag && l.pendingReason ? pendingReasonAction(l.pendingReason) : null
                    }
                  />

                  {/* Bu ürünün aktif anahtarları */}
                  <div>
                    {activeLine.length === 0 ? (
                      <p className="px-4 py-3 text-sm text-muted-foreground">
                        {lineAsg.length > 0
                          ? 'Aktif lisans yok — kalemler iptal/değiştirilmiş (aşağıdaki geçmişe bakın).'
                          : l.canceled
                            ? 'İade/iptal edildi.'
                            : 'Henüz lisans atanmadı.'}
                      </p>
                    ) : (
                      activeLine.map((a) => (
                        <LicenseRow
                          key={a.id}
                          a={a}
                          orderId={order.id}
                          // "Diğer" canlı kalem sayısı: kendisi hariç (iptal onayı metni buna dallanır).
                          siblingActiveCount={activeLine.length - 1}
                        />
                      ))
                    )}
                  </div>
                </Card>
              );
            })}
          </section>

          {/* Geçmiş / iptal edilen lisanslar — katlanır, sönük.
              shadow-xs: kart yüzeyi sözleşmesi (Card ile aynı dizi) — eksikti, bu blok
              yanındaki Card'ların arasında gölgesiz duruyordu. */}
          {terminalAsg.length > 0 && (
            <details className="group rounded-xl border border-border bg-card shadow-xs">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground">
                <Archive className="size-4" />
                Geçmiş / iptal edilen lisanslar ({terminalAsg.length})
                <span className="ml-auto text-xs text-muted-foreground group-open:hidden">
                  göster
                </span>
                <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">
                  gizle
                </span>
              </summary>
              <div className="border-t border-border">
                {terminalAsg.map((a) => (
                  <div
                    key={a.id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-4 py-2 opacity-90 first:border-t-0"
                  >
                    <span className="text-sm text-foreground">{a.productName ?? '—'}</span>
                    {a.isBonus && (
                      <Badge variant="accent">
                        <Gift aria-hidden /> Bonus
                      </Badge>
                    )}
                    <code className="max-w-full break-all rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground">
                      {a.kind === 'account'
                        ? (a.fields?.map((f) => `${f.label}: ${f.value}`).join(' / ') ?? '—')
                        : a.payload || '—'}
                    </code>
                    <StatusBadge status={a.status} />
                    {a.revokeReason && (
                      <span className="ml-auto text-xs text-muted-foreground">
                        Sebep: <span className="text-foreground/80">{a.revokeReason}</span>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </details>
          )}

          {/* Değişim geçmişi (eski anahtarlar) — katlanır referans; KİM yaptı görünür.
              shadow-xs: yukarıdaki katlanır blokla ve Card sözleşmesiyle aynı yüzey. */}
          {history.length > 0 && (
            <details className="group rounded-xl border border-border bg-card shadow-xs">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-medium text-muted-foreground">
                <RefreshCw className="size-4" />
                Değişim geçmişi — değiştirilen kalemler ({history.length})
                <span className="ml-auto text-xs text-muted-foreground group-open:hidden">
                  göster
                </span>
                <span className="ml-auto hidden text-xs text-muted-foreground group-open:inline">
                  gizle
                </span>
              </summary>
              <div className="overflow-x-auto border-t border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Ürün</TableHead>
                      <TableHead>Eski key</TableHead>
                      <TableHead>Sebep</TableHead>
                      <TableHead>İşlemi yapan</TableHead>
                      <TableHead className="text-right">Tarih</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {history.map((h) => (
                      <TableRow key={h.id}>
                        <TableCell className="text-sm text-foreground">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate" title={h.productName ?? undefined}>
                              {h.productName ?? '—'}
                            </span>
                            {h.isBonus && (
                              <Badge variant="accent">
                                <Gift aria-hidden /> Bonus
                              </Badge>
                            )}
                          </div>
                          {h.remoteName && (
                            <div
                              className="truncate text-xs text-muted-foreground"
                              title={h.remoteName}
                            >
                              Mağazadaki ad: {h.remoteName}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-foreground">
                          {/* key-tipi ölü anahtar TAM (karantina, satışa dönmez); account maskeli. */}
                          {h.oldValue ?? h.oldMasked}
                        </TableCell>
                        <TableCell className="text-sm text-foreground">{h.reason}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          <span className="inline-flex items-center gap-1">
                            <UserRound className="size-3" aria-hidden />
                            {h.actor || '—'}
                          </span>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums text-muted-foreground">
                          {fmtDateTime(h.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          )}
        </div>

        {/* SAĞ (dar) rail — destek + teslimat mailleri + zaman çizelgesi.
            `min-w-0` burada da ŞART: mobilde ızgara TEK kolona düşer ve iki çocuk AYNI rayı
            paylaşır → rayın taban genişliği çocukların minimum katkılarının EN BÜYÜĞÜdür.
            Yalnız sol sütuna vermek yetmedi (ölçüldü: sağ rayın min-content'i 380px olduğu için
            ray 380px kalıyor, 343px'lik kaba taşıyor ve sayfa `overflow-x-clip` yüzünden
            kaymadığından taşan kısım SESSİZCE kırpılıyordu — "İptal" düğmesi erişilemiyordu). */}
        <div className="min-w-0 space-y-4">
          {replacements.length > 0 && (
            <Card
              id="destek"
              className={openReplacements > 0 ? 'scroll-mt-4 border-warning/50' : 'scroll-mt-4'}
            >
              {/* flex-wrap: sağdaki buton whitespace-nowrap taşıdığı için daralamaz; sarma
                  izni olmadan satırın min-content'i başlık+buton toplamı olur ve dar sağ
                  rayda kartı taşırırdı. Sarınca buton başlığın altına iner, metin kesilmez. */}
              <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 gap-y-1 space-y-0 pb-3">
                <CardTitle icon={LifeBuoy} className="text-sm">
                  Destek Talepleri
                  {/* Badge primitifi: elle yazılan pill'de zorunlu saç teli halka (ring-inset)
                      ve doğru tint yüzdesi yoktu. `ml-2` DÜŞTÜ — CardTitle ikonluyken zaten
                      `flex items-center gap-2` uyguluyor, margin üstüne ikinci bir 8px binerdi. */}
                  {openReplacements > 0 && (
                    <Badge variant="warning">{openReplacements} yanıt bekliyor</Badge>
                  )}
                </CardTitle>
                <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  <Link href="/support">Tümü</Link>
                </Button>
              </CardHeader>
              <CardContent className="p-0">
                <OrderReplacements
                  replacements={replacements}
                  orderId={order.id}
                  customerEmail={order.customerEmail}
                  licenseLabels={licenseLabels}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            {/* flex-wrap: "Maili Yeniden Gönder" butonu whitespace-nowrap ile ~165px'in altına
                inmiyor ve sarmalayıcısı (items-end) daralmıyordu → dar sağ rayda kart taşıyordu.
                Sarınca satırın min-content'i en geniş çocuk kadar olur, metin kesilmez. */}
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 gap-y-1 space-y-0 pb-3">
              <CardTitle icon={Mail} className="text-sm">
                Teslimat Mailleri
              </CardTitle>
              <ResendButton orderId={order.id} />
            </CardHeader>
            <CardContent>
              {emails.length === 0 ? (
                <EmptyState
                  icon={Mail}
                  title="Mail yok"
                  description="Teslimat mailleri burada görünür."
                />
              ) : (
                <ul className="space-y-2.5 text-sm">
                  {emails.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-foreground">{m.subject}</span>
                      <StatusBadge status={m.status} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle icon={History} className="text-sm">
                Zaman Çizelgesi
              </CardTitle>
            </CardHeader>
            <CardContent>
              {timeline.length === 0 ? (
                <EmptyState
                  icon={History}
                  title="Kayıt yok"
                  description="Sipariş olayları burada listelenir."
                />
              ) : (
                <ol className="relative max-h-96 space-y-4 overflow-y-auto border-l border-border pl-5">
                  {timeline.map((t) => (
                    <li key={t.key} className="relative">
                      <span className="absolute -left-[1.6rem] top-1 size-2.5 rounded-full border-2 border-background bg-primary" />
                      <div className="text-sm font-medium text-foreground">{t.title}</div>
                      {t.detail && <div className="text-sm text-muted-foreground">{t.detail}</div>}
                      {t.actor && (
                        <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                          <UserRound className="size-3" aria-hidden />
                          İşlemi yapan: <span className="text-foreground/80">{t.actor}</span>
                        </div>
                      )}
                      <div className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                        {fmtDateTime(t.at)}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
