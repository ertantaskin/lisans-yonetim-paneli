'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronRight, FileText, Package, Send, Truck } from 'lucide-react';
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
import { Input, Textarea } from '../ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { defectKindLabel } from '../../lib/labels';
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

/** Tedarikçi → parti kırılımı (havuzdaki bekleyen kusurlular). */
interface SupplierGroup {
  supplierId: string | null;
  supplierName: string;
  total: number;
  batches: Array<{ batchId: string | null; batchCode: string; count: number; oldest: string | null }>;
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
        batches: [],
      };
      map.set(key, g);
    }
    g.total += 1;
    const bkey = r.batchId ?? '__nobatch__';
    let b = g.batches.find((x) => (x.batchId ?? '__nobatch__') === bkey);
    if (!b) {
      b = { batchId: r.batchId ?? null, batchCode: r.batchCode ?? 'Partisiz', count: 0, oldest: null };
      g.batches.push(b);
    }
    b.count += 1;
    // Partinin STOK GİRİŞ tarihi (kullanıcı "partinin eklendiği tarih" istedi).
    const created = r.createdAt ?? null;
    if (created && (!b.oldest || created < b.oldest)) b.oldest = created;
  }
  // Çok kusurlu tedarikçi üstte — operatörün ilk bakacağı yer orası.
  return [...map.values()].sort((a, b) => b.total - a.total);
}

/**
 * KUSURLU ANAHTARLAR — "Bekleyenler" sekmesinin üst paneli.
 *
 * Aşağıdaki tablo (mevcut `QuarantineTable`) ham listeyi ve dışa aktarmayı taşır; bu panel
 * kullanıcının istediği İŞ GÖRÜNÜMÜNÜ verir: hangi tedarikçiye hangi partiden kaç anahtar
 * bildirilecek, ve tek tıkla fiş kesme. Gruplama İSTEMCİDE yapılır (satırlar zaten yüklü) —
 * ikinci bir sorgu açmak "havuzda kaç kalem var" sorusuna iki farklı cevap üretirdi.
 */
export function PendingClaimsPanel({
  rows,
  suppliers,
  lastClaim,
}: {
  rows: QuarantineItem[];
  suppliers: Array<{ id: string; name: string }>;
  lastClaim: ClaimRow | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [preset, setPreset] = React.useState<string>('');
  const groups = React.useMemo(() => groupBySupplier(rows), [rows]);

  const openFor = (supplierId: string | null) => {
    if (!supplierId) {
      toast.error(
        'Bu anahtarların partisi (dolayısıyla tedarikçisi) yok — fiş kesilemez. Stok girişinde tedarikçi/parti girerseniz izlenebilir olur.',
      );
      return;
    }
    setPreset(supplierId);
    setOpen(true);
  };

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle icon={Truck}>Tedarikçiye bildirilecekler</CardTitle>
          <CardDescription>
            Henüz hiçbir değişim fişine girmemiş kusurlu anahtarlar — tedarikçi ve parti
            kırılımıyla. Bir fiş kestiğinizde bu anahtarlar listeden düşer; tedarikçi bir
            kalemi <strong>reddederse</strong> otomatik olarak buraya geri döner.
            {lastClaim && (
              <>
                {' '}
                Son fiş:{' '}
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
              icon={FileText}
              title="Bildirilecek kusurlu anahtar yok."
              description="Yüklenen listede tedarikçiye bildirilmeyi bekleyen kalem bulunmuyor. (Süzgeçleri daralttıysanız genişletmeyi deneyin.)"
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
                      <Badge variant="warning">{g.total} anahtar</Badge>
                    </div>
                    <Button
                      variant={g.supplierId ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => openFor(g.supplierId)}
                    >
                      <Send /> Fiş oluştur
                    </Button>
                  </div>
                  <ul className="mt-2 space-y-1 pl-6">
                    {g.batches.map((b) => (
                      <li
                        key={b.batchId ?? '__nobatch__'}
                        className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
                      >
                        <Package className="size-3.5" aria-hidden />
                        {b.batchId ? (
                          <Link
                            href={`/batches/${b.batchId}`}
                            className="font-mono text-foreground underline-offset-4 hover:underline"
                          >
                            {b.batchCode}
                          </Link>
                        ) : (
                          <span className="font-mono">{b.batchCode}</span>
                        )}
                        <span className="tabular-nums">{b.count} anahtar</span>
                        {b.oldest && <span>· stok girişi {fmtDateTime(b.oldest)}</span>}
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
    if (v === '' ) {
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
        toast.success(`${res.code} oluşturuldu — ${res.itemCount} anahtar fişe alındı.`);
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
      <SheetContent className="w-full sm:max-w-2xl">
        <SheetHeader>
          <SheetTitle>Değişim fişi oluştur</SheetTitle>
          <SheetDescription>
            Seçtiğiniz aralıkta biriken, henüz bildirilmemiş kusurlu anahtarlar otomatik gelir.
            İstemediğinizi listeden çıkarın. Fiş kesildiğinde bu anahtarlar havuzdan düşer ve
            bir daha aynı fişe girmez.
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4">
          <Field label="Tedarikçi" hint="Fiş tek bir tedarikçiye kesilir.">
            <Combobox
              items={suppliers.map((s) => ({ value: s.id, label: s.name }))}
              value={supplierId}
              onValueChange={setSupplierId}
              placeholder="Tedarikçi seçin…"
            />
          </Field>

          <Field
            label="Tarih aralığı"
            hint="Kusurun oluştuğu (karantinaya düştüğü) tarihe göre. Gün sonu raporu için 'Son 7 gün' yeterlidir."
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
              <Field label="Başlangıç">
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </Field>
              <Field label="Bitiş">
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
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
                    : `${selected.length} anahtar fişe girecek`}
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
                    Bu tedarikçi için seçilen aralıkta bildirilmemiş kusurlu anahtar yok.
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

          <Field label="Not (tedarikçiye iletilecek)" hint="İsteğe bağlı.">
            <Textarea
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
              <FileText /> {busy ? 'Oluşturuluyor…' : `Fiş oluştur (${selected.length})`}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Fiş geçmişi — "Fişler" sekmesi. */
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
        description="“Bekleyenler” sekmesinden bir tedarikçi seçip fiş oluşturduğunuzda burada listelenir."
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
                  <span className="tabular-nums">{c.itemCount} anahtar</span>
                  {c.replacedCount > 0 && <span>{c.replacedCount} yenilendi</span>}
                  {c.rejectedCount > 0 && <span>{c.rejectedCount} reddedildi</span>}
                  {c.pendingCount > 0 && <span>{c.pendingCount} cevap bekliyor</span>}
                  <span>· {fmtDateTime(c.createdAt)}</span>
                  {c.sentAt && <span>· gönderildi {fmtDateTime(c.sentAt)}</span>}
                  {c.closedAt && <span>· kapandı {fmtDateTime(c.closedAt)}</span>}
                </div>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

