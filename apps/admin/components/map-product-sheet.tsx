'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, Info, Link2, Replace } from 'lucide-react';
import {
  createMappingAction,
  changeMappingAction,
  type FormState,
} from '../app/stock/actions';
import type { ProductRow } from '../lib/api';
import { useAnnouncer } from './a11y/announcer';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Combobox } from './ui/combobox';
import { Field } from './ui/field';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './ui/sheet';

const initial: FormState = { ok: false };

/**
 * Paylaşılan tek-tıkla eşleme Sheet'i (§3). İKİ mod:
 *  - **create** (varsayılan): mağaza ürününü panel ürününe İLK KEZ eşle ("Eşlenmemiş Gelen Ürünler"
 *    reaktif + "Site Kataloğu" proaktif). Gizli: siteId/remoteProductId/remoteVariationId.
 *  - **edit**: VAR OLAN eşlemenin HEDEF panel ürününü DEĞİŞTİR (remap). Gizli: mappingId. Mağaza
 *    ürünü/site/varyasyon değişmez; yalnız hangi panel ürününün teslim edeceği değişir.
 * Her iki modda da mağaza ürünü + site SALT-OKUNUR gösterilir (operatör NEYİ eşlediğini doğrular),
 * mağaza ID'si gerçek veriden gizli input ile gider — operatör ID YAZMAZ (typo riski yok). Eşleme
 * HER ZAMAN elle; otomatik eşleştirme YOK. Başarıda liste tazelenir (router.refresh) ve sheet
 * içinde SONUÇ ÖZETİ gösterilir (geriye dönük çözülen eski satırlar) — kapatma operatörün elinde.
 */
export function MapProductSheet({
  mode = 'create',
  siteId,
  siteDomain,
  remoteProductId,
  remoteVariationId,
  productName,
  products,
  mappingId,
  currentProductId,
  currentBundleQty,
  triggerLabel,
  triggerVariant,
}: {
  mode?: 'create' | 'edit';
  siteId: string;
  siteDomain: string;
  remoteProductId: string;
  remoteVariationId: string | null;
  /** Mağaza ürününün görünen adı (eşlenmemişte "(ad yok)" olabilir, katalogda gerçek ad). */
  productName: string;
  products: ProductRow[];
  /** edit modunda ZORUNLU: değiştirilecek eşleme kaydının id'si. */
  mappingId?: string;
  /** edit modunda: mevcut hedef panel ürünü (Combobox varsayılanı). */
  currentProductId?: string | null;
  /** edit modunda: mevcut paket adedi. */
  currentBundleQty?: number | null;
  /**
   * Tetikleyici butonun metni/tonu — varyasyonlu ürünün EBEVEYN satırında eşleme VARSAYILAN
   * eylem değildir (varsayılan: varyasyonları eşlemek). O satırda çağıran ikincil bir ton
   * geçirir; verilmezse bugünkü davranış (outline + "Eşle"/"Değiştir") aynen korunur.
   */
  triggerLabel?: string;
  triggerVariant?: 'outline' | 'ghost';
}) {
  const router = useRouter();
  const announce = useAnnouncer();
  const [open, setOpen] = React.useState(false);
  const isEdit = mode === 'edit';
  const [state, action, pending] = React.useActionState(
    isEdit ? changeMappingAction : createMappingAction,
    initial,
  );

  /**
   * Başarıda sheet HEMEN KAPANMAZ (§3, dürüstlük kuralı).
   *
   * NEDEN: `createMappingAction` eşlemeyi kurduktan sonra eski bekleyen satırlara GERİYE DÖNÜK
   * uygular ve sonucu `state.resolved` ile döndürür. Eskiden sheet `state.ok` görür görmez
   * kapanıyor, bu özet hiç okunmuyordu → operatör "eşledim ama sipariş hâlâ bekliyor" durumunda
   * ne olduğunu göremiyordu. Artık sonuç sheet içinde gösterilir; kapatma operatörün elindedir.
   * Liste yine hemen tazelenir (router.refresh) — arkadaki tablo güncel kalır.
   *
   * `result` AYRI tutulur (state.ok'a doğrudan bakılmaz): sheet kapatılıp yeniden açıldığında
   * bayat başarı paneli değil TEMİZ form görünsün. Effect `state` NESNESİNE bağlıdır — her
   * gönderim yeni nesne döndürür → ardışık gönderimlerde de tetiklenir.
   */
  const [result, setResult] = React.useState<FormState | null>(null);
  React.useEffect(() => {
    if (!state.ok) return;
    setResult(state);
    router.refresh();
    const r = state.resolved;
    announce(
      r
        ? `Eşleme kuruldu. ${r.linked} eski satır bağlandı, ${r.delivered} teslim edildi, ${r.stillPending} satır stok bekliyor.`
        : isEdit
          ? 'Eşleme güncellendi.'
          : 'Eşleme kuruldu; geriye dönük çözülecek bekleyen satır yoktu.',
    );
  }, [state, isEdit, router, announce]);

  // site+ürün+varyasyon → benzersiz; colon vb. HTML id/htmlFor için sadeleştirilir
  // (etiket–kontrol bağı bozulmasın).
  const uid = `${siteId}:${remoteProductId}:${remoteVariationId ?? ''}`.replace(
    /[^a-zA-Z0-9]/g,
    '-',
  );

  return (
    <Sheet
      open={open}
      onOpenChange={(v) => {
        // Yeniden açılışta bayat başarı paneli kalmasın → temiz formla başla.
        if (v) setResult(null);
        setOpen(v);
      }}
    >
      <SheetTrigger asChild>
        <Button
          size="sm"
          variant={triggerVariant ?? 'outline'}
          aria-label={
            isEdit
              ? `${productName} eşlemesini başka panel ürünüyle değiştir`
              : `${productName} mağaza ürününü panel ürününe eşle`
          }
        >
          {isEdit ? <Replace /> : <Link2 />}
          {triggerLabel ?? (isEdit ? 'Değiştir' : 'Eşle')}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{isEdit ? 'Eşlemeyi değiştir' : 'Mağaza ürününü eşle'}</SheetTitle>
          <SheetDescription>
            {isEdit
              ? 'Bu mağaza ürününü artık hangi panel ürünü teslim etsin? Mağaza bilgileri değişmez, yalnız hedef panel ürünü değişir.'
              : 'Bu mağaza ürününü hangi panel ürünü teslim etsin? Mağaza bilgileri gerçek katalog/sipariş verisinden gelir — değiştiremezsiniz.'}
          </SheetDescription>
        </SheetHeader>

        {/* Başarı özeti — form yerine geçer. Eşleme kurulduktan sonra "kaç eski satır bağlandı /
            teslim edildi / hâlâ stok bekliyor" burada raporlanır; hiçbir şey çözülmediyse bu da
            AÇIKÇA yazılır (sessiz kapanış "her şey tamam" izlenimi veriyordu). */}
        {result ? (
          <div className="space-y-4 p-4 pt-0">
            {/* Alert primitifi: tint/yarıçap/gövde rengi tek kaynaktan (elle kopya sapmıştı). */}
            <Alert variant="success" className="gap-2 p-3">
              <CheckCircle2 aria-hidden />
              <div className="min-w-0">
                <p className="font-medium text-foreground">
                  {isEdit ? 'Eşleme güncellendi' : 'Eşleme kuruldu'}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {productName} &rarr; bu mağaza ürününün yeni siparişleri artık seçtiğiniz panel
                  ürününden teslim edilir.
                </p>
              </div>
            </Alert>

            {!isEdit && (
              <Alert variant="muted" className="gap-2 p-3">
                <Info aria-hidden />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">Eski bekleyen satırlar</p>
                  {result.resolved ? (
                    <p className="mt-0.5 text-muted-foreground">
                      <strong className="tabular-nums text-foreground">
                        {result.resolved.linked}
                      </strong>{' '}
                      satır ürüne bağlandı ·{' '}
                      <strong className="tabular-nums text-foreground">
                        {result.resolved.delivered}
                      </strong>{' '}
                      teslim edildi ·{' '}
                      <strong className="tabular-nums text-foreground">
                        {result.resolved.stillPending}
                      </strong>{' '}
                      satır stok bekliyor.
                    </p>
                  ) : (
                    <p className="mt-0.5 text-muted-foreground">
                      Bu mağaza ürünü için geriye dönük çözülecek bekleyen satır yoktu. (Varsa
                      “Eşleme Bekleyen Sipariş Satırları” bölümünden tekrar uygulayabilirsiniz.)
                    </p>
                  )}
                </div>
              </Alert>
            )}

            <Button type="button" onClick={() => setOpen(false)}>
              Kapat
            </Button>
          </div>
        ) : (
        /* key={open}: her açılışta formu (Combobox/adet) temiz başlat. */
        <form key={String(open)} action={action} className="space-y-4 p-4 pt-0">
          {/* SALT-OKUNUR özet — operatör NEYİ eşlediğini doğrular (ekranın asıl değeri). */}
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
            <div>
              <div className="text-xs text-muted-foreground">Mağaza ürünü</div>
              <div className="text-sm font-medium text-foreground">{productName}</div>
              <div className="font-mono text-xs text-muted-foreground">
                #{remoteProductId}
                {remoteVariationId ? ` · varyasyon ${remoteVariationId}` : ''}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Site</div>
              <div className="text-sm text-foreground">{siteDomain}</div>
            </div>
          </div>

          {/* Sabit alanlar — modda göre gizli anahtar. create: gerçek katalog/sipariş verisi;
              edit: değiştirilecek eşleme id'si. Operatör hiçbirini YAZMAZ. */}
          {isEdit ? (
            <input type="hidden" name="mappingId" value={mappingId} />
          ) : (
            <>
              <input type="hidden" name="siteId" value={siteId} />
              <input type="hidden" name="remoteProductId" value={remoteProductId} />
              {remoteVariationId && (
                <input type="hidden" name="remoteVariationId" value={remoteVariationId} />
              )}
            </>
          )}

          <Field
            label={isEdit ? 'Yeni panel ürünü' : 'Panel ürünü'}
            htmlFor={`map-product-${uid}`}
            hint="Bu mağaza ürününü teslim edecek panel ürünü. Ada veya SKU'ya göre arayın."
            required
          >
            <Combobox
              id={`map-product-${uid}`}
              name="productId"
              required
              defaultValue={isEdit ? (currentProductId ?? '') : ''}
              ariaLabel={isEdit ? 'Yeni panel ürünü' : 'Panel ürünü'}
              items={products.map((p) => ({
                value: p.id,
                label: p.name,
                hint: p.sku,
                keywords: [p.sku],
              }))}
              placeholder="— ürün seçin —"
              searchPlaceholder="Ürün adı veya SKU…"
              emptyText="Ürün bulunamadı"
            />
          </Field>

          <Field
            label="Paket adedi"
            htmlFor={`map-bundle-${uid}`}
            hint="1 mağaza siparişi kaç lisans teslim etsin (varsayılan 1)."
          >
            <Input
              id={`map-bundle-${uid}`}
              name="bundleQty"
              type="number"
              min={1}
              defaultValue={currentBundleQty && currentBundleQty > 0 ? currentBundleQty : 1}
              className="w-40"
            />
          </Field>

          {state.error && (
            <p role="alert" className="text-sm text-destructive">
              {state.error}
            </p>
          )}

          <Button type="submit" disabled={pending}>
            {isEdit ? <Replace /> : <Link2 />}{' '}
            {pending ? 'Kaydediliyor…' : isEdit ? 'Değişikliği kaydet' : 'Eşle'}
          </Button>
        </form>
        )}
      </SheetContent>
    </Sheet>
  );
}
