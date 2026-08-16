'use client';
import * as React from 'react';
import Link from 'next/link';
import { Ban, ExternalLink, Gauge, Pencil, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  adjustLicenseCapacityAction,
  updateLicenseItemAction,
  voidLicenseItemAction,
  type LicenseInventoryRow,
} from '../../app/stock/license-actions';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { Field } from '../ui/field';
import { Input, Textarea } from '../ui/input';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { RecordSummary as SharedRecordSummary } from '../rotate-credentials-control';
import { itemNoun, licenseItemStatusLabel } from '../../lib/labels';
import type { PayloadFieldDef } from '../../lib/api';

/** Durum etiketi — TEK KAYNAK `lib/labels.ts` (bilinmeyen anahtar → ham değer). */
export const statusLabel = (s: string) => licenseItemStatusLabel(s);

/** Müşteride CANLI sayılan atama durumları (bunlar varsa lisansa dokunulmaz). */
const LIVE_ASSIGNMENT = new Set(['active', 'suspended']);

/**
 * Bir lisans kalemi düzenlenebilir/iptal edilebilir mi + değilse sebebi.
 * İki katmanın İSTEMCİ tarafı: API zaten teslim edilmişte 409 döner, burada düğme
 * hiç aktif olmaz (yanlışlıkla tıklama imkânsız, sebep tooltip'te yazar).
 */
export function editability(row: LicenseInventoryRow): { editable: boolean; reason: string } {
  if (row.delivered && LIVE_ASSIGNMENT.has(row.delivered.assignmentStatus)) {
    return {
      editable: false,
      reason:
        `Bu ${itemNoun(row.productType)} müşteride. İçeriğini buradan düzenlemek müşterinin` +
        ' elindeki lisansı sessizce bozardı — yenisiyle değiştirmek için siparişi açın.',
    };
  }
  if (row.status !== 'available') {
    return {
      editable: false,
      reason: `Yalnız stokta bekleyen lisanslar düzenlenebilir. Mevcut durum: ${statusLabel(row.status)}.`,
    };
  }
  return { editable: true, reason: '' };
}

/**
 * Lisans envanteri satır aksiyonları.
 *
 * ── EKRANIN İŞİ (kullanıcı kararı) ──
 * "Buradaki amaç stoktaki lisansları görüntüleyebilmem veya lisansı hatalı eklediğimde
 * lisansın/hesabın bilgisini değiştirebilmem." Yani bu ekran bir ENVANTER ekranıdır:
 *   (a) stoktakileri gör,
 *   (b) YANLIŞ GİRİLMİŞ kaydı düzelt (**Değiştir** = payload düzeltme) ya da stoktan düş (**Sil**),
 *   (c) çok kullanımlı (MAK) kalemin **Kapasite**sini düzelt.
 *
 * ── MÜŞTERİYE DOKUNAN AKSİYON YOK (İSTİSNASIZ) ──
 * "Yenisiyle değiştir" (müşterideki canlı anahtarı taze bir anahtarla değiştirme) ve hesap
 * ürünündeki "Kimlik bilgilerini güncelle" BURADAN KALDIRILDI: o kararlar sipariş bağlamı
 * ister (hangi müşteri, hangi satır, garanti penceresi, kardeş kalemler) ve o bağlam yalnız
 * sipariş detayındadır. İkisi de kaybolmadı, YERİ değişti:
 *   · "Değiştir"                    → sipariş detayı, atama satırı (mevcut).
 *   · "Kimlik bilgilerini güncelle" → sipariş detayı, atama satırı
 *                                     (`components/rotate-credentials-control.tsx`).
 * Teslim edilmiş satır SESSİZCE boş kalmaz: kendi siparişine giden bir kısayol ve tek
 * cümlelik yönlendirme gösterir (düğmeyi izsiz kaldırmak "özellik kayboldu" hissi verirdi).
 *
 * Tüm yazma işlemlerinde sebep ZORUNLU; API hatası (ör. 409 "teslim edilmiş") AYNEN gösterilir.
 */
export function LicenseItemActions({
  row,
  payloadSchema,
  onDone,
  compact = false,
  masked,
}: {
  row: LicenseInventoryRow;
  /**
   * Hesap ürününün alan şeması (yalnız ürün detayında bilinir). Verilirse düzenleme formu
   * TÜM şema alanlarını gösterir — boş bırakılmış opsiyonel alan sonradan doldurulabilir
   * (API yalnız DOLU alanları döndürdüğü için şemasız formda o alan hiç görünmezdi).
   */
  payloadSchema?: PayloadFieldDef[] | null;
  /** Başarılı işlemden sonra tabloyu tazelemek için. */
  onDone: () => void;
  /**
   * Değerler MASKELİ mi (owner DEĞİLİZ)? Bu ekrandaki tek owner-only işlemin (MAK kapasite
   * düzeltmesi) düğmesi bu bayrağa göre sebebiyle kapalı sunulur — tıklanıp 403 veren düğme,
   * hiç sunulmayandan kötüdür. Otoriter kapı sunucuda (`OwnerGuard` + sunucu aksiyonundaki
   * `isOwner()`); bu yalnız erken geri bildirimdir.
   */
  masked?: boolean;
  /**
   * Yoğun TABLO satırında etiketler gizlenir (ikon + aria-label/title kalır): iki metin
   * düğmesi kolona 197px yüklüyor ve 1600px ekranda bile tabloyu 162px yana kaydırıyordu
   * (ölçüldü). Dar ekrandaki KART görünümünde yer var → etiketler orada görünür kalır.
   */
  compact?: boolean;
}) {
  const [editOpen, setEditOpen] = React.useState(false);
  const [voidOpen, setVoidOpen] = React.useState(false);
  const [capacityOpen, setCapacityOpen] = React.useState(false);
  const { editable, reason: lockReason } = editability(row);

  /** Kalem ŞU AN bir müşterinin elinde mi (aktif ya da askıdaki atama)? */
  const live = Boolean(row.delivered && LIVE_ASSIGNMENT.has(row.delivered.assignmentStatus));

  return (
    <div className="flex items-center justify-end gap-1.5">
      {live ? (
        /* Sessiz boşluk YOK: müşteriye dokunan düğmeler kaldırıldı ama nereye gidileceği yazıyor. */
        <DeliveredOrderLink row={row} compact={compact} />
      ) : editable ? (
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
            aria-label={`${row.productName} lisansını değiştir`}
          >
            <Pencil aria-hidden />{' '}
            <span className={compact ? 'sr-only' : undefined}>Değiştir</span>
          </Button>
          <Button
            variant="danger-outline"
            size="sm"
            onClick={() => setVoidOpen(true)}
            aria-label={`${row.productName} lisansını geçersiz kıl`}
          >
            <Trash2 aria-hidden /> <span className={compact ? 'sr-only' : undefined}>Sil</span>
          </Button>
        </>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            {/* Devre dışı düğme pointer olayı üretmez → tooltip için odaklanabilir sarmalayıcı. */}
            <span
              tabIndex={0}
              className="inline-flex items-center justify-end gap-1.5 rounded-md"
              title={lockReason}
            >
              <Button variant="outline" size="sm" disabled aria-label={`Değiştir — ${lockReason}`}>
                <Pencil aria-hidden />{' '}
                <span className={compact ? 'sr-only' : undefined}>Değiştir</span>
              </Button>
              <Button
                variant="danger-outline"
                size="sm"
                disabled
                aria-label={`Sil — ${lockReason}`}
              >
                <Trash2 aria-hidden /> <span className={compact ? 'sr-only' : undefined}>Sil</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{lockReason}</TooltipContent>
        </Tooltip>
      )}

      {/* KAPASİTE — yalnız çok kullanımlı (MAK) kalemde ve HER DALDA sunulur: paylaşımlı bir
          anahtar aynı anda hem müşterilerde olabilir hem de kalan hakkı düzeltilebilir
          (kapasite artışı kimsenin elindeki lisansa dokunmaz). */}
      <CapacityButton
        row={row}
        masked={masked}
        compact={compact}
        onOpen={() => setCapacityOpen(true)}
      />

      {/* Katmanlar (Sheet/Dialog) — açılmadıkça görünmezler, dal mantığını kirletmesinler diye
          hepsi burada toplanır. */}
      {!live && editable && (
        <>
          <EditLicenseSheet
            row={row}
            payloadSchema={payloadSchema}
            open={editOpen}
            onOpenChange={setEditOpen}
            onDone={onDone}
          />
          <VoidLicenseSheet row={row} open={voidOpen} onOpenChange={setVoidOpen} onDone={onDone} />
        </>
      )}
      {row.usageMode === 'multi' && (
        <CapacityDialog
          row={row}
          open={capacityOpen}
          onOpenChange={setCapacityOpen}
          onDone={onDone}
        />
      )}
    </div>
  );
}

/**
 * Teslim edilmiş satırın YÖNLENDİRMESİ — "değiştirmek için siparişe gidin".
 *
 * NEDEN VAR: "Yenisiyle değiştir" düğmesi bu ekrandan kaldırıldı (bkz. LicenseItemActions
 * jsdoc'u). Aksiyon sütununu boş bırakmak, operatöre "özellik kayboldu / bu satırda hiçbir şey
 * yapılamaz" hissi verirdi; oysa işlem hâlâ var, yalnız YERİ değişti. Bu yüzden satır kendi
 * siparişine giden bir kısayol ve tek cümlelik gerekçe gösterir.
 *
 * Aynı sipariş bağlantısı "Teslimat" kolonunda da var, ama o kolon `xl` altında GİZLİ ve dar
 * ekrandaki kart görünümünde teslimat bloğu satırın altındadır — aksiyon sütununda ayrıca
 * bulunması, operatörün baktığı yerde kalmasını sağlar.
 */
function DeliveredOrderLink({
  row,
  compact,
}: {
  row: LicenseInventoryRow;
  compact: boolean;
}) {
  const d = row.delivered;
  if (!d) return null;
  const noun = itemNoun(row.productType);
  const hint =
    `Bu ${noun} müşteride (sipariş #${d.remoteOrderId || '—'}). Yenisiyle değiştirmek, askıya` +
    ' almak, iptal etmek' +
    // Hesap ürününde "kimlik bilgilerini güncelle" de artık siparişte — operatör aradığı
    // aracın nereye gittiğini BU cümleden öğrensin (özellik kaybolmadı, yeri değişti).
    (row.kind === 'account' ? ' veya kimlik bilgilerini güncellemek' : '') +
    ' için siparişi açın — bu işlemler sipariş bağlamı gerektirir.';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" asChild aria-label={hint}>
          <Link href={`/orders/${d.orderId}`}>
            <ExternalLink aria-hidden />{' '}
            <span className={compact ? 'sr-only' : undefined}>Siparişe git</span>
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">{hint}</TooltipContent>
    </Tooltip>
  );
}

/** Kapasite düzeltmesinin YAPILABİLDİĞİ kalem durumları — servisteki guard ile BİREBİR aynı. */
const CAPACITY_EDITABLE_STATUS = new Set(['available', 'depleted']);

/**
 * "Kapasite" düğmesi — YALNIZ çok kullanımlı (MAK/multi) kalemde.
 *
 * NEDEN VAR (kullanıcı ihtiyacı): "MAK ürünlerde kapasiteyi tekrar düzenleyemiyorum… 1000
 * kullanım hakkı vardı, 900 kalmış, bunu manuel tekrar 1000'e çıkartabilsem." Ürün formundaki
 * `maxUses` YALNIZ yeni girilen kalemlere uygulanır; mevcut satırın tavanını değiştiren bir
 * yol yoktu ve kapasitesi tükenmiş (`Tükendi`) anahtar geri döndürülemiyordu.
 *
 * İKİ KATMAN: yetki ve durum kontrolünün OTORİTER hâli sunucudadır (OwnerGuard + servis
 * guard'ları); düğme burada da sebebiyle kapatılır — tıklanıp 403/409 veren düğme, hiç
 * sunulmayandan kötüdür (proje kuralı).
 */
function CapacityButton({
  row,
  masked,
  compact,
  onOpen,
}: {
  row: LicenseInventoryRow;
  masked?: boolean;
  compact: boolean;
  onOpen: () => void;
}) {
  if (row.usageMode !== 'multi') return null;

  // `masked` = API "düz metin göstermedim" dedi, yani owner DEĞİLİZ (listLicenseItems bunu
  // `!canRevealPlaintext(role)` olarak döndürür). Rotasyon düğmesiyle AYNI proxy kullanılır.
  // Alan gelmezse (eski API imajı) kapı sunucuda zaten var → düğme açık bırakılır.
  const notOwner = masked === true;
  const badStatus = !CAPACITY_EDITABLE_STATUS.has(row.status);
  const why = notOwner
    ? 'Kapasite düzenlemesi owner yetkisi gerektirir — satılabilir stok miktarını doğrudan değiştirir.'
    : `Bu kalem “${statusLabel(row.status)}” durumunda. Kapasite yalnız stokta bekleyen ya da ` +
      'kapasitesi tükenmiş kalemlerde düzenlenebilir.';
  const label = 'Kapasite';

  if (notOwner || badStatus) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex justify-end rounded-md" title={why}>
            <Button variant="outline" size="sm" disabled aria-label={`${label} — ${why}`}>
              <Gauge aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{why}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="outline" size="sm" onClick={onOpen} aria-label={`${label} düzenle`}>
          <Gauge aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        Kalan kullanım hakkını düzelt ({row.useCount}/{row.maxUses} · kalan {row.remainingUses}).
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Kapasite düzeltme formu (Dialog = KARAR yüzeyi; Sheet = çalışma yüzeyi — proje ayrımı).
 *
 * ── OPERATÖR "KALAN"I GİRER, TAVANI DEĞİL ──
 * Ekranda ve kafasında olan sayı "kalan kullanım hakkı"dır (tablodaki Kapasite kolonu da
 * `0/5 · kalan 5` der). Bu yüzden alan "yeni kalan"dır; sunucu tavanı
 * `max_uses = use_count + kalan` diye TÜRETİR ve formun altında bu türetme ÖNCEDEN yazılır —
 * operatör "Kaydet"e basmadan yeni toplamı görür.
 *
 * ── KULLANILAN HAK ASLA SIFIRLANMAZ ──
 * `use_count` müşterilerin elindeki gerçek aktivasyonları temsil eder; düşürmek aynı
 * aktivasyonları ikinci kez satılabilir gösterirdi (§2) ve mutabakat cron'unda kalıcı kritik
 * alarm üretirdi. Bu yüzden kutuda azaltma DEĞİL, tavanı yükseltme/indirme vardır ve taban
 * `use_count`tur (alan `min=0`, yani yeni tavan hiçbir zaman kullanılanın altına inemez).
 *
 * ── AZALTMA ──
 * İzinli (tedarikçi hakkı geri alabilir) ama GÖRÜNÜR uyarı basar: azaltma satılabilir stoğu
 * anında düşürür ve kalan 0'a inerse kalem "Tükendi" olur.
 */
function CapacityDialog({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: LicenseInventoryRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [remaining, setRemaining] = React.useState<string>(String(row.remainingUses));
  const [reason, setReason] = React.useState('');

  // Her açılışta MEVCUT değerle başla: kapalıyken satır tazelenmiş (kapasite tüketilmiş)
  // olabilir; bayat bir başlangıç değeri operatörün farkında olmadan tavanı düşürmesine
  // yol açardı.
  React.useEffect(() => {
    if (open) {
      setRemaining(String(row.remainingUses));
      setReason('');
      setError(null);
    }
  }, [open, row.remainingUses]);

  const parsed = Number(remaining);
  const valid = remaining.trim() !== '' && Number.isInteger(parsed) && parsed >= 0;
  const newMax = valid ? row.useCount + parsed : null;
  const unchanged = newMax != null && newMax === row.maxUses;
  const decreasing = newMax != null && newMax < row.maxUses;
  const noun = itemNoun(row.productType);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) {
      setError('Kalan kullanım hakkı 0 veya daha büyük bir tam sayı olmalı.');
      return;
    }
    setError(null);
    setPending(true);
    try {
      const res = await adjustLicenseCapacityAction({
        id: row.id,
        remainingUses: parsed,
        reason,
        productId: row.productId,
      });
      if (res.ok) {
        // Açılan kapasite bekleyen siparişleri HEMEN teslim etmiş olabilir (stok girişiyle aynı
        // tamamlama yolu). Bunu SÖYLEMEK zorunlu: operatör "kapasiteyi açtım, şimdi ne oldu?"
        // sorusunun cevabını başka bir ekrana gidip aramamalı; sessizlik "hiçbir şey olmadı"
        // diye okunur ve gerçekte müşteriye lisans gitmişken bilinmez.
        const parts = [`Kapasite güncellendi: ${res.useCount}/${res.maxUses} · kalan ${res.remainingUses}.`];
        if (res.autoCompleted > 0) {
          parts.push(`Bekleyen ${res.autoCompleted} sipariş satırı bu kapasiteyle teslim edildi.`);
        }
        if (res.autoCompleteQueued) {
          parts.push('Kalan bekleyen satırlar arka planda işleniyor.');
        }
        if (res.autoCompleteFailed) {
          // Kısmi başarı: kapasite YAZILDI ama tarama koşamadı. Sessiz geçilseydi operatör
          // "kapasite açtım, sipariş neden bekliyor?" sorusuyla baş başa kalırdı.
          toast.warning(
            `${parts.join(' ')} Ancak bekleyen sipariş taraması yapılamadı — sipariş satırında ` +
              '“Kalanları Ata” ile sürdürebilirsiniz.',
          );
        } else {
          toast.success(parts.join(' '));
        }
        onOpenChange(false);
        onDone();
      } else {
        setError(res.error);
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Kapasiteyi düzenle</DialogTitle>
          <DialogDescription>
            Çok kullanımlı (MAK) {noun} için kalan kullanım hakkını yeniden ayarlayın —
            tedarikçi ek aktivasyon tanımladığında kullanılır.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <RecordSummary row={row} />

          {/* Mevcut durum: operatör "neyi değiştiriyorum" sorusunu formu terk etmeden yanıtlasın. */}
          <dl className="grid grid-cols-3 gap-2 rounded-lg border border-border bg-muted/30 p-3 text-center">
            <div>
              <dt className="text-xs text-muted-foreground">Kullanılan</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">{row.useCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Kalan</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">
                {row.remainingUses}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Toplam kapasite</dt>
              <dd className="text-sm font-medium tabular-nums text-foreground">{row.maxUses}</dd>
            </div>
          </dl>

          <Field
            label="Yeni kalan kullanım hakkı"
            htmlFor={`cap-${row.id}-remaining`}
            required
            hint={
              newMax == null
                ? 'Tam sayı girin (0 veya daha büyük).'
                : `Yeni toplam kapasite: ${row.useCount} kullanılan + ${parsed} kalan = ${newMax}` +
                  ` (şu an ${row.maxUses}). Kullanılan hak DEĞİŞMEZ — müşterilerin elindeki` +
                  ' aktivasyonları temsil ettiği için asla sıfırlanmaz.'
            }
          >
            <Input
              id={`cap-${row.id}-remaining`}
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              value={remaining}
              onChange={(ev) => setRemaining(ev.target.value)}
              required
              className="font-mono"
            />
          </Field>

          {decreasing && (
            <Alert variant="warning">
              <ShieldAlert aria-hidden />
              <AlertDescription>
                Kapasite <strong>düşürülüyor</strong> ({row.maxUses} → {newMax}). Satılabilir stok
                anında azalır{newMax === row.useCount ? ' ve kalem “Tükendi” durumuna geçer' : ''}.
                Teslim edilmiş aktivasyonlara dokunulmaz.
              </AlertDescription>
            </Alert>
          )}
          {unchanged && (
            <Alert variant="muted">
              <ShieldAlert aria-hidden />
              <AlertDescription>
                Kapasite zaten {row.maxUses} — kaydetmek bir değişiklik yapmaz.
              </AlertDescription>
            </Alert>
          )}

          <Field
            label="Düzeltme sebebi"
            htmlFor={`cap-${row.id}-reason`}
            required
            hint="Denetim kaydına yazılır (ör. 'tedarikçi 100 ek aktivasyon tanımladı')."
          >
            <Textarea
              id={`cap-${row.id}-reason`}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              required
              minLength={3}
              maxLength={500}
              rows={3}
            />
          </Field>

          {error && (
            <Alert variant="destructive">
              <ShieldAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Vazgeç
            </Button>
            <Button type="submit" disabled={pending || !valid || unchanged}>
              <Gauge aria-hidden /> {pending ? 'Kaydediliyor…' : 'Kapasiteyi kaydet'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/*
 * TAŞINDI: `RotateCredentialsButton` + `RotateCredentialsSheet` ("Kimlik bilgilerini güncelle").
 *
 * KULLANICI KARARI: müşterinin elindeki bir lisansa dokunan HER işlem siparişin İÇİNDE
 * olmalı. Form kopyalanmadı, `components/rotate-credentials-control.tsx` dosyasına TAŞINDI
 * ve sipariş detayındaki atama satırından çağrılıyor. Buradan izsiz kaldırılmadı: teslim
 * edilmiş satırın "Siparişe git" ipucu hesap ürününde artık bu işlemi de sayıyor.
 */

/**
 * Sheet başlığının altındaki salt-okunur "hangi kayıt" özeti (yanlış satırda işlem yapmayı
 * önler). GÖRÜNÜM tek kaynaktan (`components/rotate-credentials-control.tsx`) gelir; burada
 * yalnız envanter satırından önizleme türetilir — iki ekranda iki farklı özet kutusu olmasın.
 *
 * ÖNİZLEME SIR GÖSTERMEZ: hesap ürününde yalnız secret-OLMAYAN ilk alan basılır.
 */
function RecordSummary({ row }: { row: LicenseInventoryRow }) {
  const preview =
    row.kind === 'account'
      ? ((row.fields ?? []).find((f) => !f.secret)?.value ?? null)
      : row.value;
  return (
    <SharedRecordSummary
      productName={row.productName}
      productSku={row.productSku}
      preview={preview}
    />
  );
}

/** Düzenleme formunda tek bir hesap alanı (şema tanımı + mevcut değer birleşimi). */
interface EditableField {
  key: string;
  label: string;
  value: string;
  secret: boolean;
  required: boolean;
}

/** "Değiştir" — key ürününde tek değer, hesap ürününde şema alanları (mevcut değerlerle dolu). */
function EditLicenseSheet({
  row,
  payloadSchema,
  open,
  onOpenChange,
  onDone,
}: {
  row: LicenseInventoryRow;
  payloadSchema?: PayloadFieldDef[] | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);
  const isAccount = row.kind === 'account';

  /**
   * Form alanları: şema BİLİNİYORSA şema sırası esas alınır (boş bırakılmış opsiyonel alan
   * da görünür, sonradan doldurulabilir); bilinmiyorsa (global liste) API'den gelen DOLU
   * alanlar kullanılır. Değerler her iki durumda da mevcut kayıttan gelir.
   */
  const formFields = React.useMemo<EditableField[]>(() => {
    const existing = new Map((row.fields ?? []).map((f) => [f.key, f] as const));
    if (payloadSchema && payloadSchema.length > 0) {
      return payloadSchema.map((def) => ({
        key: def.key,
        label: def.label,
        secret: def.secret,
        required: def.required,
        value: existing.get(def.key)?.value ?? '',
      }));
    }
    return (row.fields ?? []).map((f) => ({
      key: f.key,
      label: f.label,
      secret: f.secret,
      required: false,
      value: f.value,
    }));
  }, [row.fields, payloadSchema]);

  // Hesap alanları hiç çözülemediyse (bozuk kayıt + şema yok) düzenleme yapılamaz.
  const unreadable = isAccount && formFields.length === 0;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const reason = String(fd.get('reason') ?? '').trim();
    if (!reason) {
      setError('Değişiklik sebebi zorunludur.');
      return;
    }
    let payload: { value?: string; fields?: Record<string, string> };
    if (isAccount) {
      const fields: Record<string, string> = {};
      for (const f of formFields) fields[f.key] = String(fd.get(`field_${f.key}`) ?? '');
      payload = { fields };
    } else {
      const value = String(fd.get('value') ?? '').trim();
      if (!value) {
        setError('Yeni lisans değeri zorunludur.');
        return;
      }
      payload = { value };
    }
    setError(null);
    startTransition(async () => {
      const res = await updateLicenseItemAction({
        id: row.id,
        productId: row.productId,
        reason,
        ...payload,
      });
      if (res.ok) {
        onOpenChange(false);
        onDone();
      } else {
        setError(res.error ?? 'İşlem başarısız.');
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Lisansı değiştir</SheetTitle>
          <SheetDescription>
            Yanlış veya bozuk girilmiş bir kaydı düzeltin. Yeni değer şifrelenerek saklanır ve
            işlem sebebiyle birlikte denetim kaydına yazılır.
          </SheetDescription>
        </SheetHeader>

        {/* key={open}: her açılışta alanlar mevcut değerlerle temiz başlar. */}
        <form key={String(open)} onSubmit={submit} className="space-y-4 p-4 pt-0">
          <RecordSummary row={row} />

          {unreadable ? (
            <Alert variant="warning">
              <ShieldAlert aria-hidden />
              <AlertDescription>
                Bu hesabın alanları okunamadı, bu yüzden düzenlenemez. Kaydı geçersiz kılıp yerine
                yeni bir kayıt girin.
              </AlertDescription>
            </Alert>
          ) : isAccount ? (
            <div className="space-y-3">
              {formFields.map((f) => (
                <Field
                  key={f.key}
                  label={f.label}
                  htmlFor={`edit-${row.id}-${f.key}`}
                  required={f.required}
                  hint={f.secret ? 'Gizli alan (parola vb.) — açık yazılır.' : undefined}
                >
                  <Input
                    id={`edit-${row.id}-${f.key}`}
                    name={`field_${f.key}`}
                    defaultValue={f.value}
                    required={f.required}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                </Field>
              ))}
            </div>
          ) : (
            <Field
              label="Yeni lisans değeri"
              htmlFor={`edit-${row.id}-value`}
              hint="Ürünün anahtar biçimi (key_format) tanımlıysa yeni değer ona uymalıdır."
              required
            >
              <Textarea
                id={`edit-${row.id}-value`}
                name="value"
                defaultValue={row.value ?? ''}
                required
                autoComplete="off"
                spellCheck={false}
                className="min-h-20 font-mono"
              />
            </Field>
          )}

          <Field
            label="Değişiklik sebebi"
            htmlFor={`edit-${row.id}-reason`}
            hint="Denetim kaydına yazılır (ör. 'tedarikçi yanlış anahtar gönderdi')."
            required
          >
            <Input id={`edit-${row.id}-reason`} name="reason" maxLength={500} required />
          </Field>

          {error && (
            <Alert variant="destructive">
              <ShieldAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" disabled={pending || unreadable}>
              <Pencil aria-hidden /> {pending ? 'Kaydediliyor…' : 'Değişikliği kaydet'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/** "Sil" — aslında geçersiz kılma (kayıt izlenebilirlik için durur). Sebep zorunlu. */
function VoidLicenseSheet({
  row,
  open,
  onOpenChange,
  onDone,
}: {
  row: LicenseInventoryRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, startTransition] = React.useTransition();
  const [error, setError] = React.useState<string | null>(null);

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const reason = String(new FormData(e.currentTarget).get('reason') ?? '').trim();
    if (!reason) {
      setError('İptal sebebi zorunludur.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await voidLicenseItemAction({ id: row.id, productId: row.productId, reason });
      if (res.ok) {
        onOpenChange(false);
        onDone();
      } else {
        setError(res.error ?? 'İşlem başarısız.');
      }
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Lisansı geçersiz kıl</SheetTitle>
          <SheetDescription>
            {row.usageMode === 'multi'
              ? `“${row.productName}” ürününde bu kalemin kalan ${row.remainingUses} kullanım hakkı stoktan düşürülecek.`
              : `“${row.productName}” ürününden 1 lisans kalemi stoktan düşürülecek.`}{' '}
            Bu işlem geri alınamaz.
          </SheetDescription>
        </SheetHeader>

        <form key={String(open)} onSubmit={submit} className="space-y-4 p-4 pt-0">
          <RecordSummary row={row} />

          <Alert variant="warning">
            <ShieldAlert aria-hidden />
            <AlertDescription>
              Kayıt veritabanından <strong>silinmez</strong>: izlenebilirlik için
              &quot;Geçersiz kılındı&quot; durumuna geçer, satılabilir stoktan düşer ve
              Kusurlu Stok ekranında sebebiyle görünür.
            </AlertDescription>
          </Alert>

          <Field
            label="İptal sebebi"
            htmlFor={`void-${row.id}-reason`}
            hint="Denetim kaydına ve stok düzeltmesine yazılır (ör. 'anahtar tedarikçide çalışmıyor')."
            required
          >
            <Input id={`void-${row.id}-reason`} name="reason" maxLength={500} required />
          </Field>

          {error && (
            <Alert variant="destructive">
              <ShieldAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <div className="flex items-center gap-2">
            <Button type="submit" variant="danger" disabled={pending}>
              <Ban aria-hidden /> {pending ? 'İşleniyor…' : 'Geçersiz kıl'}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Vazgeç
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}
