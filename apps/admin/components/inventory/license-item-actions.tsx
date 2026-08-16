'use client';
import * as React from 'react';
import { Ban, KeyRound, Pencil, RefreshCw, ShieldAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  replaceDeliveredLicenseAction,
  rotateAccountCredentialsAction,
  updateLicenseItemAction,
  voidLicenseItemAction,
  type LicenseInventoryRow,
} from '../../app/stock/license-actions';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
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
import { useConfirm } from '../ui/confirm';
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
        `Bu ${itemNoun(row.productType)} müşteride. İçeriğini düzenlemek yerine "Yenisiyle` +
        ` değiştir" ile taze bir kalem atayın (eskisi karantinaya gider, denetim izi kalır).`,
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
 * Lisans envanteri satır aksiyonları: **Değiştir** (payload düzeltme) ve **Sil**
 * (aslında GEÇERSİZ KILMA — kayıt izlenebilirlik için durur, stoktan düşer).
 * Her ikisi de sebep ZORUNLU; API hatası (ör. 409 "teslim edilmiş") AYNEN gösterilir.
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
   * Değerler MASKELİ mi (owner DEĞİLİZ)? Teslim edilmiş hesabın kimlik bilgisi güncellemesi
   * owner-only'dir; maskeli görüntüde operatör zaten tam değerleri BİLMEZ, dolayısıyla düğme
   * sebebiyle kapalı sunulur (tıklanıp 403 veren düğme, hiç sunulmayandan kötüdür).
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
  const { editable, reason: lockReason } = editability(row);

  // MÜŞTERİDEKİ ANAHTAR → tek anlamlı işlem "yenisiyle değiştir" (§4 proaktif değişim).
  // Bu dal ÖNCE gelir: geri çekilmiş bir partide operatör satır satır karar verirken
  // devre dışı iki düğme yerine yapılabilecek TEK işlemi görmeli.
  if (row.delivered && LIVE_ASSIGNMENT.has(row.delivered.assignmentStatus)) {
    return (
      <ReplaceDeliveredButton
        row={row}
        onDone={onDone}
        compact={compact}
        payloadSchema={payloadSchema}
        masked={masked}
      />
    );
  }

  if (!editable) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Devre dışı düğme pointer olayı üretmez → tooltip için odaklanabilir sarmalayıcı. */}
          <span
            tabIndex={0}
            className="inline-flex items-center justify-end gap-1.5 rounded-md"
            title={lockReason}
          >
            <Button variant="outline" size="sm" disabled aria-label={`Değiştir — ${lockReason}`}>
              <Pencil aria-hidden /> <span className={compact ? "sr-only" : undefined}>Değiştir</span>
            </Button>
            <Button
              variant="danger-outline"
              size="sm"
              disabled
              aria-label={`Sil — ${lockReason}`}
            >
              <Trash2 aria-hidden /> <span className={compact ? "sr-only" : undefined}>Sil</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-64">{lockReason}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <div className="flex items-center justify-end gap-1.5">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setEditOpen(true)}
        aria-label={`${row.productName} lisansını değiştir`}
      >
        <Pencil aria-hidden /> <span className={compact ? "sr-only" : undefined}>Değiştir</span>
      </Button>
      <Button
        variant="danger-outline"
        size="sm"
        onClick={() => setVoidOpen(true)}
        aria-label={`${row.productName} lisansını geçersiz kıl`}
      >
        <Trash2 aria-hidden /> <span className={compact ? "sr-only" : undefined}>Sil</span>
      </Button>

      <EditLicenseSheet
        row={row}
        payloadSchema={payloadSchema}
        open={editOpen}
        onOpenChange={setEditOpen}
        onDone={onDone}
      />
      <VoidLicenseSheet row={row} open={voidOpen} onOpenChange={setVoidOpen} onDone={onDone} />
    </div>
  );
}

/**
 * "Yeni anahtarla değiştir" — MÜŞTERİDEKİ bir anahtar için tek satırlık proaktif değişim.
 *
 * NEDEN BURADA (kullanıcı ihtiyacı): tedarikçi partisi geri çekildiğinde stoktakiler geçersiz
 * kılınır, müşterilerdekilere DOKUNULMAZ — bir kısmı çalışıyor olabilir. Operatör "hangileri
 * hâlâ müşterilerde" listesini süzüp SATIR SATIR karar vermek ister. Eskiden bunun tek yolu
 * her anahtar için ilgili siparişi ayrı ayrı açmaktı.
 *
 * İŞ KURALI BURADA DEĞİL: aksiyon mevcut `POST /v1/admin/assignments/:id/replace` ucunu
 * çağırır (sipariş detayındaki düğmeyle AYNI uç) — stok ön-kontrolü, tek transaction
 * (yeni anahtar açılamazsa rollback ⇒ eski anahtar CANLI kalır), eski anahtar karantinaya,
 * soyağacı `assignment_history`'ye. MAK/çok-kullanımlı üründe API 400 döner; düğme burada
 * da kapatılır (iki katman) çünkü aynı paylaşımlı anahtarı yeniden atamak anlamsızdır.
 */
function ReplaceDeliveredButton({
  compact = false,
  row,
  onDone,
  payloadSchema,
  masked,
}: {
  row: LicenseInventoryRow;
  onDone: () => void;
  /** Tabloda etiketler gizlenir (ikon + aria-label kalır) — bkz. LicenseItemActions. */
  compact?: boolean;
  payloadSchema?: PayloadFieldDef[] | null;
  masked?: boolean;
}) {
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = React.useState(false);
  const [rotateOpen, setRotateOpen] = React.useState(false);
  const d = row.delivered!;
  const isMulti = row.usageMode === 'multi';
  // API `replaceAssignment` YALNIZ aktif atamayı kabul eder (askıdakini 400 ile reddeder —
  // askıyı operatör bilerek koymuştur, değişim onu sessizce geri açardı). Düğmeyi burada da
  // kapat: tıklanıp hata veren bir düğme, hiç sunulmayandan daha kötüdür.
  const isSuspended = d.assignmentStatus === 'suspended';
  /** Metinlerde ürün tipine göre doğru ad: anahtar / hesap / kod (bilinmiyorsa 'kalem'). */
  const noun = itemNoun(row.productType);

  const run = async () => {
    const res = await confirm({
      title: `Bu ${noun} yenisiyle değiştirilsin mi?`,
      // "BAŞKA bir partiden" GARANTİSİ YOK — kaldırıldı. Atama motoru (assignment/assign.ts)
      // parti farkında DEĞİLDİR: aday sıralaması `expires_at → created_at → seq`, yani aynı
      // içe aktarımdan gelen KOMŞU anahtar büyük olasılıkla seçilir. Kusurlu bir partide bu
      // cümle operatöre "sorun kaynağından uzaklaşıyorum" dedirtiyordu; gerçekte aynı partiden
      // ikinci bir kusurlu kalem gidebilir. (Parti geri çekilmişse o partinin stoğu void
      // edildiği için seçilemez — bu yüzden `batches-table` içindeki aynı cümle DOĞRUDUR.)
      description:
        `Müşteriye stoktaki uygun ilk ${noun} atanır; şu anki kayıt karantinaya alınır` +
        ' ve bir daha satılmaz. Uygun stok yoksa işlem yapılmaz — müşteri boşta kalmaz.' +
        ' Sorun partiden geliyorsa önce partiyi geri çekin: aksi hâlde aynı partiden başka bir' +
        ` ${noun} atanabilir.`,
      details: [
        `Sipariş ${d.remoteOrderId} · ${d.customerEmail}`,
        `Ürün: ${row.productName}`,
        `Müşteri değişimden hemen sonra yeni ${noun} bilgisini görür.`,
      ],
      tone: 'danger',
      confirmLabel: 'Değiştir',
      reason: {
        label: 'Değişim sebebi',
        placeholder: 'ör. geri çekilen partiden geldi, müşteri "çalışmıyor" bildirdi',
        required: true,
        minLength: 3,
        inputType: 'textarea',
        hint: 'Denetim kaydına ve değişim geçmişine yazılır.',
      },
    });
    if (!res) return;

    setBusy(true);
    try {
      const out = await replaceDeliveredLicenseAction({
        assignmentId: d.assignmentId,
        reason: res.reason,
        productId: row.productId,
        orderId: d.orderId,
      });
      if (out.ok) {
        toast.success(out.message);
        onDone();
      } else {
        // API'nin gerçek mesajı gösterilir ("stok yok" ile "şu an atanamadı" ayrımı dahil).
        toast.error(out.error);
      }
    } finally {
      setBusy(false);
    }
  };

  if (isMulti || isSuspended) {
    const why = isSuspended
      ? 'Bu atama askıya alınmış. Değişim yalnız AKTİF atamada yapılır — önce siparişten' +
        ' "Geri aç" deyin, sonra değiştirin. (Askıyı sessizce kaldırmamak için bilinçli.)'
      : 'Çok kullanımlı (MAK) kalem otomatik değiştirilemez — aynı paylaşımlı kayıt yeniden' +
        ' atanırdı. Siparişten elle işleyin.';
    // "Değiştir" kapalı olsa bile HESAP kaleminde kimlik bilgisi güncellemesi ANLAMLI kalır
    // (askıdaki atamada da, MAK'ta da lisans hâlâ müşteridedir) — bu yüzden rotasyon düğmesi
    // bu dalda da sunulur; aksi halde operatörün elinde hiçbir araç kalmazdı.
    return (
      <div className="flex items-center justify-end gap-1.5">
        <RotateCredentialsButton
          row={row}
          payloadSchema={payloadSchema}
          masked={masked}
          compact={compact}
          onOpen={() => setRotateOpen(true)}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex justify-end rounded-md" title={why}>
              <Button variant="outline" size="sm" disabled aria-label={`Değiştir — ${why}`}>
                <RefreshCw aria-hidden /> <span className={compact ? "sr-only" : undefined}>Değiştir</span>
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">{why}</TooltipContent>
        </Tooltip>
        <RotateCredentialsSheet
          row={row}
          payloadSchema={payloadSchema}
          open={rotateOpen}
          onOpenChange={setRotateOpen}
          onDone={onDone}
        />
      </div>
    );
  }

  /*
   * `compact` (TABLO) burada da uygulanmak ZORUNDA: etiketli hâli 145px ve tablonun EN SON
   * kolonunda duruyor → 1369px'te tablo kabı 15px aşıyor ve tam da bu düğme kırpılıyordu
   * (ölçüldü; kullanıcı ekran görüntüsüyle bildirdi). Diğer satır eylemleri (Düzenle/Sil)
   * tabloda çoktan ikona indirilmişti, bu düğme atlanmıştı. İkon tek başına "yenisiyle
   * değiştir"i anlatmadığı için compact hâlde ipucu ZORUNLU (devre dışı hâlinde zaten var).
   */
  const label = busy ? 'Değişiyor…' : 'Yenisiyle değiştir';
  const button = (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void run()}
      disabled={busy}
      aria-label={`${d.remoteOrderId} siparişindeki kalemi yenisiyle değiştir`}
      title={compact ? label : undefined}
    >
      <RefreshCw aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
    </Button>
  );

  return (
    <div className="flex items-center justify-end gap-1.5">
      <RotateCredentialsButton
        row={row}
        payloadSchema={payloadSchema}
        masked={masked}
        compact={compact}
        onOpen={() => setRotateOpen(true)}
      />
      {compact ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent>{label}</TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      <RotateCredentialsSheet
        row={row}
        payloadSchema={payloadSchema}
        open={rotateOpen}
        onOpenChange={setRotateOpen}
        onDone={onDone}
      />
      {dialog}
    </div>
  );
}

/**
 * "Kimlik bilgilerini güncelle" düğmesi — YALNIZ teslim edilmiş HESAP kaleminde.
 *
 * NEDEN AYRI BİR EYLEM: hesap ürününde "Yenisiyle değiştir" YANLIŞ araçtır. Müşteriye BAŞKA
 * bir hesap verir; eski hesap müşterinin elinde ÇALIŞMAYA DEVAM eder (kimlik bilgilerini zaten
 * kopyalamıştır) ve müşterinin o hesapta biriktirdiği veri kaybolur. Sağlayıcı parolayı
 * döndürdüğünde doğru işlem AYNI hesabı güncellemektir — panelde bunun aracı yoktu.
 */
function RotateCredentialsButton({
  row,
  payloadSchema,
  masked,
  compact,
  onOpen,
}: {
  row: LicenseInventoryRow;
  payloadSchema?: PayloadFieldDef[] | null;
  masked?: boolean;
  compact: boolean;
  onOpen: () => void;
}) {
  if (row.kind !== 'account') return null;
  // Şema bilinmiyorsa (global envanter listesi) form alanları kurulamaz → ürün detayına yönlendir.
  const noSchema = !payloadSchema || payloadSchema.length === 0;
  const blocked = masked || noSchema;
  const why = masked
    ? 'Kimlik bilgisi güncellemesi owner yetkisi gerektirir (değerler size maskeli gösteriliyor).'
    : 'Alan şeması bu listede bilinmiyor — ürün detayındaki envanter sekmesinden yapın.';
  const label = 'Kimlik bilgilerini güncelle';

  if (blocked) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0} className="inline-flex justify-end rounded-md" title={why}>
            <Button variant="outline" size="sm" disabled aria-label={`${label} — ${why}`}>
              <KeyRound aria-hidden />{' '}
              <span className={compact ? 'sr-only' : undefined}>{label}</span>
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
        <Button variant="outline" size="sm" onClick={onOpen} aria-label={label}>
          <KeyRound aria-hidden /> <span className={compact ? 'sr-only' : undefined}>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-72">
        Sağlayıcıda parola değiştiyse AYNI hesabı güncelle (müşteriye başka hesap verilmez).
      </TooltipContent>
    </Tooltip>
  );
}

/** Kimlik bilgisi güncelleme formu — şema alanları + zorunlu sebep. */
function RotateCredentialsSheet({
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
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [reason, setReason] = React.useState('');
  const schema = payloadSchema ?? [];

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
        id: row.id,
        fields: values,
        reason,
        productId: row.productId,
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
          <RecordSummary row={row} />
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
              htmlFor={`rot-${row.id}-${f.key}`}
              hint={f.secret ? 'Gizli alan — tam değeri girin.' : undefined}
            >
              <Input
                id={`rot-${row.id}-${f.key}`}
                value={values[f.key] ?? ''}
                onChange={(ev) => setValues((v) => ({ ...v, [f.key]: ev.target.value }))}
                required={f.required}
                autoComplete="off"
              />
            </Field>
          ))}
          <Field
            label="Güncelleme sebebi"
            htmlFor={`rot-reason-${row.id}`}
            hint="Denetim kaydına ve siparişin zaman çizelgesine yazılır."
          >
            <Textarea
              id={`rot-reason-${row.id}`}
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

/** Sheet başlığının altındaki salt-okunur "hangi kayıt" özeti (yanlış satırda işlem yapmayı önler). */
function RecordSummary({ row }: { row: LicenseInventoryRow }) {
  const preview =
    row.kind === 'account'
      ? (row.fields ?? []).find((f) => !f.secret)?.value ?? '—'
      : row.value ?? '—';
  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div>
        <div className="text-xs text-muted-foreground">Ürün</div>
        <div className="text-sm font-medium text-foreground">{row.productName}</div>
        <div className="font-mono text-xs text-muted-foreground">{row.productSku}</div>
      </div>
      <div>
        <div className="text-xs text-muted-foreground">Mevcut kayıt</div>
        <div className="break-all font-mono text-xs text-foreground/80" title={preview}>
          {preview}
        </div>
      </div>
    </div>
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
