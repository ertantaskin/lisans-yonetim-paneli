'use client';
import * as React from 'react';
import Link from 'next/link';
import type { ColumnDef } from '@tanstack/react-table';
import {
  Ban,
  CheckCircle2,
  KeyRound,
  MoreHorizontal,
  Package,
  PackagePlus,
  PackageX,
  Replace,
  ShieldX,
  TriangleAlert,
  X,
} from 'lucide-react';
import { isAutoReceipt } from '@lisans/shared';
import type { BatchRow } from '../app/batches/queries';
import { fmtDateTime, includesTr } from '../lib/utils';
import { itemCount, supplyStatusLabel } from '../lib/labels';
import { bulkReplaceBatchAction, recallBatchAction } from '../app/batches/actions';
import { Badge, SupplyStatusBadge } from './ui/badge';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Label, Textarea } from './ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu';
import { DataTable } from './data-table/data-table';
import { DataTableColumnHeader } from './data-table/data-table-column-header';
import type { FacetConfig } from './data-table/data-table-toolbar';

const baseColumns: ColumnDef<BatchRow>[] = [
  {
    accessorKey: 'label',
    meta: { title: 'Parti' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Parti" />,
    // Etiket artık PARTİ DETAYINA link: satır menüsünü açmadan partinin lisanslarına gitmenin
    // en kısa yolu (tablolarda birincil kolon tıklanabilir olmalı — panel geneli desen).
    cell: ({ row }) => (
      <Link
        href={`/batches/${row.original.id}`}
        className="font-medium text-foreground underline-offset-4 hover:underline"
      >
        {row.original.label}
      </Link>
    ),
    // Arama: parti etiketi VEYA ürün sku/adı. Türkçe-duyarlı (`includesTr`) — ham
    // `toLowerCase()` ile "İşletim Sistemi" / "IŞIK-2024" gibi kayıtlar SESSİZCE bulunamıyordu
    // (diğer tablolarda düzeltilmişti, bu tablo atlanmıştı).
    filterFn: (row, _id, value) =>
      includesTr(row.original.label, value) ||
      includesTr(row.original.productSku, value) ||
      includesTr(row.original.productName, value),
  },
  {
    accessorKey: 'supplierName',
    meta: { title: 'Tedarikçi' },
    header: 'Tedarikçi',
    cell: ({ row }) => (
      <span className="text-muted-foreground">{row.original.supplierName ?? '—'}</span>
    ),
  },
  {
    id: 'product',
    accessorFn: (row) => `${row.productSku} ${row.productName}`,
    meta: { title: 'Ürün' },
    header: 'Ürün',
    // Ürün adı ürün detayına bağlanır: geri çekme/telafi kararında "bu üründe kaç sağlam
    // anahtar kaldı" sorusu tek tıkla yanıtlanır (eskiden düz metindi → kopyala-ara).
    cell: ({ row }) => (
      <div className="flex flex-col">
        <Link
          href={`/products/${row.original.productId}`}
          className="text-foreground underline-offset-4 hover:underline"
        >
          {row.original.productName}
        </Link>
        <span className="text-xs tabular-nums text-muted-foreground">{row.original.productSku}</span>
      </div>
    ),
  },
  {
    accessorKey: 'status',
    meta: { title: 'Durum' },
    header: 'Durum',
    cell: ({ row }) => (
      <span className="flex flex-wrap items-center gap-1.5">
        <SupplyStatusBadge status={row.original.status} />
        {/*
          OTOMATİK PARTİ (§12): bu partiyi operatör elle açmadı — Stok Girişi ekranı, girilen
          anahtarlara maliyet/tedarikçi izi tutmak için türetti (aynı adımda teslim alınmış bir
          satın alma emri de açılır). İşaret serbest-metin `notes` önekindedir; ham `[oto-giris]`
          metni EKRANA BASILMAZ, yalnız bu rozete çevrilir (purchase-orders-table ile aynı desen).
        */}
        {isAutoReceipt(row.original.notes) && (
          <Badge
            variant="outline"
            title="Stok girişinden otomatik oluşturuldu — mal girişle birlikte teslim alındı."
          >
            Otomatik
          </Badge>
        )}
      </span>
    ),
    filterFn: (row, id, value: string[]) => value.includes(row.getValue(id)),
  },
  {
    accessorKey: 'unsoldCount',
    meta: { title: 'Stokta' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Stokta" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.unsoldCount}</span>,
  },
  {
    accessorKey: 'customerCount',
    meta: { title: 'Müşterilerde' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Müşterilerde" />,
    cell: ({ row }) => <span className="tabular-nums">{row.original.customerCount}</span>,
  },
  {
    accessorKey: 'deadCount',
    meta: { title: 'Düşmüş' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Düşmüş" />,
    cell: ({ row }) => (
      <span
        className="tabular-nums text-muted-foreground"
        title="Geçersiz kılınmış, karantinaya alınmış, iade edilmiş, değiştirilmiş ya da süresi geçmiş kalemler."
      >
        {row.original.deadCount}
      </span>
    ),
  },
  {
    accessorKey: 'receivedAt',
    meta: { title: 'Teslim Alındı' },
    header: ({ column }) => <DataTableColumnHeader column={column} title="Teslim Alındı" />,
    cell: ({ row }) => (
      <span className="tabular-nums text-muted-foreground">
        {fmtDateTime(row.original.receivedAt)}
      </span>
    ),
    sortingFn: 'datetime',
  },
];

/** Yalnız aktif parti geri çekilebilir. */
function isRecallable(status: string) {
  return status === 'active';
}

/**
 * Toplu değiştirme YALNIZ geri çekilmiş partide ve GERÇEKTEN aday varsa sunulur (§13).
 * `replaceableCount` = aktif atamalı kalem = API'deki `bulkReplaceBatch` aday kümesi.
 * Eskiden `soldCount` (= status<>'available') bakılıyordu: elle geçersiz kılınmış bir
 * partide değiştirilecek hiçbir şey yokken menüde "Toplu Değiştir" çıkıyor, tıklanınca
 * "0/0 değiştirildi" dönüyordu.
 */
function canBulkReplace(batch: BatchRow) {
  return batch.status === 'recalled' && batch.replaceableCount > 0;
}

/** Yalnız aktif partiye yeni stok girilebilir (geri çekilmiş/iptal partiye ekleme anlamsız). */
function canAddStock(batch: BatchRow) {
  return batch.status === 'active';
}

/**
 * Parti satır aksiyonları — Bu partiye stok gir (aktif) · Geri Çek (aktif) VEYA
 * Toplu Değiştir (geri çekilmiş + satılmış). Recall/toplu-değiştirme aksiyonları değişmedi;
 * stok girişi kendi ekranındadır → ürün + parti ön-seçili gelen Stok Girişi ekranına
 * (/stock/import?product=…&batch=…) bağlanan ayrı bir menü kalemi.
 */
function BatchRowActions({
  batch,
  onRecall,
  onBulkReplace,
}: {
  batch: BatchRow;
  onRecall: (batch: BatchRow) => void;
  onBulkReplace: (batch: BatchRow) => void;
}) {
  const recallable = isRecallable(batch.status);
  const bulkReplaceable = canBulkReplace(batch);
  const addStockable = canAddStock(batch);
  // "Lisansları gör" HER partide vardır (geri çekilmiş partide de ürüne dönmek gerekir) →
  // menü artık asla boş kalmaz.
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          title="Aksiyonlar"
          aria-label={`${batch.label} aksiyonları`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Ürünün lisans envanterine derin bağlantı — geri çekme kararı öncesi "hangi
            anahtarlar, kime gitti" bakılabilsin (envanter tablosu parti süzgecini API'de
            destekliyor; ekran süzgeci ayrı bir iş olarak açık kaldı). */}
        {/* Parti detayı: partinin KENDİ lisansları (teslim edilen/geçersiz dahil) + toplu
            işlemler. Eskiden yalnız ÜRÜNÜN envanterine gidiliyordu ve orada "hangi anahtar bu
            partiden" sorusunun cevabı yoktu (kullanıcı geri bildirimi). */}
        <DropdownMenuItem asChild>
          <Link href={`/batches/${batch.id}`}>
            <KeyRound />
            Parti detayı ve lisansları
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link href={`/products/${batch.productId}#lisans-envanteri`}>
            <Package />
            Ürünün tüm envanteri
          </Link>
        </DropdownMenuItem>
        {addStockable && (
          <DropdownMenuItem asChild>
            <Link href={`/stock/import?product=${batch.productId}&batch=${batch.id}`}>
              <PackagePlus />
              Bu partiye stok gir
            </Link>
          </DropdownMenuItem>
        )}
        {(addStockable || recallable || bulkReplaceable) && <DropdownMenuSeparator />}
        {recallable && (
          <DropdownMenuItem
            onSelect={() => onRecall(batch)}
            className="text-destructive focus:text-destructive"
          >
            <PackageX />
            Geri Çek (Recall)
          </DropdownMenuItem>
        )}
        {bulkReplaceable && (
          <DropdownMenuItem onSelect={() => onBulkReplace(batch)}>
            <Replace />
            Toplu Değiştir (satılanları)
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Recall başarı bildirimi (bir kez). */
type RecallNotice = {
  label: string;
  /** Sonuç bandındaki "parti detayından tek tek karar ver" bağlantısı için. */
  batchId: string;
  /** Partinin ürün tipi — sonuç metni "anahtar/hesap/kod" der (nötr "kalem" yerine). */
  kind?: string;
  voided: number;
  soldNeedingReplacement: number;
};

/**
 * Sebep-girişli recall modalı — kanonik `ui/dialog.tsx` primitifi üzerinde.
 *
 * Eskiden elle kurulmuş bir overlay'di: örtü `bg-background/70` (kanonik `bg-black/50`'nin AÇIK
 * temada tersi — beyaz perde), gölge `shadow-lg` (kanonik `shadow-xl`) ve Escape dışında odak
 * tuzağı / scroll kilidi / portal yoktu. Radix Dialog bunların hepsini getirir.
 */
function RecallDialog({
  batch,
  onClose,
  onDone,
  onError,
}: {
  batch: BatchRow;
  onClose: () => void;
  onDone: (notice: RecallNotice) => void;
  onError: (message: string) => void;
}) {
  const [reason, setReason] = React.useState('');
  const [localError, setLocalError] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (!reason.trim()) {
      setLocalError('Sebep zorunlu');
      return;
    }
    setLocalError(null);
    startTransition(async () => {
      const res = await recallBatchAction(batch.id, reason);
      if (res.ok) {
        onDone({
          label: batch.label,
          batchId: batch.id,
          kind: batch.productKind,
          voided: res.voided ?? 0,
          soldNeedingReplacement: res.soldNeedingReplacement ?? 0,
        });
      } else {
        onError(res.error ?? 'Geri çekilemedi');
        onClose();
      }
    });
  };

  return (
    // Ebeveyn yalnız hedef seçiliyken mount ediyor → `open` sabit; kapanış tek yoldan (onClose).
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className="max-w-md"
        // Odak sebep alanında başlasın (eski davranış: mount effect'i ile focus).
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          textareaRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>Partiyi geri çek</DialogTitle>
          <DialogDescription>
            {batch.label} · {batch.productName}
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-1 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <Alert variant="warning">
            <TriangleAlert />
            <div className="min-w-0 flex-1">
              <AlertDescription>
                Stoktaki {itemCount(batch.unsoldCount, batch.productKind)} geçersiz kılınacak (geri
                alınamaz).
                {batch.customerCount > 0 && (
                  <>
                    {' '}
                    Müşterilerdeki {itemCount(batch.customerCount, batch.productKind)}{' '}
                    <strong>korunur</strong> — çalışmaya devam eder; hangisini değiştireceğinize tek
                    tek karar verirsiniz.
                  </>
                )}{' '}
                {/* Geri alınamaz karar öncesi etkilenecek kalemlere bakma yolu (yeni sekme —
                    modaldaki sebep metni kaybolmasın). */}
                <Link
                  href={`/batches/${batch.id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  Bu partinin lisanslarını incele
                </Link>
              </AlertDescription>
            </div>
          </Alert>

          <div className="space-y-1.5">
            <Label htmlFor="recall-reason">Geri çekme sebebi (audit'e kaydedilir)</Label>
            <Textarea
              id="recall-reason"
              ref={textareaRef}
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ör: tedarikçi hatalı key partisi bildirdi…"
            />
            {localError && <p className="text-xs text-destructive">{localError}</p>}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant="danger" onClick={submit} disabled={pending}>
            <PackageX /> {pending ? 'İşleniyor…' : 'Geri Çek'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Toplu değiştirme sonucu bildirimi. */
type BulkReplaceNotice = {
  label: string;
  /** Partinin ürün tipi — sonuç metni "anahtar/hesap/kod" der (nötr "kalem" yerine). */
  kind?: string;
  total: number;
  replaced: number;
  skippedNoStock: number;
  /**
   * ALTYAPI ARIZASI nedeniyle işlenemeyen kalem (deadlock / statement_timeout / havuz tükenmesi).
   * "Stok yok"tan AYRI tutulur: eskiden ikisi tek sayaçta toplanıyordu ve ekran altyapı arızasını
   * *"… için uygun stok yoktu"* diye yazıyordu — stok DOLUYKEN. Operatör o mesaja bakıp stok
   * girmeye çalışır, sorun tekrar eder ve gerçek sebep hiçbir yerde görünmezdi.
   */
  failed: number;
};

/**
 * Toplu değiştirme onay modalı (§13). Sebep girişi yok — onay + sonuç. Satılmış kalemler
 * MEVCUT değişim makinesiyle yenisiyle değiştirilir; stok bitince atlanır.
 */
function BulkReplaceDialog({
  batch,
  onClose,
  onDone,
  onError,
}: {
  batch: BatchRow;
  onClose: () => void;
  onDone: (notice: BulkReplaceNotice) => void;
  onError: (message: string) => void;
}) {
  const [pending, startTransition] = React.useTransition();

  const submit = () => {
    startTransition(async () => {
      const res = await bulkReplaceBatchAction(batch.id);
      if (res.ok) {
        onDone({
          label: batch.label,
          kind: batch.productKind,
          total: res.total ?? 0,
          replaced: res.replaced ?? 0,
          skippedNoStock: res.skippedNoStock ?? 0,
          // `?? 0` — alan API'ye eklemeli geldi; admin ve api ayrı imajlar olduğu ve biri önce
          // dağıtılabildiği için eski API yanıtında bu alan bulunmayabilir (dağıtım sapması).
          failed: res.failed ?? 0,
        });
      } else {
        onError(res.error ?? 'Toplu değiştirme başarısız');
        onClose();
      }
    });
  };

  return (
    // Kanonik Dialog (elle kurulan overlay yerine): aynı örtü/gölge dili + odak tuzağı,
    // Escape, scroll kilidi ve portal — iki modal artık aynı görünüyor.
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Satılanları toplu değiştir</DialogTitle>
          <DialogDescription>
            {batch.label} · {batch.productName}
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-1 min-h-0 flex-1 overflow-y-auto pr-1">
          <Alert variant="warning">
            <TriangleAlert />
            <div className="min-w-0 flex-1">
              <AlertDescription>
                Müşterilerdeki {itemCount(batch.replaceableCount, batch.productKind)} geri alınıp
                yerine BAŞKA bir partiden tazesi atanacak. Stok yetmeyen kalemler atlanır (mevcut
                kalem korunur — müşteri boşta kalmaz).
                {batch.customerCount > batch.replaceableCount && (
                  <>
                    {' '}
                    Askıya alınmış{' '}
                    {itemCount(batch.customerCount - batch.replaceableCount, batch.productKind)} bu
                    işleme DAHİL DEĞİL — askıyı bilerek siz koydunuz, elle işleyin.
                  </>
                )}{' '}
                Tek tek karar vermek isterseniz{' '}
                <Link href={`/batches/${batch.id}`} className="underline underline-offset-4">
                  parti detayındaki listeyi
                </Link>{' '}
                kullanın.
              </AlertDescription>
            </div>
          </Alert>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Vazgeç
          </Button>
          <Button variant="default" onClick={submit} disabled={pending}>
            <Replace /> {pending ? 'İşleniyor…' : 'Toplu Değiştir'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const facets: FacetConfig[] = [
  {
    columnId: 'status',
    title: 'Durum',
    // Süzgeç etiketi ile kolon rozeti YAPISAL olarak aynı sözlükten gelir (elle yazılmaz).
    options: [
      { label: supplyStatusLabel('active'), value: 'active', icon: CheckCircle2 },
      { label: supplyStatusLabel('recalled'), value: 'recalled', icon: ShieldX },
      { label: supplyStatusLabel('voided'), value: 'voided', icon: Ban },
    ],
  },
];

export function BatchesTable({ batches }: { batches: BatchRow[] }) {
  const [recallTarget, setRecallTarget] = React.useState<BatchRow | null>(null);
  const [bulkTarget, setBulkTarget] = React.useState<BatchRow | null>(null);
  const [notice, setNotice] = React.useState<RecallNotice | null>(null);
  const [bulkNotice, setBulkNotice] = React.useState<BulkReplaceNotice | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const handleDone = React.useCallback((n: RecallNotice) => {
    setError(null);
    setBulkNotice(null);
    setNotice(n);
    setRecallTarget(null);
  }, []);
  const handleBulkDone = React.useCallback((n: BulkReplaceNotice) => {
    setError(null);
    setNotice(null);
    setBulkNotice(n);
    setBulkTarget(null);
  }, []);
  const handleError = React.useCallback((message: string) => {
    setNotice(null);
    setBulkNotice(null);
    setError(message);
  }, []);

  const columns = React.useMemo<ColumnDef<BatchRow>[]>(
    () => [
      ...baseColumns,
      {
        id: 'actions',
        header: () => <span className="sr-only">Aksiyonlar</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <BatchRowActions
              batch={row.original}
              onRecall={setRecallTarget}
              onBulkReplace={setBulkTarget}
            />
          </div>
        ),
        enableSorting: false,
        enableHiding: false,
      },
    ],
    [],
  );

  return (
    <div className="space-y-4">
      {notice && (
        <Alert variant={notice.soldNeedingReplacement > 0 ? 'warning' : 'success'}>
          {notice.soldNeedingReplacement > 0 ? <TriangleAlert /> : <CheckCircle2 />}
          <div className="min-w-0 flex-1">
            <AlertTitle>Parti geri çekildi — {notice.label}</AlertTitle>
            <AlertDescription>
              Stoktaki {itemCount(notice.voided, notice.kind)} geçersiz kılındı.
              {notice.soldNeedingReplacement > 0 && (
                <>
                  {' '}
                  Müşterilerdeki {itemCount(notice.soldNeedingReplacement, notice.kind)} çalışmaya
                  devam ediyor — hangisini değiştireceğinize{' '}
                  <Link
                    href={`/batches/${notice.batchId}`}
                    className="underline underline-offset-4"
                  >
                    parti detayından
                  </Link>{' '}
                  tek tek karar verin.
                </>
              )}
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setNotice(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
      {bulkNotice && (
        <Alert
          variant={
            // Altyapı arızası "stok yok"tan DAHA ciddidir: stok yok beklenen bir ticari sonuçtur,
            // arıza ise tekrar denenmesi gereken bir hatadır → tonu o belirler.
            bulkNotice.failed > 0
              ? 'destructive'
              : bulkNotice.skippedNoStock > 0
                ? 'warning'
                : 'success'
          }
        >
          {bulkNotice.failed > 0 || bulkNotice.skippedNoStock > 0 ? (
            <TriangleAlert />
          ) : (
            <CheckCircle2 />
          )}
          <div className="min-w-0 flex-1">
            <AlertTitle>Toplu değiştirme tamamlandı — {bulkNotice.label}</AlertTitle>
            <AlertDescription>
              Müşterilerdeki {itemCount(bulkNotice.total, bulkNotice.kind)} işlendi;{' '}
              {bulkNotice.replaced} tanesi yenisiyle değiştirildi.
              {bulkNotice.skippedNoStock > 0 && (
                <>
                  {' '}
                  {itemCount(bulkNotice.skippedNoStock, bulkNotice.kind)} için uygun stok yoktu —
                  eskisi KORUNDU (müşteri boşta kalmadı), stok girince tekrar deneyin.
                </>
              )}
              {bulkNotice.failed > 0 && (
                <>
                  {' '}
                  <strong>
                    {itemCount(bulkNotice.failed, bulkNotice.kind)} bir sistem hatası yüzünden
                    işlenemedi
                  </strong>{' '}
                  (stokla ilgili değil — eskisi KORUNDU). Kısa süre sonra tekrar deneyin; sürerse
                  sunucu günlüklerine bakın.
                </>
              )}
            </AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setBulkNotice(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>İşlem tamamlanamadı</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setError(null)}
            aria-label="Kapat"
            className="-mr-1 -mt-1 shrink-0"
          >
            <X />
          </Button>
        </Alert>
      )}

      <DataTable
        columns={columns}
        data={batches}
        searchColumnId="label"
        searchPlaceholder="Parti etiketi veya ürün…"
        facets={facets}
        initialSorting={[{ id: 'receivedAt', desc: true }]}
        emptyLabel="Henüz parti yok. Parti, Stok Girişi'nde tedarikçi + alım tarihi girdiğinizde ya da bir satın alma emrini teslim aldığınızda oluşur."
      />

      {recallTarget && (
        <RecallDialog
          batch={recallTarget}
          onClose={() => setRecallTarget(null)}
          onDone={handleDone}
          onError={handleError}
        />
      )}

      {bulkTarget && (
        <BulkReplaceDialog
          batch={bulkTarget}
          onClose={() => setBulkTarget(null)}
          onDone={handleBulkDone}
          onError={handleError}
        />
      )}
    </div>
  );
}
