'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { rotateAccountCredentialsAction } from '../app/stock/license-actions';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { Field } from './ui/field';
import { Input, Textarea } from './ui/input';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip';
import type { PayloadFieldDef } from '../lib/api';

/**
 * "Kimlik bilgilerini güncelle" — sipariş detayındaki canlı HESAP lisansı için.
 *
 * ── NE İŞE YARAR ──
 * Sağlayıcı bir HESAP ürününün parolasını döndürdüğünde müşterinin elindeki AYNI hesabın
 * bilgilerini YERİNDE tazeler (`POST /v1/admin/license-items/:id/rotate-credentials`).
 * Kalem, atama ve sipariş DEĞİŞMEZ — yalnız şifreli payload yeniden yazılır.
 *
 * ── NEDEN "DEĞİŞTİR" BUNUN YERİNE GEÇMEZ ──
 * Hesap ürününde "Değiştir" (replace) müşteriye BAŞKA bir hesap verir: eski hesap müşterinin
 * elinde ÇALIŞMAYA DEVAM eder (bilgileri çoktan kopyalamıştır) ve müşterinin o hesapta
 * biriktirdiği veri kaybolur. İkisi farklı işlerdir; biri diğerinin yerine konamaz.
 *
 * ── NEDEN ENVANTERDE DEĞİL, BURADA (kullanıcı kararı) ──
 * "Müşterinin lisansını yenilemem/değiştirebilmem sadece o siparişin içinde olmalı."
 * Envanterin işi stoktakileri GÖRMEK ve YANLIŞ GİRİLMİŞ (henüz teslim edilmemiş) kaydı
 * düzeltmektir; müşteride CANLI bir lisansa dokunmak sipariş bağlamı ister. Bu yüzden form
 * envanterden alındı ve sipariş detayına taşındı.
 *
 * ── NEDEN AYRI, PAYLAŞILABİLİR DOSYA (ikinci uygulama YAZILMADI) ──
 * Form kopyalanmadı, TAŞINDI. Aynı formun iki kopyası bu projede tekrarlayan bir hata
 * sınıfıdır (maskeli-değer kapısı, zorunlu sebep, owner kapısı ve "müşteri yeni bilgileri
 * otomatik görmez" uyarısı bir kopyada güncellenip diğerinde unutulur). Dosya `components/`
 * kökünde durur (kardeşi `assignment-license-cell.tsx` gibi ekranlar-arası bir parçadır) ve
 * `RecordSummary` envanterdeki düzenle/geçersiz-kıl formlarıyla PAYLAŞILIR — o özet de iki
 * ekranda ayrışmasın.
 *
 * ── YETKİ ──
 * OTORİTER kapı sunucudadır (API `OwnerGuard` + `rotateAccountCredentialsAction` içindeki
 * `isOwner()`). Buradaki `ownerBlocked` yalnız ERKEN geri bildirimdir: tıklanıp 403 veren
 * düğme, sebebiyle kapalı sunulandan kötüdür (proje kuralı). Çağıran bayrağı sunucuda
 * `isOwner()` ile türetir ve serileştirilebilir bir boolean olarak geçirir.
 */
export function RotateCredentialsControl({
  target,
  kind,
  ownerBlocked,
  compact = false,
  onDone,
}: {
  target: RotateCredentialsTarget;
  /** Ürün tipi (`account` dışında bu işlem YOKTUR — API de 400 döner). */
  kind: string | null | undefined;
  /** Owner değiliz (erken geri bildirim; otoriter kapı sunucuda). */
  ownerBlocked?: boolean;
  /** Yoğun tablo satırında etiket gizlenir (ikon + aria-label kalır). */
  compact?: boolean;
  /**
   * Başarılı işlemden sonra çağrılır (ör. istemci tablosunu yeniden yükle). Verilmezse
   * `router.refresh()` çalışır — sunucuda render edilen sayfalar (sipariş detayı) için
   * doğru davranış budur: aksiyon `revalidatePath` ile önbelleği bayatlatır, ekranın
   * gerçekten tazelenmesi için istemcinin yeniden istek yapması gerekir.
   */
  onDone?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();

  if (kind !== 'account') return null;

  // Şema ya da kalem kimliği yoksa form kurulamaz (eski API imajı bu alanları göndermez —
  // panel ve API ayrı dağıtılır). Sessizce çalışmayan bir form açmak yerine sebebi yazılır.
  const noSchema = !target.payloadSchema || target.payloadSchema.length === 0;
  const noTarget = !target.licenseItemId;
  const blocked = Boolean(ownerBlocked) || noSchema || noTarget;
  const why = ownerBlocked
    ? 'Kimlik bilgisi güncellemesi owner yetkisi gerektirir.'
    : 'Bu lisansın hesap alan bilgisi yüklenemedi — güncelleme formu kurulamıyor.';
  const label = 'Kimlik bilgilerini güncelle';

  if (blocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Devre dışı düğme pointer olayı üretmez → tooltip için odaklanabilir sarmalayıcı. */}
          <span tabIndex={0} className="inline-flex justify-end rounded-md" title={why}>
            <Button variant="outline" size="sm" disabled aria-label={`${label} — ${why}`}>
              <KeyRound aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{why}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="outline" size="sm" onClick={() => setOpen(true)} aria-label={label}>
            <KeyRound aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent className="max-w-72">
          Sağlayıcıda parola değiştiyse AYNI hesabı güncelle (müşteriye başka hesap verilmez).
        </TooltipContent>
      </Tooltip>
      <RotateCredentialsSheet
        target={target}
        open={open}
        onOpenChange={setOpen}
        onDone={onDone ?? (() => router.refresh())}
      />
    </>
  );
}

/**
 * Formun hedefi — ekranlardan BAĞIMSIZ en küçük şekil.
 *
 * Envanterin `LicenseInventoryRow`'u ya da siparişin `Assignment`ı doğrudan alınmadı: iki
 * ekranın satır tipleri birbirinden habersiz gelişir ve biri diğerinin alanını taşımaz
 * (sipariş detayında `productSku` yok, envanterde `assignmentId` yok). Çağıran kendi
 * satırından bu dört alanı türetir.
 */
export interface RotateCredentialsTarget {
  /** `license_items.id` — rotasyon ucu BUNU adresler (atama kimliği DEĞİL). */
  licenseItemId: string;
  productName: string;
  productSku?: string | null;
  /** Salt-okunur "hangi kayıt" önizlemesi — SIR GÖSTERMEZ (yalnız secret-olmayan bir alan). */
  preview?: string | null;
  /** Ürünün hesap alan şeması; yoksa düğme sebebiyle kapalı sunulur. */
  payloadSchema?: PayloadFieldDef[] | null;
  /** Ürün detayının tazelenmesi için (opsiyonel). */
  productId?: string;
  /** Sipariş detayının tazelenmesi için (opsiyonel) — siparişten çağrıldığında verilir. */
  orderId?: string;
}

/** Kimlik bilgisi güncelleme formu — şema alanları + zorunlu sebep. */
function RotateCredentialsSheet({
  target,
  open,
  onOpenChange,
  onDone,
}: {
  target: RotateCredentialsTarget;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState('');
  const schema = target.payloadSchema ?? [];

  // Açılışta alanları SIFIRDAN başlat: mevcut değerlerle ön-doldurmak owner-olmayan görünümde
  // maske metnini forma taşırdı (sunucu bunu 400'ler ama kullanıcıyı hataya sürüklemenin anlamı
  // yok) ve owner'da da "değişmedi sanılan" alanın sessizce eski değerle yazılmasına yol açardı.
  React.useEffect(() => {
    if (open) {
      setValues({});
      setReason('');
      setError(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await rotateAccountCredentialsAction({
        id: target.licenseItemId,
        fields: values,
        reason,
        productId: target.productId,
        orderId: target.orderId,
      });
      if (res.ok) {
        const n = res.orderIds?.length ?? 0;
        toast.success(
          n > 0
            ? `Kimlik bilgileri güncellendi. Müşteriye yeni bilgileri iletmek için ${n} siparişin teslimat mailini yeniden gönderin.`
            : 'Kimlik bilgileri güncellendi.',
        );
        onOpenChange(false);
        onDone();
      } else {
        setError(res.error ?? 'İşlem başarısız.');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Kimlik bilgilerini güncelle</SheetTitle>
          <SheetDescription>
            Müşterinin elindeki AYNI hesap güncellenir — başka bir hesap atanmaz, atama ve
            sipariş değişmez. Sağlayıcıda parola döndüğünde kullanın.
          </SheetDescription>
        </SheetHeader>
        <form onSubmit={submit} className="space-y-4 p-4 pt-0">
          <RecordSummary
            productName={target.productName}
            productSku={target.productSku}
            preview={target.preview}
          />
          <Alert>
            <ShieldAlert aria-hidden />
            <AlertDescription>
              Müşteri yeni bilgileri OTOMATİK görmez — güncelleme sonrası siparişin teslimat
              mailini yeniden göndermeniz gerekir.
            </AlertDescription>
          </Alert>
          {schema.map((f) => (
            <Field
              key={f.key}
              label={f.label || f.key}
              htmlFor={`rot-${target.licenseItemId}-${f.key}`}
              hint={f.secret ? 'Gizli alan — tam değeri girin.' : undefined}
            >
              <Input
                id={`rot-${target.licenseItemId}-${f.key}`}
                value={values[f.key] ?? ''}
                onChange={(ev) => setValues((v) => ({ ...v, [f.key]: ev.target.value }))}
                required={f.required}
                autoComplete="off"
              />
            </Field>
          ))}
          <Field
            label="Güncelleme sebebi"
            htmlFor={`rot-reason-${target.licenseItemId}`}
            hint="Denetim kaydına ve siparişin zaman çizelgesine yazılır."
          >
            <Textarea
              id={`rot-reason-${target.licenseItemId}`}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              required
              minLength={3}
              rows={3}
            />
          </Field>
          {error && (
            <Alert variant="destructive">
              <ShieldAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? 'Güncelleniyor…' : 'Güncelle'}
          </Button>
        </form>
      </SheetContent>
    </Sheet>
  );
}

/**
 * Sheet başlığının altındaki salt-okunur "hangi kayıt" özeti (yanlış satırda işlem yapmayı
 * önler). Envanterdeki düzenle/geçersiz-kıl formları da bu bileşeni kullanır → tek görünüm.
 */
export function RecordSummary({
  productName,
  productSku,
  preview,
}: {
  productName: string;
  productSku?: string | null;
  preview?: string | null;
}) {
  const text = preview || '—';
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div>
        <div className="text-xs text-muted-foreground">Ürün</div>
        <div className="text-sm font-medium text-foreground">{productName}</div>
        {productSku && <div className="font-mono text-xs text-muted-foreground">{productSku}</div>}
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Mevcut kayıt</div>
        <div className="break-all font-mono text-xs text-foreground/80" title={text}>
          {text}
        </div>
      </div>
    </div>
  );
}
