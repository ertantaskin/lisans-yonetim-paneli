'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  ChevronRight,
  FileText,
  Inbox,
  Package,
  PackageX,
  Send,
  Truck,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  createClaimAction,
  fetchClaimCandidatesAction,
} from '../../app/quarantine/claims-actions';
import type { ClaimRow } from '../../app/quarantine/claims-queries';
import type { QuarantineItem } from '../../app/quarantine/queries';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge, ClaimStatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card';
import { Combobox } from '../ui/combobox';
import { EmptyState } from '../ui/page-header';
import { Field } from '../ui/field';
import { HowItWorks } from '../ui/help-note';
import { Input, Textarea } from '../ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import {
  claimStatusHint,
  defectKindLabel,
  itemCount,
  productKindLabel,
} from '../../lib/labels';
import { cn, fmtDateTime } from '../../lib/utils';

/** Tarih ön ayarları — /quarantine sunucu süzgeciyle AYNI dil (7/30/90/özel). */
const RANGE_PRESETS = [
  { value: '', label: 'Tümü' },
  { value: '7', label: 'Son 7 gün' },
  { value: '30', label: 'Son 30 gün' },
  { value: '90', label: 'Son 90 gün' },
  { value: 'custom', label: 'Özel aralık' },
] as const;

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/** Parti satırı açıldığında gösterilecek en fazla kalem (DOM ağırlığı sınırı). */
const BATCH_ROW_CAP = 50;

/** Süreç özeti — ekranın en üstünde, her zaman görünür (kullanıcı: "rehber niteliğinde"). */
export const CLAIM_FLOW_STEPS = [
  {
    title: 'Kusurlu kalem havuza düşer',
    text: 'Müşteri değişimi, parti geri çekme, hasar ya da elle geçersiz kılma sonucu ölen kalemler burada birikir. Bu kalemler müşteriye bir daha teslim edilmez.',
  },
  {
    title: 'Tedarikçiye fiş kesersiniz',
    text: 'Tedarikçi + tarih aralığı seçin; o pencerede biriken tüm kalemler otomatik gelir (istemediğinizi çıkarırsınız). Fişe giren kalem bu listeden düşer — aynı kusuru iki kez bildirmezsiniz.',
  },
  {
    title: 'Yanıtı işlersiniz',
    text: 'Raporu .txt/.csv indirip tedarikçiye KENDİNİZ gönderin (panel göndermez), sonra “Tedarikçiye gönderdim” deyin. Yanıt geldikçe kalemleri işaretleyin; tedarikçi kabul etmezse kalem bu havuza geri döner.',
  },
];

/** Tedarikçi → parti kırılımı (havuzdaki bekleyen kusurlular). */
interface BatchGroup {
  batchId: string | null;
  batchCode: string;
  /** Partinin stok GİRİŞ tarihi (kullanıcı "partinin eklendiği tarih" istedi). */
  oldest: string | null;
  rows: QuarantineItem[];
}
interface SupplierGroup {
  supplierId: string | null;
  supplierName: string;
  total: number;
  /** Gruptaki ürün tipleri — "3 hesap" mı "3 kalem" mi yazılacağını belirler. */
  kinds: Array<string | null | undefined>;
  batches: BatchGroup[];
}

function groupBySupplier(rows: QuarantineItem[]): SupplierGroup[] {
  const map = new Map<string, SupplierGroup>();
  for (const r of rows) {
    const sid = r.supplierId ?? null;
    const key = sid ?? '__none__';
    let g = map.get(key);
    if (!g) {
      g = {
        supplierId: sid,
        supplierName: r.supplierName ?? 'Tedarikçisi bilinmiyor',
        total: 0,
        kinds: [],
        batches: [],
      };
      map.set(key, g);
    }
    g.total += 1;
    g.kinds.push(r.productKind);
    const bkey = r.batchId ?? '__nobatch__';
    let b = g.batches.find((x) => (x.batchId ?? '__nobatch__') === bkey);
    if (!b) {
      b = { batchId: r.batchId ?? null, batchCode: r.batchCode ?? 'Partisiz', oldest: null, rows: [] };
      g.batches.push(b);
    }
    b.rows.push(r);
    const created = r.createdAt ?? null;
    if (created && (!b.oldest || created < b.oldest)) b.oldest = created;
  }
  // Çok kusurlu tedarikçi üstte — operatörün ilk bakacağı yer orası.
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/**
 * BİLDİRİLECEKLER — kusur havuzunun iş görünümü.
 *
 * Hangi tedarikçiye, hangi partiden kaç kalem bildirilecek; tek tıkla fiş. Parti satırı
 * KATLANIR (`<details>`): kalemleri görmek için ayrı bir ekrana gitmek gerekmiyor ama liste
 * varsayılan olarak kısa kalıyor.
 *
 * Gruplama İSTEMCİDE yapılır (satırlar zaten yüklü) — ikinci bir sorgu açmak "havuzda kaç
 * kalem var" sorusuna iki farklı cevap üretirdi (bu projede "satılmış 6 birim" hatasının kaynağı).
 */
export function PendingClaimsPanel({
  rows,
  suppliers,
  lastClaim,
  serverFiltered = false,
}: {
  rows: QuarantineItem[];
  suppliers: Array<{ id: string; name: string }>;
  lastClaim: ClaimRow | null;
  /** "Tüm Kayıtlar" sekmesindeki sunucu süzgeci etkinse bu liste de daralmıştır — söylenir. */
  serverFiltered?: boolean;
}) {
  const [open, setOpen] = React.useState(false);
  const [preset, setPreset] = React.useState<string>('');
  const groups = React.useMemo(() => groupBySupplier(rows), [rows]);

  const openFor = (supplierId: string | null) => {
    if (!supplierId) {
      toast.error(
        'Bu kalemlerin partisi (dolayısıyla tedarikçisi) yok — fiş kesilemez. Stok girişinde tedarikçi ve alım tarihi girerseniz izlenebilir olur.',
      );
      return;
    }
    setPreset(supplierId);
    setOpen(true);
  };

  return (
    <>
      <HowItWorks steps={CLAIM_FLOW_STEPS} />

      {serverFiltered && (
        <Alert variant="warning">
          <AlertDescription>
            “Tüm Kayıtlar” sekmesinde bir sunucu süzgeci etkin — aşağıdaki havuz da yalnız o
            süzgece uyan kalemleri kapsıyor.{' '}
            <Link href="/quarantine" className="font-medium underline underline-offset-4">
              Süzgeci temizle
            </Link>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle icon={Truck}>Tedarikçiye bildirilecekler</CardTitle>
          <CardDescription>
            Henüz hiçbir değişim fişine girmemiş kusurlu kalemler — tedarikçi ve parti kırılımıyla.
            {lastClaim && (
              <>
                {' '}
                Son kesilen fiş:{' '}
                <Link
                  href={`/quarantine/claims/${lastClaim.id}`}
                  className="font-mono text-foreground underline-offset-4 hover:underline"
                >
                  {lastClaim.code}
                </Link>{' '}
                · {fmtDateTime(lastClaim.createdAt)}
              </>
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {groups.length === 0 ? (
            <EmptyState
              icon={Inbox}
              title="Bildirilecek kusurlu kalem yok."
              description="Tedarikçiye bildirilmeyi bekleyen kalem bulunmuyor. Yeni bir kusur oluştuğunda (müşteri değişimi, parti geri çekme, elle geçersiz kılma) burada belirir."
            />
          ) : (
            <ul className="divide-y divide-border">
              {groups.map((g) => (
                <li key={g.supplierId ?? '__none__'} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      {g.supplierId ? (
                        <Link
                          href={`/suppliers/${g.supplierId}`}
                          className="truncate font-medium text-foreground underline-offset-4 hover:underline"
                        >
                          {g.supplierName}
                        </Link>
                      ) : (
                        <span className="truncate font-medium text-muted-foreground">
                          {g.supplierName}
                        </span>
                      )}
                      <Badge variant="warning">{itemCount(g.total, g.kinds)}</Badge>
                    </div>
                    <Button
                      variant={g.supplierId ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => openFor(g.supplierId)}
                    >
                      <Send /> Fiş oluştur
                    </Button>
                  </div>

                  <ul className="mt-2 space-y-1.5 pl-6">
                    {g.batches.map((b) => (
                      <li key={b.batchId ?? '__nobatch__'}>
                        <BatchDisclosure group={b} />
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <CreateClaimSheet
        open={open}
        onOpenChange={setOpen}
        suppliers={suppliers}
        presetSupplierId={preset}
      />
    </>
  );
}

/**
 * Parti satırı: özet + katlanır kalem listesi.
 *
 * `<details>` bilinçli (JS durumu yok): kapalıyken satır tek satır kalır, açıldığında partideki
 * kalemler ürün/tip/değer/sebep ile görünür. Operatör "bu partiden tam olarak neler bozuk"
 * sorusunu ekranı terk etmeden yanıtlar.
 */
function BatchDisclosure({ group }: { group: BatchGroup }) {
  const kinds = group.rows.map((r) => r.productKind);
  // `<details>` kapalıyken de çocukları DOM'a girer → yüzlerce kalemli partide sayfa ağırlaşır.
  // İlk 50 satır gösterilir, kalanı sayıyla belirtilir (tam liste "Tüm Kayıtlar" sekmesinde).
  const shown = group.rows.slice(0, BATCH_ROW_CAP);
  const hidden = group.rows.length - shown.length;
  return (
    <details className="group rounded-md border border-border/70 bg-muted/20">
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-2 gap-y-0.5 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
          aria-hidden
        />
        <Package className="size-3.5 shrink-0" aria-hidden />
        <span className="font-mono text-foreground">{group.batchCode}</span>
        <span className="tabular-nums">{itemCount(group.rows.length, kinds)}</span>
        {group.oldest && <span>· stok girişi {fmtDateTime(group.oldest)}</span>}
        {group.batchId && (
          <Link
            href={`/batches/${group.batchId}`}
            className="ml-auto underline-offset-4 hover:text-foreground hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            Partiyi aç
          </Link>
        )}
      </summary>
      <ul className="divide-y divide-border/60 border-t border-border/60">
        {shown.map((r) => (
          <li key={r.licenseItemId} className="flex flex-wrap gap-x-3 gap-y-0.5 px-2.5 py-1.5 text-xs">
            <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={r.keyPreview ?? ''}>
              {r.keyPreview ?? '—'}
            </span>
            <span className="truncate text-muted-foreground">
              {r.productName ?? '—'}
              {r.productKind ? ` · ${productKindLabel(r.productKind)}` : ''}
            </span>
            {r.defectKind && (
              <span className="text-muted-foreground">{defectKindLabel(r.defectKind)}</span>
            )}
            {r.reason && (
              <span className="max-w-[16rem] truncate text-muted-foreground" title={r.reason}>
                “{r.reason}”
              </span>
            )}
            {/* Karantinaya alınış (kusurun oluştuğu) tarihi — kullanıcı "karantinaya alınış
                tarihi yok" dedi. Stok giriş tarihinden AYRI kavram (o, parti başlığında). */}
            {r.quarantinedAt && (
              <span
                className="ml-auto whitespace-nowrap tabular-nums text-muted-foreground/80"
                title="Karantinaya alınış tarihi"
              >
                karantina: {fmtDateTime(r.quarantinedAt)}
              </span>
            )}
          </li>
        ))}
        {hidden > 0 && (
          <li className="px-2.5 py-1.5 text-xs text-muted-foreground">
            …ve {hidden.toLocaleString('tr-TR')} kalem daha — tamamı “Tüm Kayıtlar” sekmesinde.
          </li>
        )}
      </ul>
    </details>
  );
}

/**
 * FİŞ KESME (Z raporu). Tedarikçi + tarih penceresi seçilir, adaylar OTOMATİK gelir,
 * istenmeyen tek tek çıkarılır. Sunucu adayları kilit altında TAZEDEN okur — bu ekran
 * yalnız önizlemedir ve "excludeLicenseItemIds" ile çıkarılanları bildirir.
 */
function CreateClaimSheet({
  open,
  onOpenChange,
  suppliers,
  presetSupplierId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  suppliers: Array<{ id: string; name: string }>;
  presetSupplierId: string;
}) {
  const router = useRouter();
  const [supplierId, setSupplierId] = React.useState('');
  const [range, setRange] = React.useState<string>('');
  const [from, setFrom] = React.useState('');
  const [to, setTo] = React.useState('');
  const [note, setNote] = React.useState('');
  const [rows, setRows] = React.useState<QuarantineItem[] | null>(null);
  const [excluded, setExcluded] = React.useState<Set<string>>(new Set());
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Panelden gelen tedarikçi ön-seçili açılır; kapanışta durum sıfırlanır (bayat önizleme yok).
  React.useEffect(() => {
    if (!open) return;
    setSupplierId(presetSupplierId);
    setRange('');
    setFrom('');
    setTo('');
    setNote('');
    setRows(null);
    setExcluded(new Set());
    setError(null);
  }, [open, presetSupplierId]);

  const applyPreset = (v: string) => {
    setRange(v);
    if (v === '') {
      setFrom('');
      setTo('');
    } else if (v !== 'custom') {
      // Ön ayar basıldığı ANDA sabit tarihe çevrilir (kayan pencere değil) — /quarantine deseni.
      setFrom(isoDay(new Date(Date.now() - Number(v) * 86_400_000)));
      setTo(isoDay(new Date()));
    }
  };

  const load = React.useCallback(async () => {
    if (!supplierId) return;
    setLoading(true);
    setError(null);
    const res = await fetchClaimCandidatesAction({ supplierId, from, to });
    if (res.ok) {
      setRows(res.rows);
      setExcluded(new Set());
      if (res.truncated) {
        toast.warning('Aday listesi üst sınıra dayandı — tarih aralığını daraltmayı deneyin.');
      }
    } else {
      setError(res.error);
      setRows(null);
    }
    setLoading(false);
  }, [supplierId, from, to]);

  // Tedarikçi/pencere değişince adayları çek.
  React.useEffect(() => {
    if (open && supplierId) void load();
  }, [open, supplierId, from, to, load]);

  const selected = (rows ?? []).filter((r) => !excluded.has(r.licenseItemId));
  const selectedKinds = selected.map((r) => r.productKind);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createClaimAction({
        supplierId,
        from: from || undefined,
        to: to || undefined,
        excludeLicenseItemIds: [...excluded],
        note,
      });
      if (res.ok) {
        toast.success(`${res.code} oluşturuldu — ${itemCount(res.itemCount)} fişe alındı.`);
        onOpenChange(false);
        // Fişi hemen aç: operatörün sıradaki işi indirip göndermek.
        router.push(`/quarantine/claims/${res.id}`);
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Değişim fişi oluştur</SheetTitle>
          <SheetDescription>
            Seçtiğiniz aralıkta biriken, henüz bildirilmemiş kusurlu kalemler otomatik gelir.
            İstemediğinizi listeden çıkarın. Fiş kesildiğinde bu kalemler havuzdan düşer ve
            bir daha aynı fişe girmez.
          </SheetDescription>
        </SheetHeader>

        {/* Diğer Sheet'lerle AYNI gövde deseni: SheetContent overflow-y-auto + gövde p-4 pt-0.
            Eskiden gövde hiç dolgusuz ve kaydırmasızdı → uzun formda kenardan taşıyordu (kullanıcı
            "fiş oluşturma ekranı bozuk" dedi). */}
        <div className="space-y-4 p-4 pt-0">
          <Field label="Tedarikçi" htmlFor="claim-supplier" hint="Fiş tek bir tedarikçiye kesilir.">
            <Combobox
              id="claim-supplier"
              ariaLabel="Tedarikçi"
              items={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              value={supplierId}
              onValueChange={setSupplierId}
              placeholder="Tedarikçi seçin…"
            />
          </Field>

          <Field
            label="Tarih aralığı"
            hint="Kusurun oluştuğu (karantinaya düştüğü) tarihe göre. Gün sonu raporu için “Son 7 gün” yeterlidir."
          >
            <div className="flex flex-wrap items-center gap-1.5">
              {RANGE_PRESETS.map((p) => (
                <Button
                  key={p.value}
                  type="button"
                  size="sm"
                  variant={range === p.value ? 'default' : 'outline'}
                  onClick={() => applyPreset(p.value)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </Field>

          {range === 'custom' && (
            <div className="flex flex-wrap items-end gap-2">
              <Field label="Başlangıç" htmlFor="claim-from">
                <Input
                  id="claim-from"
                  type="date"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </Field>
              <Field label="Bitiş" htmlFor="claim-to">
                <Input
                  id="claim-to"
                  type="date"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </Field>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {supplierId && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium text-foreground">
                  {loading
                    ? 'Adaylar aranıyor…'
                    : `${itemCount(selected.length, selectedKinds)} fişe girecek`}
                  {!loading && excluded.size > 0 && (
                    <span className="ml-1 font-normal text-muted-foreground">
                      ({excluded.size} çıkarıldı)
                    </span>
                  )}
                </p>
                {!loading && (rows?.length ?? 0) > 0 && excluded.size > 0 && (
                  <Button variant="ghost" size="sm" onClick={() => setExcluded(new Set())}>
                    Tümünü geri al
                  </Button>
                )}
              </div>

              {!loading && rows && rows.length === 0 && (
                <Alert variant="muted">
                  <AlertDescription>
                    Bu tedarikçi için seçilen aralıkta bildirilmemiş kusurlu kalem yok.
                  </AlertDescription>
                </Alert>
              )}

              {rows && rows.length > 0 && (
                <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg border border-border">
                  {rows.map((r) => {
                    const out = excluded.has(r.licenseItemId);
                    return (
                      <li
                        key={r.licenseItemId}
                        className={cn(
                          'flex items-center justify-between gap-3 px-3 py-2 text-xs',
                          out && 'opacity-50',
                        )}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-foreground">
                            {r.keyPreview ?? '—'}
                          </div>
                          <div className="truncate text-muted-foreground">
                            {r.productName ?? '—'}
                            {r.productKind ? ` · ${productKindLabel(r.productKind)}` : ''}
                            {r.batchCode ? ` · ${r.batchCode}` : ''}
                            {r.defectKind ? ` · ${defectKindLabel(r.defectKind)}` : ''}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setExcluded((prev) => {
                              const next = new Set(prev);
                              if (next.has(r.licenseItemId)) next.delete(r.licenseItemId);
                              else next.add(r.licenseItemId);
                              return next;
                            })
                          }
                        >
                          {out ? 'Geri al' : 'Çıkar'}
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          <Field label="Not (tedarikçiye iletilecek)" htmlFor="claim-note" hint="İsteğe bağlı.">
            <Textarea
              id="claim-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="ör. 12 Ağustos partisinde toplu aktivasyon hatası"
            />
          </Field>

          <div className="flex justify-end gap-2 border-t border-border pt-3">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Vazgeç
            </Button>
            <Button onClick={() => void submit()} disabled={busy || selected.length === 0}>
              <FileText />{' '}
              {busy ? 'Oluşturuluyor…' : `Fiş oluştur (${itemCount(selected.length, selectedKinds)})`}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Fiş geçmişi — "Değişim Fişleri" sekmesi. */
export function ClaimsList({ rows, error }: { rows: ClaimRow[]; error: string | null }) {
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>Fişler alınamadı: {error}</AlertDescription>
      </Alert>
    );
  }
  if (rows.length === 0) {
    return (
      <EmptyState
        icon={FileText}
        title="Henüz değişim fişi kesilmedi."
        description="“Bildirilecekler” sekmesinden bir tedarikçi seçip fiş oluşturduğunuzda kesilen fişler burada listelenir; her fişin içinde tedarikçinin kalem kalem yanıtını işlersiniz."
      />
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <ul className="divide-y divide-border">
        {rows.map((c) => (
          <li key={c.id}>
            <Link
              href={`/quarantine/claims/${c.id}`}
              className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-accent"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-sm font-medium text-foreground">{c.code}</span>
                  <ClaimStatusBadge status={c.status} />
                  <span className="truncate text-sm text-muted-foreground">
                    {c.supplierName ?? 'Tedarikçi silinmiş'}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <PackageX className="size-3.5" aria-hidden />
                    {itemCount(c.itemCount)}
                  </span>
                  {c.pendingCount > 0 && (
                    <span>{c.pendingCount} kalem tedarikçi yanıtı bekliyor</span>
                  )}
                  {c.replacedCount > 0 && <span>{c.replacedCount} yenisi geldi</span>}
                  {c.creditedCount > 0 && <span>{c.creditedCount} bedeli iade</span>}
                  {c.rejectedCount > 0 && (
                    <span>{c.rejectedCount} kabul edilmedi (havuza döndü)</span>
                  )}
                </div>
                {/* Durumun ANLAMI: operatör "sırada ne var" için fişi açmak zorunda kalmasın. */}
                <p className="text-xs text-muted-foreground/80">
                  {claimStatusHint(c.status)} · Oluşturma {fmtDateTime(c.createdAt)}
                  {c.sentAt ? ` · Tedarikçiye gönderildi ${fmtDateTime(c.sentAt)}` : ''}
                  {c.closedAt ? ` · Kapandı ${fmtDateTime(c.closedAt)}` : ''}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
