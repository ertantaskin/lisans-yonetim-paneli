'use client';
import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Banknote,
  Boxes,
  Braces,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Eraser,
  ExternalLink,
  Eye,
  FileUp,
  Info,
  KeyRound,
  Lock,
  Package,
  RotateCcw,
  Table2,
  TriangleAlert,
  Truck,
  Upload,
} from 'lucide-react';
import {
  fetchProductBatchesAction,
  importStockAction,
  previewStockAction,
  type ImportState,
  type PreviewState,
  type ProductBatchOption,
} from '../actions';
import type { ProductRow } from '../../../lib/api';
import { SEGMENTED_LIST, segmentedItem } from '../../../lib/segmented';
import { toast } from 'sonner';
import { useAnnouncer } from '../../../components/a11y/announcer';
import { useConfirm } from '../../../components/ui/confirm';
import { Alert, AlertDescription, AlertTitle } from '../../../components/ui/alert';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../../components/ui/card';
import { Combobox } from '../../../components/ui/combobox';
import { Field, FieldRow } from '../../../components/ui/field';
import { Input, Textarea, checkboxClass, selectClass } from '../../../components/ui/input';
import { Separator } from '../../../components/ui/separator';
import {
  licenseItemStatusLabel,
  productKindLabel,
  supplyStatusLabel,
  usageModeLabel,
} from '../../../lib/labels';
import { cn, formatDate } from '../../../lib/utils';
import { AccountRowsEditor, emptyAccountRow, type AccountColumn } from './account-rows-editor';
import {
  MAX_IMPORT_BYTES,
  MAX_IMPORT_ITEMS,
  MAX_IMPORT_LABEL,
  MAX_USES_CAP,
  MAX_USES_MIN,
  formatBytes,
} from './limits';
import {
  autoBatchLabel,
  cleanHiddenChars,
  currencySymbol,
  delimiterLabel,
  formatMoney,
  hasHiddenChars,
  liraToCents,
  parseKeyCapacityRows,
  parseMaxUses,
  splitLines,
  type ImportItemInput,
} from './parse';

const importInitial: ImportState = { ok: false };
const previewInitial: PreviewState = { ok: false };

/** Parti modu — üçü karşılıklı dışlayıcı (API `batchId` ile `newBatch`'i birlikte kabul etmez). */
type BatchMode = 'none' | 'new' | 'existing';

/** Anahtar girdisi kaynağı (key/code/custom ürünler). */
type KeySource = 'paste' | 'file';

/**
 * Tedarikçi seçeneği — `/v1/admin/suppliers` satırının bu ekranda kullanılan alt kümesi.
 * Tip `app/purchase-orders/queries.ts`'ten IMPORT EDİLMEZ: o modül `server-only` taşır ve
 * istemci bileşenine sızmamalıdır (tip elenirdi ama bağı hiç kurmamak daha güvenli).
 */
export interface SupplierPick {
  id: string;
  name: string;
  active: boolean;
}

/** Hesap girdisi kaynağı (account ürünler). */
type AccountSource = 'table' | 'json';

const CURRENCIES = ['TRY', 'USD', 'EUR', 'GBP'] as const;

/** ISO gününü <input type="date"> biçimine çevirir (yerel gün — UTC kaymasız). */
function todayInputValue(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** UTF-8 bayt uzunluğu (gövde sınırı bayt üzerinden uygulanır, karakter değil). */
function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Parti modları — sıra segment kontrolündeki soldan sağa sıradır. */
const BATCH_MODES: ReadonlyArray<{ value: BatchMode; title: string; desc: string }> = [
  {
    value: 'none',
    title: 'Partisiz',
    desc: 'Yalnız anahtarlar girilir — maliyet/tedarikçi izi tutulmaz.',
  },
  {
    value: 'new',
    // KOŞUL EKLENDİ: satın alma emri YALNIZ tedarikçi çözülebilirse açılır (`stock.service`
    // auto-PO dalı) ve bu modda tedarikçi OPSİYONELDİR → tedarikçisiz girişte parti açılır,
    // PO açılmaz. Aynı ekrandaki bilgi kutusu bunu zaten doğru söylüyordu; segment açıklaması
    // koşulsuz vaat ediyordu (iki metin çelişiyordu).
    title: 'Yeni parti',
    desc: 'Bu girişle birlikte teslim alınmış bir parti açılır (tedarikçi seçerseniz satın alma emri de).',
  },
  {
    value: 'existing',
    title: 'Mevcut parti',
    desc: 'Bu ürünün daha önce açılmış bir partisine eklenir.',
  },
];

/**
 * Parti modu seçici — üç seçenek YAN YANA tek satırda (eski hâli üç adet iki satırlı
 * açıklamalı kutuydu ve asıl alanları ekranın çok altına itiyordu).
 *
 * `radio-group` primitifi yok → WAI-ARIA radiogroup deseni elle kurulur: gruba TEK sekme
 * durağı (roving tabindex) + ok tuşlarıyla gezinme/seçim. Seçim FORM ALANI DEĞİLDİR —
 * değer üstteki `<input type="hidden" name="batchMode">` ile gider (buton `type="button"`,
 * yanlışlıkla submit etmez).
 */
function BatchModeSegment({
  value,
  onChange,
}: {
  value: BatchMode;
  onChange: (next: BatchMode) => void;
}) {
  const refs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const index = Math.max(
    BATCH_MODES.findIndex((m) => m.value === value),
    0,
  );

  const goTo = (next: number) => {
    const i = (next + BATCH_MODES.length) % BATCH_MODES.length;
    onChange(BATCH_MODES[i].value);
    refs.current[i]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Parti bağlama modu"
      className={cn(SEGMENTED_LIST, "flex w-full max-w-lg")}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          e.preventDefault();
          goTo(index + 1);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          e.preventDefault();
          goTo(index - 1);
        } else if (e.key === 'Home') {
          e.preventDefault();
          goTo(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          goTo(BATCH_MODES.length - 1);
        }
      }}
    >
      {BATCH_MODES.map((m, i) => {
        const active = m.value === value;
        return (
          <button
            key={m.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(m.value)}
            className={cn(
              // Görünüm TEK KAYNAK lib/segmented.ts (odak halkası EKLENMEZ — globals.css outline).
              // Eskiden burada rounded-[0.3rem] + text-xs vardı; aynı işi yapan sekme/segment
              // çubuklarından farklı görünüyordu.
              segmentedItem(active),
              'flex-1 justify-center',
            )}
          >
            {m.title}
          </button>
        );
      })}
    </div>
  );
}

/** Sayıyı Türkçe binlik ayracıyla yazar (12.500). */
function tr(n: number): string {
  return n.toLocaleString('tr-TR');
}

/**
 * "Mükerrer atlandı"nın NEDENİNİ cümleye çevirir — TEK KAYNAK.
 *
 * NEDEN VAR (operatör bildirdi): yanlış girilen bir anahtar "Sil" ile iptal edildiğinde kayıt
 * SİLİNMEZ (izlenebilirlik için `voided` olur) ama mükerrer engeli tablo genelinde ve statüye
 * bakmaz → doğrusunu girmek isteyen operatöre panel yalnız "1 mükerrer atlandı" diyordu.
 * Sayı doğruydu, ANLAM eksikti: çakışmanın KENDİ iptal ettiği kayıtla olduğunu ve çıkış
 * yolunun ne olduğunu hiçbir yerde söylemiyordu.
 *
 * TEK YARDIMCI ŞART: kuru çalıştırma ile gerçek giriş metni AYRIŞIRSA operatör onay
 * modalinde bir şey görüp sonuçta başkasını görür (bu kod tabanında yaşanmış bir sınıf).
 */
function duplicateReason(d?: {
  inRequest: number;
  existingByStatus: Record<string, number>;
  otherProduct: number;
}): string {
  if (!d) return '';
  const parts: string[] = [];
  const voided = d.existingByStatus.voided ?? 0;
  if (voided > 0) {
    parts.push(
      `${voided} tanesi GEÇERSİZ KILINMIŞ bir kayıtla çakıştı — o kaydı envanterde bulup ` +
        '“Kalıcı sil” derseniz aynı anahtarı tekrar girebilirsiniz',
    );
  }
  // Teslim edilmiş/karantinadaki kayıtlar için DÜRÜST dil: bu anahtar geri gelemez.
  const delivered = Object.entries(d.existingByStatus)
    .filter(([s]) => s !== 'voided')
    .reduce((sum, [, n]) => sum + n, 0);
  if (delivered > 0) {
    parts.push(
      `${delivered} tanesi sistemde zaten kayıtlı (${Object.entries(d.existingByStatus)
        .filter(([s]) => s !== 'voided')
        .map(([s, n]) => `${n} ${licenseItemStatusLabel(s).toLocaleLowerCase('tr-TR')}`)
        .join(', ')}) — bu anahtarlar tekrar girilemez`,
    );
  }
  if (d.otherProduct > 0) {
    parts.push(`${d.otherProduct} tanesi BAŞKA bir ürünün envanterinde kayıtlı`);
  }
  if (d.inRequest > 0) {
    parts.push(`${d.inRequest} satır aynı gönderim içinde tekrarlandı`);
  }
  return parts.length > 0 ? ` Mükerrerin ${parts.join('; ')}.` : '';
}

/**
 * Girdi sayacı — girdi alanının HEMEN ALTINDA duran canlı şerit.
 *
 * NEDEN: yapıştırma ekranında hiçbir yerde "kaç satır girdim / sınır ne" yazmıyordu.
 * Sağ raydaki özet uzun listede ekranın dışında kalıyor, operatör 500 satır yapıştırıp
 * gerçekte kaç kaydın gideceğini (boş satır/mükerrer düşülünce) göremiyordu. Sınır da
 * yalnız AŞILDIĞINDA görünüyordu — önceden bilinmiyordu.
 *
 * MAK/çok kullanımlık üründe **anahtar ≠ lisans**: 3 anahtar × 500 kullanım = 1.500
 * kullanım hakkı. İki sayı ayrı gösterilir, yoksa "3 girdim ama 1.500 talebi kapattı"
 * sürprizi yaşanır.
 *
 * KAPASİTE ARTIK SATIR BAZINDA OLABİLİR: toplam `satır × sabit kapasite` DEĞİL, satır
 * kapasitelerinin TOPLAMIDIR. Karışık kapasitede tek bir çarpan yazmak (ör. "5×") yalan
 * olurdu — bu durumda çarpan yerine "karışık" yazılır.
 */
function EntryMeter({
  items,
  blankLines,
  duplicates,
  bytes,
  capacityUnits,
  uniformCapacity,
  mixedCapacity,
  invalidCapacityLines,
  unitNoun,
}: {
  items: number;
  blankLines: number;
  duplicates: number;
  bytes: number;
  /** Bu girişin stoğa ekleyeceği TOPLAM kullanım hakkı; `null` = kapasite okunamıyor. */
  capacityUnits: number | null;
  /** Tüm satırlar aynı kapasitedeyse o değer, değilse `null`. */
  uniformCapacity: number | null;
  /** Satırlar farklı kapasiteler taşıyor mu. */
  mixedCapacity: boolean;
  /** 2. sütundaki kullanım hakkı okunamayan satır sayısı (girişten ÖNCE görünür). */
  invalidCapacityLines: number;
  /** "kayıt" için ürün tipine göre ad ("anahtar" / "hesap"). */
  unitNoun: string;
}) {
  const overItems = items > MAX_IMPORT_ITEMS;
  const overBytes = bytes > MAX_IMPORT_BYTES;
  // %90'dan sonra uyar: sınırı AŞTIKTAN sonra haber vermek, 9.000 satırı yapıştırmış
  // operatöre çok geç kalır (bloklayıcı zaten var; bu erken uyarıdır).
  const nearItems = !overItems && items > MAX_IMPORT_ITEMS * 0.9;
  const nearBytes = !overBytes && bytes > MAX_IMPORT_BYTES * 0.9;

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-md border border-border bg-muted/40 px-3 py-2 text-xs"
      // Sayı her tuşta değişiyor: `polite` duyurucu her vuruşta konuşurdu.
      aria-live="off"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-sm font-semibold tabular-nums text-foreground">
          {tr(items)} {unitNoun}
        </span>
        {/* Toplam kullanım hakkı yalnız ANLAMLI olduğunda yazılır: tek kullanımlık üründe
            toplam = kayıt sayısıdır ve aynı sayıyı iki kez göstermek gürültüdür. */}
        {items > 0 && capacityUnits != null && capacityUnits !== items && (
          <span className="tabular-nums text-foreground">
            = <strong>{tr(capacityUnits)}</strong> kullanım hakkı
            <span className="text-muted-foreground">
              {' '}
              {mixedCapacity
                ? '(karışık)'
                : uniformCapacity != null
                  ? `(${tr(uniformCapacity)}×)`
                  : ''}
            </span>
          </span>
        )}
        {items > 0 && capacityUnits == null && (
          <span className="text-warning">kullanım hakkı okunamadı</span>
        )}
        {blankLines > 0 && <span className="text-muted-foreground">{tr(blankLines)} boş satır atlandı</span>}
        {duplicates > 0 && (
          <span className="text-warning">{tr(duplicates)} satır birbirinin aynısı</span>
        )}
        {invalidCapacityLines > 0 && (
          <span className="text-destructive">
            {tr(invalidCapacityLines)} satırda geçersiz kullanım hakkı
          </span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 tabular-nums text-muted-foreground">
        <span className={cn(overItems && 'font-medium text-destructive', nearItems && 'text-warning')}>
          {tr(items)} / {tr(MAX_IMPORT_ITEMS)} satır
        </span>
        <span className={cn(overBytes && 'font-medium text-destructive', nearBytes && 'text-warning')}>
          {formatBytes(bytes)} / {MAX_IMPORT_LABEL}
        </span>
      </div>
    </div>
  );
}

/** Onay modalinde gösterilecek en fazla satır (gerisi "… ve N tane daha"). */
const CONFIRM_PREVIEW_ROWS = 20;

/** Gizli alan maskesi — onay listesinde parola omuz-üstünden okunmasın (§8 mask deseni). */
const CONFIRM_MASK = '••••••';

/**
 * Onay modalinin gövdesi: "neyi onaylıyorum?" sorusunun cevabı.
 *
 * Kullanıcı geri bildirimi: *"eklenip eklenmediği tam anlaşılmıyor"*. Tek tıkla kaydeden
 * bir form, hem geri alınamayan bir yazım yapar (lisans kaydı silinmez, yalnız geçersiz
 * kılınır) hem de bekleyen siparişleri ANINDA teslim edip müşteriye mail attırabilir.
 * Bu yüzden ikinci onay, girilecek kayıtların LİSTESİNİ de gösterir.
 */
function ImportConfirmDetails({
  productLabel,
  unitNoun,
  count,
  capacityUnits,
  uniformCapacity,
  mixedCapacity,
  supplyLine,
  supplyWarning,
  duplicates,
  blankLines,
  wouldFill,
  previews,
}: {
  productLabel: string;
  unitNoun: string;
  count: number;
  /** Toplam kullanım hakkı (satır kapasitelerinin toplamı); `null` = okunamadı. */
  capacityUnits: number | null;
  /** Tüm satırlar aynı kapasitedeyse o değer ("her biri N kullanım hakkı"). */
  uniformCapacity: number | null;
  /** Karışık kapasite → satır listesinde her kaydın KENDİ kapasitesi gösterilir. */
  mixedCapacity: boolean;
  supplyLine: string;
  supplyWarning: boolean;
  duplicates: number;
  blankLines: number;
  wouldFill: number;
  previews: Array<{ line: number; text: string; capacity?: number }>;
}) {
  const hidden = count - previews.length;
  return (
    <div className="space-y-3">
      <dl className="space-y-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Ürün</dt>
          <dd className="truncate text-right font-medium text-foreground">{productLabel}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Girilecek</dt>
          <dd className="text-right font-semibold tabular-nums text-foreground">
            {tr(count)} {unitNoun}
            {/* MAK'ta asıl büyüklük kullanım hakkıdır: "5 anahtar" onaylayan operatör
                gerçekte 2.500 aktivasyon dağıtıyor olabilir — sayı burada YAZILI olmalı. */}
            {capacityUnits != null && capacityUnits !== count && (
              <span className="font-normal text-muted-foreground">
                {' '}
                = {tr(capacityUnits)} kullanım hakkı
                {mixedCapacity
                  ? ' (anahtar başına farklı)'
                  : uniformCapacity != null
                    ? ` (her biri ${tr(uniformCapacity)})`
                    : ''}
              </span>
            )}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="text-muted-foreground">Tedarik</dt>
          <dd className={cn('text-right', supplyWarning ? 'text-warning' : 'text-foreground')}>
            {supplyLine}
          </dd>
        </div>
      </dl>

      {wouldFill > 0 && (
        <Alert variant="warning">
          <TriangleAlert />
          <AlertDescription>
            Bu giriş <strong>{tr(wouldFill)} bekleyen birimi hemen teslim eder</strong> — müşteriye
            teslimat e-postası gider ve mağazaya geri bildirilir. Teslim edilen anahtar geri
            alınabilir ama müşteri onu görmüş olur.
          </AlertDescription>
        </Alert>
      )}

      {(duplicates > 0 || blankLines > 0) && (
        <p className="text-xs text-muted-foreground">
          {duplicates > 0 && (
            <>
              {tr(duplicates)} satır birbirinin aynısı — panel mükerrerleri atlar, sayı bu kadar
              düşebilir.{' '}
            </>
          )}
          {blankLines > 0 && <>{tr(blankLines)} boş satır atlandı.</>}
        </p>
      )}

      <div className="space-y-1">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Girilecek kayıtlar
        </div>
        <ul className="max-h-52 overflow-y-auto rounded-md border border-border">
          {previews.map((p) => (
            <li
              key={p.line}
              className="flex gap-2 border-b border-border/60 px-2.5 py-1 text-xs last:border-b-0"
            >
              <span className="w-8 shrink-0 text-right font-mono tabular-nums text-muted-foreground">
                {p.line}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-foreground" title={p.text}>
                {p.text}
              </span>
              {/* Kapasite YALNIZ karışıkken satıra yazılır: hepsi aynıysa üstteki özet satırı
                  ("her biri N") zaten söylüyor, her satıra tekrarlamak listeyi okunmaz yapar. */}
              {mixedCapacity && p.capacity != null && (
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {tr(p.capacity)} kullanım
                </span>
              )}
            </li>
          ))}
        </ul>
        {hidden > 0 && (
          <p className="text-xs text-muted-foreground">… ve {tr(hidden)} kayıt daha.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Stok Girişi iş tezgâhı (§12/§13).
 *
 * YERLEŞİM: tek sayfa, iki kolon. Sol kolon sırayla **1 Ürün → 2 Tedarik bilgisi → 3 Anahtarlar**;
 * sağ kolon yapışkan bir "özet + onay" rayıdır (canlı satır sayımı, bekleyen sipariş etkisi,
 * kuru çalıştırma ve birincil "Onayla ve Dağıt").
 *
 * TASARIM KARARLARI
 * - Bölüm 2 **katlanır ve varsayılan KAPALIDIR** ama başlığında her zaman tek cümlelik özet
 *   taşır — operatör açmadan da "partisiz giriyorum" gerçeğini görür (partisiz giriş maliyet
 *   raporlarında geri dönülemez biçimde "kapsanamayan" olur).
 * - Katlanan bölüm DOM'dan kaldırılmaz, yalnız `display:none` olur → içindeki alanlar formla
 *   birlikte gönderilmeye devam eder (kapatınca sessizce veri kaybı olmaz).
 * - Parti modu **segment kontrolü**dür (üç açıklamalı kutu yerine yan yana üç düğme + yalnız
 *   seçili modun tek satırlık açıklaması) — asıl alanlar ekranın üstünde kalır.
 * - **Parti etiketi otomatiktir**: alım tarihinden `YYYY-MM-DD-<HARF>` türetilir, harf o ürünün
 *   aynı GÜNE ait mevcut partilerinden ilerler. Operatör alana dokunana kadar tarih/ürün
 *   değişimini izler; dokununca donar ("Otomatik" düğmesiyle geri alınır). Alan artık boş ve
 *   kırmızı-zorunlu başlamaz.
 * - Birim maliyet **LİRA** olarak girilir; kuruşa dönüşüm tek yerde (`liraToCents`) yapılır.
 *   Alan eskiden kuruştu ve "12" yazan operatör 0,12 ₺ kaydediyordu.
 * - Reddedilen satırlar **kaynak satır numarasıyla** listelenir (API'nin `items[]` sırası değil).
 */
export function ImportWorkbench({
  products,
  suppliers,
  initialProductId,
  initialBatchId,
  initialBatches,
  initialInactiveBatchCount,
  initialBatchListTruncated,
}: {
  products: ProductRow[];
  suppliers: SupplierPick[];
  /** ?product= derin bağlantısı (ürün detayından "Stok gir"). */
  initialProductId: string;
  /** ?batch= derin bağlantısı — "mevcut parti" modunu seçili getirir. */
  initialBatchId: string;
  /** Sunucuda ön-yüklenmiş parti listesi (yalnız ?product= verildiyse dolu). */
  initialBatches: ProductBatchOption[];
  initialInactiveBatchCount: number;
  initialBatchListTruncated: boolean;
}) {
  const router = useRouter();
  const announce = useAnnouncer();
  const { confirm, dialog } = useConfirm();
  const formRef = React.useRef<HTMLFormElement>(null);
  /**
   * Gerçek gönderim düğmesi GİZLİDİR: görünen "Onayla ve Dağıt" önce onay modalini açar,
   * onaylanınca bu düğme submitter olarak kullanılır. Neden `requestSubmit(submitter)`:
   * `name="dryRun" value="false"` çifti YALNIZ submitter üzerinden gövdeye girer — düz
   * `form.submit()`/`requestSubmit()` bu alanı düşürür ve sunucu kuru çalıştırma sanırdı.
   */
  const realSubmitRef = React.useRef<HTMLButtonElement>(null);

  const [state, action, pending] = React.useActionState(importStockAction, importInitial);
  const [previewState, previewDispatch] = React.useActionState(previewStockAction, previewInitial);

  // ── Bölüm 1: ürün ──────────────────────────────────────────────────────────
  const [productId, setProductId] = React.useState(initialProductId);
  const selected = products.find((p) => p.id === productId);
  const isAccount = selected?.kind === 'account';
  const columns: AccountColumn[] = React.useMemo(
    () =>
      (selected?.payloadSchema ?? []).map((f) => ({
        key: f.key,
        label: f.label || f.key,
        secret: Boolean(f.secret),
        required: Boolean(f.required),
      })),
    [selected],
  );
  const width = Math.max(columns.length, 1);

  // ── Bölüm 2: tedarik bilgisi ───────────────────────────────────────────────
  const [batchOpen, setBatchOpen] = React.useState(Boolean(initialBatchId));
  const [batchMode, setBatchMode] = React.useState<BatchMode>(initialBatchId ? 'existing' : 'none');
  const [batchId, setBatchId] = React.useState(initialBatchId);
  const [batches, setBatches] = React.useState<ProductBatchOption[]>(initialBatches);
  const [inactiveBatchCount, setInactiveBatchCount] = React.useState(initialInactiveBatchCount);
  // Sunucu parti listesi üst sınırda kırpıldıysa bu ürünün ESKİ partileri hiç gelmemiş olabilir
  // (süzme istemcide) → seçici sessizce eksik görünmesin diye ayrı uyarı satırı basılır.
  const [batchListTruncated, setBatchListTruncated] = React.useState(initialBatchListTruncated);
  const [batchesLoading, setBatchesLoading] = React.useState(false);
  const [batchesError, setBatchesError] = React.useState<string | null>(null);

  const [supplierNew, setSupplierNew] = React.useState(false);
  const [supplierId, setSupplierId] = React.useState('');
  const [supplierName, setSupplierName] = React.useState('');
  const [batchLabel, setBatchLabel] = React.useState('');
  /** Operatör etiket alanına DOKUNDU mu — dokunduysa otomatik öneri artık üzerine yazmaz. */
  const [labelTouched, setLabelTouched] = React.useState(false);
  const [receivedAt, setReceivedAt] = React.useState(todayInputValue);
  const [unitCostLira, setUnitCostLira] = React.useState('');
  const [currency, setCurrency] = React.useState<string>('TRY');
  const [batchNotes, setBatchNotes] = React.useState('');

  // ── Bölüm 3: anahtarlar ────────────────────────────────────────────────────
  const [keySource, setKeySource] = React.useState<KeySource>('paste');
  const [accountSource, setAccountSource] = React.useState<AccountSource>('table');
  const [keys, setKeys] = React.useState('');
  const [json, setJson] = React.useState('');
  const [rows, setRows] = React.useState<string[][]>(() => [emptyAccountRow(1)]);
  const [fileNote, setFileNote] = React.useState<string | null>(null);
  const [fileError, setFileError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // ── Kullanım hakkı (MAK kapasitesi) — YALNIZ çok kullanımlık üründe ─────────
  // Kullanıcı isteği: "MAK'ın kullanılabilir kapasitesini ürün düzenle kısmından değil,
  // ANAHTARA GÖRE ekleyebilmek daha doğru olur." Kapasite artık BU GİRİŞE özeldir; ürün
  // ayarındaki `maxUses` yalnız VARSAYILAN olarak kullanılır (ürünü düzenlemek o ürünün
  // gelecekteki TÜM girişlerini etkilerdi — parti parti gelen lotlar için yanlış araç).
  /** Bu girişteki her kaydın varsayılan kullanım hakkı (ham metin — operatör yazarken). */
  const [maxUsesInput, setMaxUsesInput] = React.useState('');
  /** Anahtar başına FARKLI kapasite → yapıştırma iki sütunlu okunur. */
  const [perRowCapacity, setPerRowCapacity] = React.useState(false);

  const isMulti = selected?.usageMode === 'multi';
  /** Ürün ayarındaki varsayılan (API `multi ⇒ maxUses>1` refine'ı garanti eder; yine de tabanlanır). */
  const productMaxUses = Math.max(Math.floor(selected?.maxUses ?? 1), 1);

  // Ürün değişince alan o ürünün varsayılanıyla YENİDEN doldurulur ve iki sütunlu mod kapanır.
  // Aksi halde A ürününün 50'lik lot değeri B ürününe DONMUŞ hâlde taşınır ve operatör
  // farkında olmadan yanlış kapasiteyle stok girer (kapasite geri alınamaz: `use_count`
  // asla düşmez, §2). Tek kullanımlık üründe alan hiç render edilmez → boşaltılır.
  React.useEffect(() => {
    setMaxUsesInput(isMulti ? String(productMaxUses) : '');
    setPerRowCapacity(false);
  }, [productId, isMulti, productMaxUses]);

  /**
   * Varsayılan kapasite — satırında KENDİ kapasitesi olmayan her kayda uygulanır.
   * Tek kullanımlık üründe kavramsal olarak 1'dir ve API'ye ASLA gönderilmez.
   */
  const defaultMaxUses = isMulti ? parseMaxUses(maxUsesInput) : 1;
  const defaultMaxUsesInvalid = isMulti && defaultMaxUses == null;

  // Kalıcı sonuç paneli (form temizlense de görünür kalır).
  const [result, setResult] = React.useState<ImportState['result'] | null>(null);
  const [previewNonce, setPreviewNonce] = React.useState(0);

  // Ürün değişince şema genişliği değişir → tablo satırlarını yeniden hizala.
  React.useEffect(() => {
    setRows([emptyAccountRow(width)]);
  }, [width, productId]);

  // Ürün değişince o ürünün AKTİF partilerini çek (tümünü önden yükleme pahalı: /batches
  // iki tam GROUP BY yapar). Süzgeç sunucuya `?productId=` ile gider.
  //
  // BAYAT BAYRAK YOK: `inactiveBatchCount` ve `batchListTruncated` ÖNCEKİ ürüne aitti —
  // hata/erken-dönüş yollarında sıfırlanmazsa yeni üründe yanlış uyarı basılır ("bu ürünün
  // eski partileri eksik olabilir" derken aslında hiç çekim yapılmamıştır). Üç yol da (ürün
  // temizleme · `else` · `.catch`) bayrakları sıfırlar.
  const skipFirstBatchFetch = React.useRef(Boolean(initialProductId));
  React.useEffect(() => {
    if (!productId) {
      setBatches([]);
      setInactiveBatchCount(0);
      setBatchListTruncated(false);
      setBatchesError(null);
      return;
    }
    if (skipFirstBatchFetch.current) {
      skipFirstBatchFetch.current = false;
      return;
    }
    let alive = true;
    // Parti bir ÜRÜNE aittir: ürün değişince önceki seçim geçersizdir (API başka ürünün
    // partisini 400 ile reddeder) → sessizce taşınmasın.
    setBatchId('');
    // Etiket de ürüne özgüdür. `labelTouched` sıfırlanmazsa, A ürünü için elle yazılan
    // ad (ör. "temmuz-toptan") B ürününe DONMUŞ hâlde taşınır ve 2. bölüm katlıyken
    // yalnız özet satırında görünür → yanlış adlı parti açılır. batchId ile simetrik olsun.
    setLabelTouched(false);
    setBatchesLoading(true);
    setBatchesError(null);
    void fetchProductBatchesAction(productId)
      .then((r) => {
        if (!alive) return;
        if (r.ok) {
          setBatches(r.batches ?? []);
          setInactiveBatchCount(r.inactiveCount ?? 0);
          setBatchListTruncated(r.listTruncated === true);
        } else {
          // Başarısız çekimde ÖNCEKİ ürünün listesi/sayaçları taşınmaz (yanlış parti seçimi
          // API'de 400 olurdu; bayat "kırpıldı" uyarısı da yanıltıcıdır).
          setBatches([]);
          setInactiveBatchCount(0);
          setBatchListTruncated(false);
          setBatchesError(r.error ?? 'Partiler alınamadı');
        }
      })
      .catch(() => {
        if (!alive) return;
        setBatches([]);
        setInactiveBatchCount(0);
        setBatchListTruncated(false);
        setBatchesError('Partiler alınamadı');
      })
      .finally(() => {
        if (alive) setBatchesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [productId]);

  // ── Parti etiketi önerisi ──────────────────────────────────────────────────
  // Alım tarihinden `YYYY-MM-DD-<HARF>` türetilir; harf o ÜRÜNÜN aynı GÜNE ait mevcut
  // partilerinden ilerler (A → B → C…). Operatör alana dokunana kadar tarih/ürün
  // değişince öneri kendini günceller; dokunulduktan sonra DONAR (yazdığını ezmeyiz).
  // Tarih boşaltılırsa BUGÜNE düşülür: aksi halde `autoBatchLabel` '' döner, "Otomatik"
  // düğmesi hiç render edilmez ama hata metni "Otomatik'e basın" der → çıkışsız yönlendirme.
  // Sunucu da `receivedAt` gönderilmezse now() kullanıyor; öneri onunla aynı varsayımı yapar.
  const autoLabel = React.useMemo(
    () => autoBatchLabel(receivedAt || todayInputValue(), batches.map((b) => b.label)),
    [receivedAt, batches],
  );
  // `batchLabel` de bağımlılıktır: giriş sonrası form temizliği alanı boşaltınca öneri
  // KENDİNİ YENİDEN yazar (yalnız `autoLabel` dinlenseydi, aynı ay içinde parti açılmayan
  // bir girişten sonra alan boş kalırdı). Değer öneriye eşitlenince efekt no-op olur → döngü yok.
  React.useEffect(() => {
    if (labelTouched || !autoLabel || batchLabel === autoLabel) return;
    setBatchLabel(autoLabel);
  }, [autoLabel, labelTouched, batchLabel]);

  // Bekleyen talep önizlemesi — ürün başına BİR kez çekilir; satır sayısı değiştikçe
  // hesap istemcide yapılır (ağ turu yok).
  React.useEffect(() => {
    if (!productId) return;
    const fd = new FormData();
    fd.set('productId', productId);
    fd.set('count', '0');
    React.startTransition(() => previewDispatch(fd));
  }, [productId, previewNonce, previewDispatch]);

  /**
   * İki sütunlu ("anahtar<AYRAÇ>kapasite") okuma AÇIK MI.
   *
   * Üç koşul birden: düz anahtar ürünü + çok kullanımlık + operatörün onay kutusu. Kutu
   * kapalıyken satır ASLA ayraçtan bölünmez — içinde virgül/noktalı virgül geçen bir anahtar
   * sessizce kırpılıp yarım teslim edilemez (sessiz çıkarım yok).
   */
  const capacityMode = !isAccount && isMulti && perRowCapacity;

  /**
   * İki sütunlu çözümleme TEK KEZ yapılır: kayıt listesi, görünmez karakter sayacı ve
   * ekrandaki ayraç/başlık geri bildirimi aynı sonucu okur. Üç ayrı çağrı hem her tuş
   * vuruşunda 10.000 satırı üç kez tarardı hem de üç yer arasında sapma riski taşırdı.
   */
  const capacityParse = React.useMemo(
    () => (capacityMode ? parseKeyCapacityRows(keys) : null),
    [capacityMode, keys],
  );

  // ── Girdi → kayıt listesi ──────────────────────────────────────────────────
  const { items, blankLines, invalidCapacityLines, keylessCapacityLines, extraColumnLines } =
    React.useMemo((): {
      items: ImportItemInput[];
      blankLines: number;
      /** 2. sütunu okunamayan satır (girişten ÖNCE engel olarak gösterilir). */
      invalidCapacityLines: number;
      /** Kapasite yazılmış ama anahtar hücresi boş kalan satır. */
      keylessCapacityLines: number;
      /** İkiden fazla sütun gelen satır (fazlalık sessizce atılmaz, uyarılır). */
      extraColumnLines: number;
    } => {
      const empty = {
        items: [] as ImportItemInput[],
        blankLines: 0,
        invalidCapacityLines: 0,
        keylessCapacityLines: 0,
        extraColumnLines: 0,
      };
      if (!selected) return empty;

      /** Son dolu satırdan ÖNCEKİ boş satırları sayar (sondaki satır sonu gürültü değildir). */
      const countBlanks = (flags: boolean[]): number => {
        let last = -1;
        flags.forEach((filled, i) => {
          if (filled) last = i;
        });
        return flags.slice(0, Math.max(last, 0)).filter((f) => !f).length;
      };

      /**
       * Kendi kapasitesi OLMAYAN kayda eklenecek alan.
       *
       * Tek kullanımlık üründe alan HİÇ eklenmez: API tek kullanımlık üründe 1 dışında bir
       * `maxUses` görürse TÜM isteği 400'ler, dolayısıyla oraya değer sızmamalıdır. Varsayılan
       * okunamıyorsa da eklenmez — o durumda gönderim zaten engellenir (`blockers`).
       */
      const withDefault = (): { maxUses?: number } =>
        isMulti && defaultMaxUses != null ? { maxUses: defaultMaxUses } : {};

      if (isAccount && accountSource === 'table') {
        const out: ImportItemInput[] = [];
        const flags: boolean[] = [];
        rows.forEach((row, i) => {
          const filled = row.some((v) => v.trim() !== '');
          flags.push(filled);
          if (!filled) return;
          const payload: Record<string, string> = {};
          columns.forEach((c, j) => {
            payload[c.key] = row[j] ?? '';
          });
          out.push({ payload, line: i + 1, ...withDefault() });
        });
        return { ...empty, items: out, blankLines: countBlanks(flags) };
      }

      if (isAccount) {
        // JSON (gelişmiş): her satır bir nesne. Bozuk satır HAM METİN olarak gönderilir →
        // API "Hesap payload geçerli JSON değil" der ve satır no doğru raporlanır.
        const out: ImportItemInput[] = [];
        const flags: boolean[] = [];
        splitLines(json).forEach((line, i) => {
          const trimmed = line.trim();
          flags.push(trimmed !== '');
          if (!trimmed) return;
          let payload: string | Record<string, string> = trimmed;
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              payload = parsed as Record<string, string>;
            }
          } catch {
            /* ham metin kalır — doğrulamayı API yapar */
          }
          out.push({ payload, line: i + 1, ...withDefault() });
        });
        return { ...empty, items: out, blankLines: countBlanks(flags) };
      }

      if (capacityMode && capacityParse) {
        // Çözümleme `parse.ts`e devredilir (ayraç tespiti + tırnak kuralı + başlık atlama);
        // burada YALNIZ iş kuralı uygulanır.
        const parsed = capacityParse;
        const out: ImportItemInput[] = [];
        const flags: boolean[] = [];
        let invalid = 0;
        let keyless = 0;
        let extra = 0;
        parsed.rows.forEach((r) => {
          const key = r.key.trim();
          const capRaw = r.capacityRaw.trim();
          const filled = key !== '' || capRaw !== '';
          flags.push(filled);
          if (!filled) return;
          if (r.extraCells > 0) extra += 1;
          if (!key) {
            // Kapasite yazılmış ama anahtar yok: satırı sessizce atmak, operatörün girdiğini
            // yok saymak olurdu → sayılır ve engel listesinde gösterilir.
            keyless += 1;
            return;
          }
          const cap = capRaw ? parseMaxUses(capRaw) : defaultMaxUses;
          if (capRaw && cap == null) {
            // Kayıt yine de listeye girer (satır sayısı/önizleme gerçeği yansıtsın) ama
            // kapasitesi YOKTUR; gönderim `blockers` ile engellenir → yanlış kapasiteyle
            // yazılması imkânsız (kapasite geri alınamaz: `use_count` asla düşmez, §2).
            invalid += 1;
            out.push({ payload: key, line: r.line });
            return;
          }
          out.push({ payload: key, line: r.line, ...(cap != null ? { maxUses: cap } : {}) });
        });
        return {
          items: out,
          blankLines: countBlanks(flags),
          invalidCapacityLines: invalid,
          keylessCapacityLines: keyless,
          extraColumnLines: extra,
        };
      }

      const out: ImportItemInput[] = [];
      const flags: boolean[] = [];
      splitLines(keys).forEach((line, i) => {
        const trimmed = line.trim();
        flags.push(trimmed !== '');
        if (!trimmed) return;
        out.push({ payload: trimmed, line: i + 1, ...withDefault() });
      });
      return { ...empty, items: out, blankLines: countBlanks(flags) };
    }, [
      selected,
      isAccount,
      isMulti,
      accountSource,
      capacityMode,
      capacityParse,
      defaultMaxUses,
      rows,
      columns,
      json,
      keys,
    ]);

  /** Aynı içerikli (mükerrer görünen) satır sayısı — API dedupe'undan ÖNCE uyarır. */
  const duplicateCount = React.useMemo(() => {
    const seen = new Set<string>();
    let dup = 0;
    for (const it of items) {
      const key =
        typeof it.payload === 'string'
          ? it.payload
          : JSON.stringify(columns.map((c) => (it.payload as Record<string, string>)[c.key] ?? ''));
      if (seen.has(key)) dup += 1;
      else seen.add(key);
    }
    return dup;
  }, [items, columns]);

  const itemsJson = React.useMemo(() => JSON.stringify(items), [items]);
  const payloadBytes = React.useMemo(() => byteLength(itemsJson), [itemsJson]);

  /**
   * Kapasite özeti. MAK/çok kullanımlıkta bir anahtar `maxUses` birim talebi karşılar →
   * "kaç anahtar girdim" ile "kaç kullanım hakkı oldu" AYRI sayılardır.
   *
   * Toplam artık `satır × sabit çarpan` DEĞİL, satır kapasitelerinin TOPLAMIDIR (satır bazında
   * farklı kapasite mümkün). Kapasite okunamıyorsa (varsayılan alanı geçersiz ya da 2. sütunda
   * bozuk değer var) toplam `null` döner — 0 ya da tahmini bir sayı göstermek operatörü
   * "bu giriş N bekleyen birimi teslim eder" cümlesinde yanıltırdı.
   */
  const { capacityUnits, uniformCapacity, mixedCapacity } = React.useMemo(() => {
    if (items.length === 0) {
      return { capacityUnits: 0, uniformCapacity: null as number | null, mixedCapacity: false };
    }
    if (defaultMaxUsesInvalid || invalidCapacityLines > 0) {
      return { capacityUnits: null as number | null, uniformCapacity: null, mixedCapacity: false };
    }
    let total = 0;
    const distinct = new Set<number>();
    for (const it of items) {
      // Tek kullanımlık üründe kayıtlarda `maxUses` HİÇ yoktur → kapasite 1'dir.
      const cap = typeof it.maxUses === 'number' ? it.maxUses : 1;
      total += cap;
      distinct.add(cap);
    }
    const values = [...distinct];
    return {
      capacityUnits: total,
      uniformCapacity: values.length === 1 ? (values[0] ?? null) : null,
      mixedCapacity: values.length > 1,
    };
  }, [items, defaultMaxUsesInvalid, invalidCapacityLines]);

  /**
   * Yapıştırılan anahtar satırlarında GÖRÜNMEZ karakter (NBSP, sıfır-genişlik, BOM).
   *
   * Hesap tablosunda bu kontrol vardı ama düz anahtar yapıştırmasında YOKTU. `trim()`
   * yalnız UÇLARDAKİ boşluğu alır; anahtarın ORTASINA düşmüş bir sıfır-genişlik karakter
   * (web sayfasından/PDF'ten kopyalamada olağan) sessizce şifrelenip müşteriye gider ve
   * "anahtar çalışmıyor" olarak döner — üstelik hash farklılaştığı için mükerrer kontrolü
   * de kaçırır. Temizlemeyiz (sessiz veri değişikliği yok), GÖSTERİRİZ + tek tık sunarız.
   */
  const hiddenKeyLines = React.useMemo(() => {
    if (isAccount) return 0;
    // İki sütunlu modda kontrol YALNIZ anahtar hücresine uygulanır: kapasite hücresindeki
    // NBSP `parseMaxUses` içinde zaten temizlenir, onun için uyarı basmak yanlış alarmdır.
    if (capacityParse) {
      return capacityParse.rows.filter((r) => r.key.trim() !== '' && hasHiddenChars(r.key.trim()))
        .length;
    }
    return splitLines(keys).filter((l) => l.trim() !== '' && hasHiddenChars(l.trim())).length;
  }, [isAccount, capacityParse, keys]);

  const cleanKeys = () =>
    setKeys(
      splitLines(keys)
        .map((l) => cleanHiddenChars(l))
        .join('\n'),
    );

  /**
   * Onay modalinde gösterilecek satırlar. Anahtar ürününde değerin kendisi yazılır
   * (operatör zaten ekranda görüyor); hesap ürününde `secret` alanlar MASKELENİR —
   * modal ekranın ortasında büyük durur, parola omuz-üstünden okunmamalı.
   */
  const itemPreviews = React.useMemo(
    () =>
      items.slice(0, CONFIRM_PREVIEW_ROWS).map((it, i) => {
        const line = it.line ?? i + 1;
        // Kapasite yalnız karışık girişte satıra yazdırılır (bkz. ImportConfirmDetails).
        const cap: { capacity?: number } =
          typeof it.maxUses === 'number' ? { capacity: it.maxUses } : {};
        if (typeof it.payload === 'string') return { line, text: it.payload, ...cap };
        const payload = it.payload;
        const text = columns
          .map((c) => {
            const raw = (payload[c.key] ?? '').trim();
            if (!raw) return null;
            return `${c.label}: ${c.secret ? CONFIRM_MASK : raw}`;
          })
          .filter(Boolean)
          .join(' · ');
        return { line, text: text || '(boş)', ...cap };
      }),
    [items, columns],
  );

  // ── Doğrulama / engeller ───────────────────────────────────────────────────
  const costCents = unitCostLira.trim() ? liraToCents(unitCostLira) : null;
  const costInvalid = Boolean(unitCostLira.trim()) && costCents == null;
  const supplierChosen = supplierNew ? supplierName.trim() !== '' : supplierId !== '';
  const newBatchActive = batchMode === 'new';
  const labelMissing = newBatchActive && batchLabel.trim() === '';
  const costWithoutSupplier = newBatchActive && Boolean(unitCostLira.trim()) && !supplierChosen;
  const tooManyItems = items.length > MAX_IMPORT_ITEMS;
  const tooLarge = payloadBytes > MAX_IMPORT_BYTES;

  const blockers: string[] = [];
  if (!productId) blockers.push('Ürün seçin.');
  if (productId && items.length === 0) blockers.push('En az bir kayıt girin.');
  // KAPASİTE ENGELLERİ — API'nin satır-bazlı reddine bırakılmaz, girişten ÖNCE durdurulur:
  // yanlış kapasiteyle yazılmış bir MAK anahtarı geri alınamaz (`use_count` asla düşmez, §2)
  // ve fazla kapasite sessiz aşırı-satışa dönüşür.
  if (defaultMaxUsesInvalid) {
    blockers.push(
      `Kullanım hakkı ${MAX_USES_MIN}–${tr(MAX_USES_CAP)} arası bir tam sayı olmalı.`,
    );
  }
  if (invalidCapacityLines > 0) {
    blockers.push(
      `${tr(invalidCapacityLines)} satırda kullanım hakkı okunamadı — ` +
        `2. sütuna ${MAX_USES_MIN}–${tr(MAX_USES_CAP)} arası tam sayı yazın ya da boş bırakın.`,
    );
  }
  if (keylessCapacityLines > 0) {
    blockers.push(
      `${tr(keylessCapacityLines)} satırda kullanım hakkı var ama anahtar hücresi boş.`,
    );
  }
  // Etiket normalde otomatik dolar → bu engel yalnız operatör alanı ELLE boşalttıysa çıkar.
  if (labelMissing) blockers.push('Parti etiketi boş — yazın ya da "Otomatik" düğmesine basın.');
  if (newBatchActive && costInvalid) blockers.push('Birim maliyeti lira olarak girin — ör. 12,50.');
  if (costWithoutSupplier) {
    blockers.push('Birim maliyet girdiniz — tedarikçi seçin ya da maliyeti boşaltın.');
  }
  if (tooManyItems) {
    blockers.push(
      `Tek seferde en çok ${MAX_IMPORT_ITEMS.toLocaleString('tr-TR')} kayıt girilebilir.`,
    );
  }
  if (tooLarge) {
    blockers.push(`Girdi ${MAX_IMPORT_LABEL} sınırını aşıyor (${formatBytes(payloadBytes)}).`);
  }
  const blocked = blockers.length > 0;

  // ── Bekleyen sipariş etkisi (istemcide hesaplanır) ─────────────────────────
  const autoUnits = previewState.result?.autoUnits ?? 0;
  const manualUnits = previewState.result?.manualUnits ?? 0;
  const pendingUnits = previewState.result?.pendingUnits ?? 0;
  // Karşılaştırma BİRİM üzerinden yapılır: bekleyen talep birimdir, MAK ürününde bir
  // anahtar `maxUses` birim karşılar. Eskiden anahtar sayısı birimle kıyaslanıyordu →
  // MAK ürününde etki OLDUĞUNDAN AZ görünüyordu (1 anahtar giren "1 birim tamamlanır"
  // okuyor, gerçekte 500 birim kapanıyordu).
  // Kapasite okunamıyorsa (geçersiz alan/sütun) etki 0 sayılır — tahmini bir sayı yazmak
  // "N bekleyen birimi teslim eder" cümlesini yalanlar; gönderim zaten engellidir.
  const effectiveCapacity = capacityUnits ?? 0;
  const wouldFill = Math.min(effectiveCapacity, autoUnits);
  const remainingAfter = Math.max(effectiveCapacity - autoUnits, 0);

  const selectedBatch = batches.find((b) => b.id === batchId);

  // ── Sonuç ──────────────────────────────────────────────────────────────────
  React.useEffect(() => {
    if (!state.ok || !state.result) return;
    const r = state.result;
    setResult(r);
    if (r.dryRun) {
      const dryMsg =
        `Kuru çalıştırma: ${r.wouldImport ?? 0} kabul edilecek, ${r.duplicates} mükerrer, ${r.rejected} reddedilecek.` +
        duplicateReason(r.duplicateDetail);
      toast.message('Kuru çalıştırma bitti — hiçbir şey kaydedilmedi', { description: dryMsg });
      announce(dryMsg);
      return;
    }
    // Gerçek giriş — formu temizle (ürün seçili kalır: aynı ürüne devam edilebilir).
    setKeys('');
    setJson('');
    setRows([emptyAccountRow(width)]);
    setFileNote(null);
    setFileError(null);
    if (fileRef.current) fileRef.current.value = '';
    setBatchMode('none');
    setBatchId('');
    // Bu girişte açılan parti listeye eklenir: hem "mevcut parti" seçicisinde görünür hem de
    // BİR SONRAKİ otomatik etiket harfini ilerletir (aksi halde aynı ay tekrar "A" önerilirdi).
    const nb = r.newBatch;
    if (nb?.created && nb.batchId) {
      const created: ProductBatchOption = {
        id: nb.batchId,
        label: nb.label,
        status: 'active',
        receivedAt: nb.receivedAt ?? null,
        supplierName: nb.supplierName ?? null,
        qtyReceived: nb.qtyReceived ?? 0,
      };
      setBatches((prev) => (prev.some((b) => b.id === created.id) ? prev : [...prev, created]));
    }
    // Etiket yeniden OTOMATİĞE döner (yukarıdaki öneri efekti bir sonraki harfi yazar).
    setLabelTouched(false);
    setBatchLabel('');
    setSupplierId('');
    setSupplierName('');
    setSupplierNew(false);
    setUnitCostLira('');
    setBatchNotes('');
    setPreviewNonce((n) => n + 1);
    router.refresh();
    const msg =
      `${r.imported} kayıt girildi, ${r.duplicates} mükerrer atlandı, ${r.rejected} reddedildi.` +
      duplicateReason(r.duplicateDetail) +
      (r.autoCompleted > 0 ? ` ${r.autoCompleted} bekleyen sipariş tamamlandı.` : '');
    // Toast + kalıcı sonuç paneli BİRLİKTE: form temizlendiği için ekranda "bir şey oldu mu?"
    // sorusu kalmasın (kullanıcı geri bildirimi). imported=0 asla yeşil gösterilmez.
    if (r.imported > 0) toast.success(`${r.imported} kayıt envantere girdi`, { description: msg });
    else toast.warning('Hiçbir kayıt girilmedi', { description: msg });
    announce(msg);
  }, [state, width, router, announce]);

  const onFile = async (file: File | null) => {
    setFileError(null);
    setFileNote(null);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError(
        `Dosya çok büyük (${formatBytes(file.size)}). En çok ${MAX_IMPORT_LABEL} yükleyebilirsiniz — ` +
          'dosyayı bölüp parça parça girin.',
      );
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      // Dosya TARAYICIDA okunur: içerik (lisans anahtarı) sunucu loguna/geçici dosyaya düşmez.
      const text = await file.text();
      setKeys(text);
      const lines = splitLines(text).filter((l) => l.trim() !== '').length;
      setFileNote(`${file.name} okundu — ${lines} dolu satır (${formatBytes(file.size)}).`);
    } catch {
      setFileError('Dosya okunamadı. Düz metin (.txt/.csv) seçtiğinizden emin olun.');
    }
  };

  const batchSummary = (): string => {
    if (batchMode === 'none') return 'Partisiz — maliyet raporlarında kapsanamayan';
    if (batchMode === 'existing') {
      return selectedBatch ? `Mevcut parti: ${selectedBatch.label}` : 'Mevcut parti seçilmedi';
    }
    // YALNIZ dolu parçalar yazılır — eksik alan "girilmedi" diye olumsuz cümle kurmaz
    // (etiket zaten otomatik dolar; boş kalması istisnadır).
    const parts: string[] = [];
    const label = batchLabel.trim();
    if (label) parts.push(label);
    const supplier = supplierNew
      ? supplierName.trim()
      : (suppliers.find((s) => s.id === supplierId)?.name ?? '');
    if (supplierChosen && supplier) parts.push(supplier);
    if (costCents != null && items.length > 0) {
      parts.push(`${items.length} × ${formatMoney(costCents, currency)}`);
    }
    return parts.length > 0 ? `Yeni parti: ${parts.join(' · ')}` : 'Yeni parti açılacak';
  };

  /**
   * İKİNCİ ONAY — "Onayla ve Dağıt" doğrudan kaydetmez, önce ne olacağını gösterir.
   *
   * Onaylanırsa GİZLİ submit düğmesi submitter olarak kullanılır (`name=dryRun value=false`
   * çifti yalnız böyle gövdeye girer). `requestSubmit` yoksa (çok eski tarayıcı) düğmeye
   * tıklanır — iki yol da aynı submitter'ı taşır.
   */
  const askThenSubmit = async () => {
    if (blocked || pending) return;
    const res = await confirm({
      title: 'Stok girişini onaylıyor musunuz?',
      description:
        'Kayıtlar şifrelenerek envantere yazılır. Girilen lisans silinemez — yalnız geçersiz kılınabilir.',
      confirmLabel: `Evet, ${tr(items.length)} ${isAccount ? 'hesabı' : 'anahtarı'} gir`,
      cancelLabel: 'Vazgeç, düzenlemeye dön',
      details: (
        <ImportConfirmDetails
          productLabel={selected ? `${selected.name} · ${selected.sku}` : '—'}
          unitNoun={isAccount ? 'hesap' : 'anahtar'}
          count={items.length}
          capacityUnits={capacityUnits}
          uniformCapacity={uniformCapacity}
          mixedCapacity={mixedCapacity}
          supplyLine={batchSummary()}
          supplyWarning={batchMode === 'none'}
          duplicates={duplicateCount}
          blankLines={blankLines}
          wouldFill={previewState.ok ? wouldFill : 0}
          previews={itemPreviews}
        />
      ),
    });
    if (!res) return;
    const form = formRef.current;
    const submitter = realSubmitRef.current;
    if (!form || !submitter) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter);
    else submitter.click();
  };

  // Sağ özet rayı lg'de 18rem, xl'de 21rem: lg (1024px) devreye girdiğinde kabuk zaten
  // ~304px (sidebar + padding) tüketiyor; 21rem sabit ray sol ÇALIŞMA kolonunu 364px'e
  // düşürüyordu (asıl iş — ürün/tedarik/yapıştırma — o kolonda). 18rem → 412px;
  // 1280px ve üzerinde mevcut 21rem görünümü aynen korunur. loading.tsx aynada tutulmalı.
  return (
    <form
      ref={formRef}
      action={action}
      className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_18rem] xl:grid-cols-[minmax(0,1fr)_21rem]"
    >
      {dialog}
      {/* Gerçek gönderim düğmesi — görünmez; onay modali tarafından submitter olarak kullanılır. */}
      <button ref={realSubmitRef} type="submit" name="dryRun" value="false" className="hidden" />
      {/* Kayıtlar tek gizli alanla taşınır: hesap satırları API'ye NESNE olarak gider
          (JSON string'e çevrilmez) ve her kaydın EKRANDAKİ satır numarası birlikte gider. */}
      <input type="hidden" name="itemsJson" value={itemsJson} />
      <input type="hidden" name="batchMode" value={batchMode} />

      {/* ══ SOL KOLON ══════════════════════════════════════════════════════ */}
      <div className="space-y-4">
        {/* ── 1. Ürün ───────────────────────────────────────────────────── */}
        <Card>
          <CardHeader>
            <CardTitle icon={Package}>
              <span className="text-muted-foreground">1.</span> Ürün
            </CardTitle>
            <CardDescription>Anahtarların hangi panel ürününe gireceğini seçin.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="Ürün" htmlFor="si-product" required hint="Ada veya SKU'ya göre arayın.">
              <Combobox
                id="si-product"
                name="productId"
                required
                ariaLabel="Ürün"
                className="max-w-lg"
                value={productId}
                onValueChange={setProductId}
                items={products.map((p) => ({
                  value: p.id,
                  label: p.name,
                  hint: `${p.sku} · ${productKindLabel(p.kind)}`,
                  keywords: [p.sku, p.kind],
                }))}
                placeholder="— ürün seçin —"
                searchPlaceholder="Ürün adı veya SKU…"
                emptyText="Ürün bulunamadı"
              />
            </Field>

            {selected && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="accent">{productKindLabel(selected.kind)}</Badge>
                  <Badge variant="outline">{usageModeLabel(selected.usageMode)}</Badge>
                  {/* "Varsayılan" ŞART: kapasite artık girişe özel ayarlanabiliyor; çıplak
                      "anahtar başına N" rozeti 3. adımdaki farklı bir değerle çelişirdi. */}
                  {selected.usageMode === 'multi' && selected.maxUses ? (
                    <Badge variant="outline">
                      Varsayılan: anahtar başına {tr(selected.maxUses)} kullanım
                    </Badge>
                  ) : null}
                  <span className="font-mono text-xs text-muted-foreground">{selected.sku}</span>
                </div>
                <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <Boxes className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">Mevcut stok</span>
                    <strong className="tabular-nums text-foreground">
                      {selected.availableStock}
                    </strong>
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <ClipboardList className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-muted-foreground">Bekleyen talep</span>
                    <strong className="tabular-nums text-foreground">
                      {previewState.ok ? pendingUnits : '…'}
                    </strong>
                    <span className="text-xs text-muted-foreground">birim</span>
                  </span>
                  <Link
                    href={`/products/${selected.id}`}
                    className="inline-flex items-center gap-1 text-xs text-primary underline-offset-4 hover:underline"
                  >
                    Ürün detayı <ExternalLink className="size-3" aria-hidden />
                  </Link>
                </div>
                {selected.usageMode === 'multi' && (
                  <p className="text-xs text-muted-foreground">
                    Çok kullanımlık (MAK) ürün: ürün ayarındaki varsayılan kapasite{' '}
                    {tr(productMaxUses)} kullanım. Bu girişe özel kapasiteyi (ve istenirse her
                    anahtarınkini ayrı ayrı) <strong>3. adımda</strong> belirleyebilirsiniz —
                    ürün ayarını değiştirmeniz gerekmez.
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* ── 2. Tedarik bilgisi (katlanır) ─────────────────────────────── */}
        {/* ADIM KİLİDİ (kullanıcı isteği): ürün seçilmeden 2. ve 3. adım AÇILMAZ. Önceki
            tasarım yalnız soluklaştırıyordu ama tıklanabiliyordu; girdi biçimi (anahtar mı
            hesap tablosu mu) ve parti/maliyet alanlarının anlamı ÜRÜNE bağlı olduğu için
            sırayı bozmak yarım doldurulmuş, sonra sıfırlanan bir form üretiyordu. */}
        <Card className={cn(!selected && 'opacity-60')} aria-disabled={!selected || undefined}>
          <button
            type="button"
            onClick={() => selected && setBatchOpen((v) => !v)}
            disabled={!selected}
            aria-expanded={batchOpen && Boolean(selected)}
            aria-controls="si-supply"
            className="flex w-full items-start gap-3 rounded-xl px-5 py-4 text-left outline-none disabled:cursor-not-allowed"
          >
            {batchOpen ? (
              <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            ) : (
              <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            )}
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <Truck className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>
                  <span className="text-muted-foreground">2.</span> Tedarik bilgisi
                </span>
                <span className="text-xs font-normal text-muted-foreground">(isteğe bağlı)</span>
              </span>
              <span
                className={cn(
                  'mt-0.5 block truncate text-xs',
                  batchMode === 'none' ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {selected ? batchSummary() : 'Önce 1. adımda ürün seçin'}
              </span>
            </span>
          </button>

          {/* DOM'dan kaldırılmaz — yalnız gizlenir: kapatınca alanlar gönderilmeye devam eder.
              Kilitliyken de gizli kalır (ürün yokken açılamaz). */}
          <div id="si-supply" className={cn('px-5 pb-5', (!batchOpen || !selected) && 'hidden')}>
            <Separator className="mb-4" />
            {/* Segment + YALNIZ seçili modun tek satırlık açıklaması (üç açıklamayı birden
                göstermek asıl alanları ekranın altına itiyordu). */}
            <div className="space-y-1.5">
              <BatchModeSegment value={batchMode} onChange={setBatchMode} />
              <p className="text-xs text-muted-foreground">
                {(BATCH_MODES.find((m) => m.value === batchMode) ?? BATCH_MODES[0]).desc}
              </p>
            </div>

            {batchMode === 'none' && (
              <Alert variant="warning" className="mt-3">
                <TriangleAlert />
                <AlertDescription>
                  Bu anahtarların maliyeti raporlarda &quot;kapsanamayan&quot; görünür ve sonradan
                  düzeltilemez. Geri çekme (recall) ve tedarikçi karnesi de bu girişi kapsamaz.
                </AlertDescription>
              </Alert>
            )}

            {batchMode === 'existing' && (
              <div className="mt-4 space-y-2">
                <Field
                  label="Parti"
                  htmlFor="si-batch"
                  hint="Yalnız bu ürünün AKTİF partileri listelenir; geri çekilmiş/iptal partiye stok eklenemez."
                >
                  <Combobox
                    id="si-batch"
                    name="batchId"
                    ariaLabel="Parti"
                    className="max-w-lg"
                    value={batchId}
                    onValueChange={setBatchId}
                    disabled={batchesLoading}
                    items={batches.map((b) => ({
                      value: b.id,
                      label: b.label,
                      hint: [
                        b.supplierName ?? null,
                        b.receivedAt ? formatDate(b.receivedAt, false) : null,
                        supplyStatusLabel(b.status),
                      ]
                        .filter(Boolean)
                        .join(' · '),
                      keywords: [b.supplierName ?? '', b.status].filter(Boolean),
                    }))}
                    allowClear
                    clearLabel="— seçimi temizle —"
                    placeholder={batchesLoading ? 'Partiler yükleniyor…' : '— parti seçin —'}
                    searchPlaceholder="Parti etiketi veya tedarikçi…"
                    emptyText="Bu ürünün aktif partisi yok"
                  />
                </Field>
                {inactiveBatchCount > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {inactiveBatchCount} parti aktif olmadığı için listelenmedi (geri çekilmiş /
                    iptal edilmiş).
                  </p>
                )}
                {/* Hata varken kırpma uyarısı BASILMAZ: liste hiç gelmediyse "kırpıldı" demek
                    yanlış sebep gösterir (asıl mesaj `batchesError`). */}
                {!batchesError && batchListTruncated && (
                  <p className="text-xs text-warning">
                    Parti listesi sunucuda üst sınıra dayandı — bu ürünün çok eski partileri burada
                    görünmeyebilir. Aradığınız parti yoksa Partiler ekranından açıp oradan stok girin.
                  </p>
                )}
                {batchesError && <p className="text-xs text-destructive">{batchesError}</p>}
                {batchId && !selectedBatch && !batchesLoading && (
                  <p className="text-xs text-warning">
                    Bağlantıyla gelen parti bu ürünün aktif partileri arasında yok. Doğru partiyi
                    seçin ya da seçimi temizleyin.
                  </p>
                )}
              </div>
            )}

            {batchMode === 'new' && (
              /* ALAN SIRASI: önce KİM/NE ZAMAN (tedarikçi + tarih), sonra NE KADAR (maliyet +
                 para birimi), en sonda KİMLİK/NOT (etiket artık otomatik → ikincil). Her satır
                 iki dolu hücre — boş grid hücresi bırakılmaz. */
              <div className="mt-4 space-y-3">
                <FieldRow>
                  {/* Tedarikçi ve "listede yok" seçeneği TEK alanın içinde: onay kutusu
                      kontrolün hemen altında durur (eskiden yardım metninin altında ayrı
                      satırdaydı, hangi alana ait olduğu anlaşılmıyordu). */}
                  <Field
                    label={supplierNew ? 'Yeni tedarikçi adı' : 'Tedarikçi'}
                    htmlFor={supplierNew ? 'si-supplier-name' : 'si-supplier'}
                    hint={
                      supplierNew
                        ? 'Aynı adla kayıt varsa YENİDEN KULLANILIR; yoksa oluşturulur.'
                        : 'Maliyet gireceksen zorunlu — maliyet satın alma emrinde tutulur.'
                    }
                  >
                    <div className="space-y-1.5">
                      {/*
                        İki alan KARŞILIKLI DIŞLAYICI (API ikisini birlikte 400'ler). Pasif olan
                        kontrol DOM'da HİÇ bulunmaz → yalnız biri gönderilir. Değerler state'te
                        korunur: kutuyu açıp kapatan operatör yazdığını kaybetmez.
                      */}
                      {supplierNew ? (
                        <Input
                          id="si-supplier-name"
                          name="supplierName"
                          value={supplierName}
                          onChange={(e) => setSupplierName(e.target.value)}
                          placeholder="ör. Acme Yazılım"
                        />
                      ) : (
                        <Combobox
                          id="si-supplier"
                          name="supplierId"
                          ariaLabel="Tedarikçi"
                          value={supplierId}
                          onValueChange={setSupplierId}
                          items={suppliers
                            .filter((s) => s.active)
                            .map((s) => ({ value: s.id, label: s.name }))}
                          allowClear
                          clearLabel="— tedarikçisiz —"
                          placeholder="— tedarikçi seçin —"
                          searchPlaceholder="Tedarikçi ara…"
                          emptyText="Tedarikçi bulunamadı"
                        />
                      )}
                      <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={supplierNew}
                          onChange={(e) => setSupplierNew(e.target.checked)}
                          className={checkboxClass}
                        />
                        Listede yok — yeni ad gireceğim
                      </label>
                    </div>
                  </Field>
                  <Field
                    label="Alım tarihi"
                    htmlFor="si-received"
                    hint="Maliyet raporu ayları bu tarihe göre gruplanır; parti etiketi de bundan üretilir."
                  >
                    <Input
                      id="si-received"
                      name="receivedAt"
                      type="date"
                      value={receivedAt}
                      onChange={(e) => setReceivedAt(e.target.value)}
                    />
                  </Field>
                </FieldRow>

                <FieldRow>
                  <Field
                    label="Birim maliyet"
                    htmlFor="si-cost"
                    error={costInvalid ? 'Sayı okunamadı. Örnek: 12,50' : undefined}
                    hint="Kuruş DEĞİL — ör. 12,50. Boş bırakılabilir."
                  >
                    <div className="space-y-1">
                      <div className="relative">
                        {/* Para birimi öneki: "12" yazan operatörün kuruş mu lira mı girdiği
                            tereddüdünü alanın İÇİNDE giderir (uzun yardım metni yerine). */}
                        <span
                          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground"
                          aria-hidden
                        >
                          {currencySymbol(currency)}
                        </span>
                        <Input
                          id="si-cost"
                          name="unitCostLira"
                          inputMode="decimal"
                          value={unitCostLira}
                          onChange={(e) => setUnitCostLira(e.target.value)}
                          placeholder="12,50"
                          className="pl-7"
                          aria-invalid={costInvalid || undefined}
                        />
                      </div>
                      {costCents != null && items.length > 0 && (
                        <p className="text-xs tabular-nums text-muted-foreground">
                          {items.length} × {formatMoney(costCents, currency)} ={' '}
                          <strong className="text-foreground">
                            {formatMoney(costCents * items.length, currency)}
                          </strong>
                        </p>
                      )}
                    </div>
                  </Field>
                  <Field label="Para birimi" htmlFor="si-currency">
                    <select
                      id="si-currency"
                      name="currency"
                      value={currency}
                      onChange={(e) => setCurrency(e.target.value)}
                      className={cn(selectClass, 'w-full')}
                    >
                      {CURRENCIES.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </select>
                  </Field>
                </FieldRow>

                <FieldRow>
                  <Field
                    label={
                      <span className="inline-flex items-center gap-1.5">
                        Parti etiketi
                        {!labelTouched && autoLabel && (
                          <Badge variant="outline" className="px-1.5 py-0 font-normal">
                            otomatik
                          </Badge>
                        )}
                      </span>
                    }
                    htmlFor="si-label"
                    required
                    error={
                      labelMissing
                        ? 'Etiket boş — parti açılamaz. "Otomatik" ile geri getirebilirsiniz.'
                        : undefined
                    }
                    hint="Alım tarihinden üretilir (yıl-ay-gün-harf); harf aynı gün içindeki ikinci girişi ayırır. Aynı ürüne aynı etiket ikinci kez girilirse uyarılırsınız."
                  >
                    {/* flex-wrap + min-w-0 ŞART: native <input> ana eksende flex öğesiyken
                        min-width:auto (= içsel tercih genişliği, ~205px) alır ve ALTINA İNMEZ;
                        yanındaki buton da whitespace-nowrap. Bu satır FieldRow'un
                        minmax(0,1fr) sütununda yaşadığı için sütun büyümez → kap dışına taşardı.
                        wrap dar sütunda butonu alt satıra indirir, min-w-0 input'un daralmasına izin verir. */}
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Input
                        id="si-label"
                        name="batchLabel"
                        value={batchLabel}
                        onChange={(e) => {
                          // Elle yazan operatörün değerini bir daha EZMEYİZ (öneri donar).
                          setLabelTouched(true);
                          setBatchLabel(e.target.value);
                        }}
                        placeholder={autoLabel || '2026-08-13-A'}
                        className="min-w-0 max-w-[13rem]"
                        aria-invalid={labelMissing || undefined}
                      />
                      {labelTouched && autoLabel && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setLabelTouched(false);
                            setBatchLabel(autoLabel);
                          }}
                          title={`Otomatik etikete dön (${autoLabel})`}
                        >
                          <RotateCcw />
                          Otomatik
                        </Button>
                      )}
                    </div>
                  </Field>

                  <Field label="Not" htmlFor="si-notes" hint="Serbest not (opsiyonel).">
                    <Textarea
                      id="si-notes"
                      name="batchNotes"
                      rows={2}
                      value={batchNotes}
                      onChange={(e) => setBatchNotes(e.target.value)}
                      placeholder="Fatura no, teslim şekli…"
                    />
                  </Field>
                </FieldRow>

                <Alert variant="info">
                  <Banknote />
                  <AlertDescription>
                    Bu girişle birlikte{' '}
                    {receivedAt ? formatDate(`${receivedAt}T00:00:00`, false) : 'bugün'} tarihli,
                    &quot;teslim alındı&quot; durumunda bir parti açılır. Tedarikçi + birim maliyet
                    girerseniz satın alma emri de oluşur ve maliyet her lisans kaydına
                    anlık-görüntü olarak yazılır. Adet BEYAN DEĞİL, gerçekten kaydedilen kayıt
                    sayısıdır.
                  </AlertDescription>
                </Alert>
              </div>
            )}
          </div>
        </Card>

        {/* ── 3. Anahtarlar ─────────────────────────────────────────────── */}
        <Card className={cn(!selected && 'opacity-60')}>
          <CardHeader>
            <CardTitle icon={KeyRound}>
              <span className="text-muted-foreground">3.</span>{' '}
              {isAccount ? 'Hesaplar' : 'Anahtarlar'}
            </CardTitle>
            <CardDescription>
              {!selected
                ? 'Önce ürün seçin — girdi biçimi ürün tipine göre değişir.'
                : isAccount
                  ? 'Her satır bir hesap. Alanlar ürünün şemasından gelir.'
                  : capacityMode
                    ? 'Her satır bir anahtar + o anahtarın kullanım hakkı. Boş satırlar atlanır.'
                    : 'Her satır bir anahtar. Boş satırlar atlanır, baştaki/sondaki boşluk kırpılır.'}
              {selected
                ? ` Tek seferde en çok ${MAX_IMPORT_ITEMS.toLocaleString('tr-TR')} satır (${MAX_IMPORT_LABEL}).`
                : ''}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* ADIM KILIDI: urun secilmeden girdi alanlari KAPALI. fieldset[disabled]
                icindeki HER kontrolu native olarak devre disi birakir (odak sirasindan da
                cikarir) — tek tek disabled dagitmaktan daha guvenli, kacak kalmaz. */}
            {!selected && (
              <p className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2.5 text-sm text-muted-foreground">
                <Lock className="size-4 shrink-0" aria-hidden />
                Önce <strong className="font-medium text-foreground">1. adımda</strong> ürün
                seçin — girdi biçimi (anahtar listesi mi hesap tablosu mu) ürün tipine göre
                değişir.
              </p>
            )}
            <fieldset disabled={!selected} className="min-w-0 space-y-3">
            {/* Sekme görünümü: tabs primitifi YOK → Button varyantı + koşullu render. */}
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Girdi biçimi">
              {isAccount ? (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant={accountSource === 'table' ? 'secondary' : 'ghost'}
                    aria-pressed={accountSource === 'table'}
                    onClick={() => setAccountSource('table')}
                  >
                    <Table2 /> Tablo
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={accountSource === 'json' ? 'secondary' : 'ghost'}
                    aria-pressed={accountSource === 'json'}
                    onClick={() => setAccountSource('json')}
                  >
                    <Braces /> JSON (gelişmiş)
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="sm"
                    variant={keySource === 'paste' ? 'secondary' : 'ghost'}
                    aria-pressed={keySource === 'paste'}
                    onClick={() => setKeySource('paste')}
                  >
                    <ClipboardList /> Yapıştır
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={keySource === 'file' ? 'secondary' : 'ghost'}
                    aria-pressed={keySource === 'file'}
                    onClick={() => setKeySource('file')}
                  >
                    <FileUp /> Dosya
                  </Button>
                </>
              )}
            </div>

            {/* ── Kullanım hakkı — YALNIZ çok kullanımlık (MAK) üründe render edilir ──────
                Tek kullanımlık üründe kapasite kavramı YOKTUR: alanı göstermek gürültü,
                değerini göndermek ise API'de 400 olurdu. `isMulti` kapısı hem bu bloğu hem
                `withDefault()` alanını hem de iki sütunlu modu birlikte kapatır. */}
            {isMulti && (
              <div className="space-y-2.5 rounded-lg border border-border bg-muted/30 p-3">
                <Field
                  label="Her anahtarın kullanım hakkı"
                  htmlFor="si-max-uses"
                  required
                  error={
                    defaultMaxUsesInvalid
                      ? `${MAX_USES_MIN}–${tr(MAX_USES_CAP)} arası bir tam sayı yazın.`
                      : undefined
                  }
                  hint={`Tedarikçiden gelen bu partinin aktivasyon sayısı. Ürün ayarındaki varsayılan: ${tr(productMaxUses)}. Buradaki değer YALNIZ bu girişe uygulanır — ürün ayarı değişmez.`}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/*
                      `name` YOK: değer forma ayrı bir alan olarak GİTMEZ, her kaydın içine
                      (`itemsJson` → `items[].maxUses`) gömülür. Tek bir form alanı olsaydı
                      satır bazında farklı kapasite taşınamazdı.
                    */}
                    <Input
                      id="si-max-uses"
                      inputMode="numeric"
                      value={maxUsesInput}
                      onChange={(e) => setMaxUsesInput(e.target.value)}
                      placeholder={String(productMaxUses)}
                      className="min-w-0 max-w-[9rem] tabular-nums"
                      aria-invalid={defaultMaxUsesInvalid || undefined}
                    />
                    {maxUsesInput.trim() !== String(productMaxUses) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setMaxUsesInput(String(productMaxUses))}
                        title={`Ürün ayarındaki varsayılana dön (${tr(productMaxUses)})`}
                      >
                        <RotateCcw />
                        Varsayılan ({tr(productMaxUses)})
                      </Button>
                    )}
                  </div>
                </Field>

                {/* Satır bazında kapasite YALNIZ düz anahtar yolunda: hesap tablosunun
                    sütunları ürünün payloadSchema'sından gelir, oraya kapasite sütunu
                    eklemek şema alanı gibi görünüp hesap verisine karışırdı. */}
                {!isAccount && (
                  <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={perRowCapacity}
                      onChange={(e) => setPerRowCapacity(e.target.checked)}
                      className={checkboxClass}
                    />
                    Anahtarların kapasiteleri farklı — her satırda ayrı yazacağım
                  </label>
                )}

                {capacityMode && (
                  <div className="space-y-1 rounded-md border border-border bg-background/60 p-2.5 text-xs">
                    <div className="flex items-center gap-2 font-semibold text-foreground">
                      <span className="min-w-0 flex-1 truncate">1. sütun: Anahtar</span>
                      <span className="w-32 shrink-0 text-right">2. sütun: Kullanım hakkı</span>
                    </div>
                    <p className="text-muted-foreground">
                      Her satır <code className="text-foreground">anahtar</code> +{' '}
                      <code className="text-foreground">kullanım hakkı</code> biçiminde okunur
                      (sekme, noktalı virgül ya da virgülle ayırın — Excel&apos;den yapıştırma
                      doğrudan çalışır). İkinci sütunu BOŞ bırakılan satır yukarıdaki varsayılanı
                      alır. Başlık satırı yazarsanız atlanır.
                    </p>
                    {capacityParse && items.length > 0 && (
                      <p className="text-muted-foreground">
                        Okunan ayraç:{' '}
                        <strong className="text-foreground">
                          {delimiterLabel(capacityParse.delimiter)}
                        </strong>
                        {capacityParse.delimiter == null &&
                          ' — ikinci sütun bulunamadı, tüm satırlar varsayılan kapasiteyi alır.'}
                        {capacityParse.headerSkipped && ' · başlık satırı atlandı'}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}

            {isAccount && accountSource === 'table' && columns.length === 0 && (
              <Alert variant="warning">
                <TriangleAlert />
                <AlertDescription>
                  Bu hesap ürününün alan şeması (payloadSchema) tanımlı değil — tablo
                  oluşturulamıyor. Ürün detayından alanları tanımlayın.
                </AlertDescription>
              </Alert>
            )}

            {isAccount && accountSource === 'table' && columns.length > 0 && (
              <AccountRowsEditor columns={columns} rows={rows} onRowsChange={setRows} />
            )}

            {isAccount && accountSource === 'json' && (
              <Field
                label="Her satır bir JSON nesne"
                htmlFor="si-json"
                hint={
                  <>
                    Alanlar: {columns.map((c) => c.key).join(', ') || '(şema tanımsız)'} — örn:{' '}
                    <code className="text-foreground">
                      {JSON.stringify(
                        Object.fromEntries(
                          (columns.length ? columns : [{ key: 'username' }, { key: 'password' }]).map(
                            (c) => [c.key, '…'],
                          ),
                        ),
                      )}
                    </code>
                  </>
                }
              >
                <Textarea
                  id="si-json"
                  rows={10}
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder={'{"username":"…","password":"…"}\n{"username":"…","password":"…"}'}
                />
              </Field>
            )}

            {!isAccount && keySource === 'paste' && (
              <Field
                label={capacityMode ? 'Anahtar + kullanım hakkı' : 'Anahtarlar'}
                htmlFor="si-keys"
                hint={
                  capacityMode
                    ? `Her satır: anahtar, ayraç, kullanım hakkı — en çok ${MAX_IMPORT_ITEMS.toLocaleString('tr-TR')} satır. Sayaç aşağıda canlı güncellenir.`
                    : `Her satıra bir anahtar — en çok ${MAX_IMPORT_ITEMS.toLocaleString('tr-TR')} satır. Sayaç aşağıda canlı güncellenir.`
                }
              >
                <Textarea
                  id="si-keys"
                  rows={12}
                  value={keys}
                  onChange={(e) => setKeys(e.target.value)}
                  className="font-mono text-xs"
                  spellCheck={false}
                  placeholder={
                    capacityMode
                      ? 'XXXXX-XXXXX-XXXXX-XXXXX-11111;500\nXXXXX-XXXXX-XXXXX-XXXXX-22222;50\nXXXXX-XXXXX-XXXXX-XXXXX-33333'
                      : 'XXXXX-XXXXX-XXXXX-XXXXX-11111\nXXXXX-XXXXX-XXXXX-XXXXX-22222'
                  }
                />
              </Field>
            )}

            {!isAccount && keySource === 'file' && (
              <div className="space-y-2">
                <Field
                  label="Anahtar listesi (.txt / .csv)"
                  htmlFor="si-file"
                  hint={`Dosya TARAYICIDA okunur (içerik sunucu loguna düşmez). En çok ${MAX_IMPORT_LABEL}.`}
                >
                  {/*
                    `name` YOK: dosya sunucu action gövdesine EKLENMEZ — içeriği zaten metin
                    olarak okuyup `itemsJson` ile gönderiyoruz (aynı veriyi iki kez taşımak
                    gövde sınırını gereksiz yere doldururdu).
                  */}
                  <Input
                    id="si-file"
                    ref={fileRef}
                    type="file"
                    accept=".txt,.csv,text/plain,text/csv"
                    onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
                    className="max-w-lg"
                  />
                </Field>
                {fileNote && <p className="text-xs text-success">{fileNote}</p>}
                {fileError && (
                  <p role="alert" className="text-xs text-destructive">
                    {fileError}
                  </p>
                )}
                {keys && (
                  <Field
                    label="Okunan içerik (düzenlenebilir)"
                    htmlFor="si-file-preview"
                    hint="Dosyadan gelen satırları buradan düzeltebilirsiniz."
                  >
                    <Textarea
                      id="si-file-preview"
                      rows={8}
                      value={keys}
                      onChange={(e) => setKeys(e.target.value)}
                      className="font-mono text-xs"
                      spellCheck={false}
                    />
                  </Field>
                )}
              </div>
            )}

            {/* Canlı sayaç — girdi alanının HEMEN ALTINDA. Sağ raydaki özet uzun listede
                ekran dışında kalıyordu; asıl kontrol yapıştırmanın yanında olmalı. */}
            {selected && (
              <EntryMeter
                items={items.length}
                blankLines={blankLines}
                duplicates={duplicateCount}
                bytes={payloadBytes}
                capacityUnits={capacityUnits}
                uniformCapacity={uniformCapacity}
                mixedCapacity={mixedCapacity}
                invalidCapacityLines={invalidCapacityLines}
                unitNoun={isAccount ? 'hesap' : 'anahtar'}
              />
            )}
            {/* İki sütunlu modda fazladan sütun: satır ATILMAZ, ilk iki hücre okunur —
                ama sessiz kalmaz (anahtarında ayraç geçen bir satırın işareti olabilir). */}
            {capacityMode && extraColumnLines > 0 && (
              <p className="text-xs text-warning">
                {tr(extraColumnLines)} satırda ikiden fazla sütun var — yalnız ilk iki sütun
                (anahtar, kullanım hakkı) okunur. Anahtarınızın içinde ayraç geçiyorsa iki
                sütunlu modu kapatın.
              </p>
            )}

            {/* Düz anahtar yolunda görünmez karakter uyarısı (hesap tablosundaki ile aynı
                disiplin): sessizce temizlemeyiz, gösterip tek tık sunarız. */}
            {!isAccount && hiddenKeyLines > 0 && (
              <div className="space-y-2 rounded-md border border-warning/40 bg-[color-mix(in_oklch,var(--warning-vivid)_10%,transparent)] p-2.5">
                <p className="flex items-start gap-1.5 text-xs text-foreground">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                  <span>
                    <strong>{tr(hiddenKeyLines)} satırda</strong> görünmez karakter var (kırılmaz
                    boşluk / sıfır-genişlik). Anahtarla birlikte teslim edilir, müşteride
                    &quot;çalışmıyor&quot; olarak döner ve mükerrer kontrolünü de kaçırır.
                  </span>
                </p>
                <Button type="button" variant="outline" size="sm" onClick={cleanKeys}>
                  <Eraser /> Görünmez karakterleri temizle
                </Button>
              </div>
            )}
            </fieldset>
          </CardContent>
        </Card>
      </div>

      {/* ══ SAĞ RAY (yapışkan özet + onay) ═════════════════════════════════ */}
      <aside className="space-y-4 lg:sticky lg:top-4">
        <Card>
          <CardHeader>
            <CardTitle icon={Eye}>Özet</CardTitle>
            <CardDescription>Girmeden önce ne olacağını gösterir.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <dl className="space-y-1.5 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">
                  Girilecek {isAccount ? 'hesap' : 'anahtar'}
                </dt>
                <dd className="text-lg font-semibold tabular-nums text-foreground">
                  {tr(items.length)}
                </dd>
              </div>
              {isMulti && (
                // MAK/çok kullanımlık: anahtar sayısı ile stoğa eklenen birim AYRI şeydir.
                // Çarpan artık satır bazında değişebilir → sabit "N×" yerine duruma göre yazılır.
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-muted-foreground">
                    Kullanım hakkı
                    {mixedCapacity
                      ? ' (karışık)'
                      : uniformCapacity != null
                        ? ` (${tr(uniformCapacity)}×)`
                        : ''}
                  </dt>
                  <dd
                    className={cn(
                      'tabular-nums',
                      capacityUnits == null ? 'text-warning' : 'text-foreground',
                    )}
                  >
                    {capacityUnits == null ? '—' : tr(capacityUnits)}
                  </dd>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Mükerrer görünen</dt>
                <dd
                  className={cn(
                    'tabular-nums',
                    duplicateCount > 0 ? 'text-warning' : 'text-foreground',
                  )}
                >
                  {duplicateCount}
                </dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Atlanan boş satır</dt>
                <dd className="tabular-nums text-foreground">{blankLines}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">Gövde boyutu</dt>
                <dd className={cn('tabular-nums', tooLarge ? 'text-destructive' : 'text-foreground')}>
                  {formatBytes(payloadBytes)}
                </dd>
              </div>
            </dl>

            <Separator />

            <div className="space-y-1 text-sm">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Bekleyen sipariş etkisi
              </div>
              {!productId ? (
                <p className="text-xs text-muted-foreground">Ürün seçilince hesaplanır.</p>
              ) : previewState.error ? (
                <p className="text-xs text-destructive">{previewState.error}</p>
              ) : !previewState.ok ? (
                <p className="text-xs text-muted-foreground">Hesaplanıyor…</p>
              ) : (
                <>
                  <p className="text-foreground">
                    Bu giriş <strong className="tabular-nums">{wouldFill}</strong> bekleyen birimi
                    otomatik tamamlar.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {remainingAfter > 0
                      ? `Kalan ${tr(remainingAfter)} birim stokta kalır. `
                      : autoUnits > effectiveCapacity
                        ? `${tr(autoUnits - effectiveCapacity)} birim talep açık kalır. `
                        : ''}
                    {manualUnits > 0 && (
                      <>
                        {manualUnits} birim elle işlem bekliyor (ya hep ya hiç / onaylı teslimat) —
                        stok girişi bunları otomatik doldurmaz.
                      </>
                    )}
                  </p>
                </>
              )}
            </div>

            {blocked && (
              <ul className="space-y-1 rounded-md border border-warning/40 bg-[color-mix(in_oklch,var(--warning-vivid)_10%,transparent)] p-2.5 text-xs text-foreground">
                {blockers.map((b) => (
                  <li key={b} className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            )}

            <div className="flex flex-col gap-2">
              {/* Gerçek giriş ÖNCE onay modalini açar (yukarıdaki gizli düğmeyle gönderilir). */}
              <Button type="button" onClick={() => void askThenSubmit()} disabled={pending || blocked}>
                <Upload />
                {pending ? 'İşleniyor…' : 'Onayla ve Dağıt'}
              </Button>
              {/* Kuru çalıştırma (§7): yalnız doğrular, hiçbir şey kaydetmez. */}
              <Button
                type="submit"
                name="dryRun"
                value="true"
                variant="outline"
                disabled={pending || blocked}
              >
                <Eye />
                Önizle (kuru çalıştır)
              </Button>
              <p className="text-xs text-muted-foreground">
                Kuru çalıştırma hiçbir şey kaydetmez: kaç kayıt kabul edilecek, kaçı mükerrer, kaçı
                reddedilecek — önce gösterir.
              </p>
            </div>

            {state.error && (
              <p role="alert" className="text-sm text-destructive">
                {state.error}
              </p>
            )}
          </CardContent>
        </Card>

        {result && <ResultPanel result={result} productId={productId} />}
      </aside>
    </form>
  );
}

/**
 * Kalıcı sonuç paneli. Kuru çalıştırma ve gerçek giriş AYNI bileşende gösterilir; ikisi
 * arasındaki fark (kaydedildi mi?) en üstte AÇIKÇA yazılır. `imported === 0` asla "başarılı"
 * yeşiliyle gösterilmez.
 */
function ResultPanel({
  result,
  productId,
}: {
  result: NonNullable<ImportState['result']>;
  productId: string;
}) {
  const dry = Boolean(result.dryRun);
  const ok = dry ? (result.wouldImport ?? 0) > 0 : result.imported > 0;
  const nb = result.newBatch;

  return (
    <Card>
      <CardHeader>
        <CardTitle icon={dry ? Eye : ok ? CheckCircle2 : TriangleAlert}>
          {dry ? 'Kuru çalıştırma sonucu' : ok ? 'Stok girildi' : 'Hiçbir kayıt girilmedi'}
        </CardTitle>
        <CardDescription>
          {dry
            ? 'Hiçbir şey kaydedilmedi — yalnız doğrulama yapıldı.'
            : 'Aşağıdaki özet kalıcıdır; aynı ürüne yeni giriş yapabilirsiniz.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">{dry ? 'Kabul edilecek' : 'Girildi'}</dt>
            <dd
              className={cn(
                'text-lg font-semibold tabular-nums',
                ok ? 'text-success' : 'text-warning',
              )}
            >
              {dry ? (result.wouldImport ?? 0) : result.imported}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Mükerrer (atlandı)</dt>
            <dd className="tabular-nums text-foreground">{result.duplicates}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">Reddedildi</dt>
            <dd className={cn('tabular-nums', result.rejected > 0 ? 'text-warning' : 'text-foreground')}>
              {result.rejected}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-muted-foreground">İstenen</dt>
            <dd className="tabular-nums text-muted-foreground">{result.requested}</dd>
          </div>
        </dl>

        {/* MÜKERRERİN NEDENİ — toast kaybolur, bu panel kalır. Salt sayı ("2 mükerrer")
            operatörü çıkmaza sokuyordu: kendi iptal ettiği kayıtla çakıştığını ve çıkış
            yolunun ne olduğunu hiçbir yerde söylemiyordu. */}
        {result.duplicates > 0 && duplicateReason(result.duplicateDetail) !== '' && (
          <p className="text-muted-foreground">{duplicateReason(result.duplicateDetail).trim()}</p>
        )}

        {!dry && result.autoCompleted > 0 && (
          <p className="flex items-start gap-1.5 text-success">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              {result.autoCompleted} bekleyen sipariş satırı tamamlandı.{' '}
              <Link href="/orders" className="underline underline-offset-4">
                Siparişleri gör
              </Link>
            </span>
          </p>
        )}
        {!dry && result.autoCompleteFailed && (
          /*
           * KISMİ BAŞARI — stok girdi, tarama koşmadı. Yeşil "N kayıt girildi" tek başına
           * yanıltıcıdır: bekleyen siparişler stok VARKEN teslim edilmeden kalır ve operatör
           * bunu "zaten bekleyen yoktu"dan ayırt edemez. Kardeş kapasite yolu bunu zaten
           * uyarıyla söylüyor; ana içe aktarma yolu geride kalmıştı.
           */
          <p className="flex items-start gap-1.5 text-warning">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              Kayıtlar envantere girdi, ancak bekleyen sipariş taraması yapılamadı. Bekleyen
              satırlar için sipariş detayındaki{' '}
              <strong>&quot;Kalanları Ata&quot;</strong> ile devam edebilirsiniz.{' '}
              <Link href="/pending" className="underline underline-offset-4">
                Bekleyen teslimatlar
              </Link>
            </span>
          </p>
        )}
        {!dry && result.autoCompleteQueued && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              Kalan bekleyen siparişler arka planda tamamlanıyor — birkaç dakika içinde
              &quot;Bekleyen Teslimatlar&quot; listesinden düşerler.
            </span>
          </p>
        )}

        {result.qtyMismatch && (
          <Alert variant="warning">
            <TriangleAlert />
            <AlertTitle>Beklenenden az kayıt girdi</AlertTitle>
            <AlertDescription>
              {result.qtyMismatch.declared} satır gönderildi, {result.qtyMismatch.imported} kayıt
              girdi (mükerrer/reddedilenler düşüldü). Satın alma emri GERÇEK adetle açıldığı için
              harcama doğrudur.
            </AlertDescription>
          </Alert>
        )}

        {nb && (
          <div className="space-y-1 rounded-md border border-border bg-muted/30 p-3 text-sm">
            {nb.created ? (
              <p className="font-medium text-foreground">
                {`Parti ${nb.label} oluşturuldu`}
                {(() => {
                  const meta = [
                    nb.supplierName,
                    nb.receivedAt ? formatDate(nb.receivedAt, false) : null,
                  ].filter(Boolean);
                  return meta.length > 0 ? ` (${meta.join(' · ')})` : '';
                })()}
                .
              </p>
            ) : (
              <p className="font-medium text-warning">
                Parti OLUŞTURULMADI —{' '}
                {nb.reason === 'dry_run'
                  ? 'kuru çalıştırmada hiçbir şey kaydedilmez (gerçek girişte oluşacak).'
                  : 'hiçbir satır doğrulamadan geçmediği için boş parti açılmadı.'}
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              {nb.qtyReceived} adet
              {nb.unitCostCents != null
                ? ` · birim ${formatMoney(nb.unitCostCents, nb.currency ?? 'TRY')}`
                : ' · maliyet girilmedi'}
              {nb.supplierCreated ? ' · tedarikçi bu girişte oluşturuldu' : ''}
              {nb.supplierExisting ? ' · mevcut tedarikçi kullanıldı' : ''}
              {nb.costSnapshotApplied ? ' · maliyet lisans kayıtlarına yazıldı' : ''}
            </p>
            {nb.labelDuplicate && (
              <p className="text-xs text-warning">
                Bu üründe aynı etiketli başka bir parti daha var — karışmaması için etiketleri
                ayırmayı düşünün.
              </p>
            )}
            {nb.created && (
              <div className="flex flex-wrap gap-3 pt-1 text-xs">
                <Link href="/batches" className="text-primary underline-offset-4 hover:underline">
                  Partiler
                </Link>
                {nb.purchaseOrderId && (
                  <Link
                    href={`/purchase-orders/${nb.purchaseOrderId}`}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Satın alma emri
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

        {result.rejected > 0 && result.rejections && result.rejections.length > 0 && (
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Reddedilen satırlar
            </div>
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
              {result.rejections.map((r) => (
                <li key={`${r.index}-${r.line ?? ''}`} className="flex gap-2">
                  {/* Satır no EKRANDAKİ satırdır — API'nin items[] sırası değil (boş/başlık
                      satırları atlandığı için ikisi farklıdır). */}
                  <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                    satır {r.line ?? r.index + 1}
                  </span>
                  <span className="text-foreground">{r.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {productId && (
          <div className="flex flex-wrap gap-3 text-xs">
            <Link
              href={`/products/${productId}`}
              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              Ürün envanteri <ExternalLink className="size-3" aria-hidden />
            </Link>
            <Link href="/stock" className="text-primary underline-offset-4 hover:underline">
              Stok &amp; Ürünler
            </Link>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
