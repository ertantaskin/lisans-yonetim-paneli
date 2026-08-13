'use client';
import { useActionState } from 'react';
import { PackageCheck, Save, TriangleAlert, CheckCircle2 } from 'lucide-react';
import {
  receivePurchaseOrderAction,
  updatePurchaseOrderAction,
  type POFormState,
} from '@/app/purchase-orders/actions';
import type { PurchaseOrderRow } from '@/app/purchase-orders/queries';
import { Input, Textarea, selectClass } from './ui/input';
import { Button } from './ui/button';
import { Alert, AlertDescription, AlertTitle } from './ui/alert';
import { Field, FieldRow } from './ui/field';
import { supplyStatusLabel } from '../lib/labels';
import { isAutoReceipt } from '@lisans/shared';

/**
 * useActionState başlangıç durumu — 'use server' dosyasından obje export EDİLEMEZ
 * (Next 15 SWC "can only export async functions, found object" ile action chunk'ını
 * patlatır), bu yüzden tüketici istemci bileşeninde yerel sabit olarak durur.
 */
const initialPOFormState: POFormState = { ok: false };

/** yyyy-mm-dd (input[type=date]) için ISO tarihi kırpar. */
function toDateInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

/** Teslim al — kısmi teslim destekli; parti etiketi zorunlu. */
export function POReceiveForm({ po }: { po: PurchaseOrderRow }) {
  const [state, action, pending] = useActionState(receivePurchaseOrderAction, initialPOFormState);
  const remaining = Math.max(0, po.qtyOrdered - po.qtyReceived);
  const done = remaining === 0;

  if (done) {
    // Stok girişinden otomatik doğan emirlerde qtyOrdered === qtyReceived olduğu için
    // form zaten görünmez; mesajı bağlama uydur ki operatör "neden teslim alamıyorum" demesin.
    const auto = isAutoReceipt(po.notes);
    return (
      <Alert variant="success">
        <CheckCircle2 />
        <div className="min-w-0 flex-1">
          <AlertTitle>{auto ? 'Stok girişiyle teslim alındı' : 'Tamamı teslim alındı'}</AlertTitle>
          <AlertDescription>
            {auto
              ? `Bu emir stok girişinden otomatik oluşturuldu; ${po.qtyReceived} adet zaten teslim alındı ve partiye bağlandı.`
              : `${po.qtyReceived}/${po.qtyOrdered} adet teslim alındı.`}
          </AlertDescription>
        </div>
      </Alert>
    );
  }

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="id" value={po.id} />
      <p className="text-xs text-muted-foreground">
        Kalan: <span className="font-medium tabular-nums text-foreground">{remaining}</span> adet.
        Teslim alınca yeni parti oluşur; anahtarların kendisi ayrıca &quot;Stok Girişi&quot; ekranından
        girilir (orada tedarikçi/tarih/maliyet vererek partiyi tek adımda da oluşturabilirsiniz).
      </p>
      <FieldRow>
        <Field
          label="Teslim adedi"
          htmlFor="rc-qty"
          required
          hint={`Bu teslimatta gelen adet. En fazla ${remaining} (kalan).`}
        >
          <Input
            id="rc-qty"
            name="qty"
            type="number"
            min={1}
            max={remaining}
            step={1}
            defaultValue={remaining}
            required
          />
        </Field>
        <Field
          label="Parti etiketi"
          htmlFor="rc-label"
          required
          hint="Bu teslimatla oluşacak partinin adı — geri çekme/izleme için. Ör. 2026-07-A."
        >
          <Input id="rc-label" name="batchLabel" placeholder="ör. 2026-07-A" required />
        </Field>
      </FieldRow>
      <Field label="Not (opsiyonel)" htmlFor="rc-notes" hint="Teslimatla ilgili serbest açıklama.">
        <Textarea id="rc-notes" name="notes" rows={2} className="max-w-lg" />
      </Field>
      <Button type="submit" disabled={pending}>
        <PackageCheck /> {pending ? 'İşleniyor…' : 'Teslim Al'}
      </Button>
      {state.error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <div className="min-w-0 flex-1">
            <AlertTitle>Teslim alınamadı</AlertTitle>
            <AlertDescription>{state.error}</AlertDescription>
          </div>
        </Alert>
      )}
    </form>
  );
}

/** Emir güncelle — durum/ETA/not. */
export function POUpdateForm({ po }: { po: PurchaseOrderRow }) {
  const [state, action, pending] = useActionState(updatePurchaseOrderAction, initialPOFormState);

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="id" value={po.id} />
      <FieldRow>
        <Field label="Durum" htmlFor="up-status" hint="Satın alma emrinin güncel aşaması.">
          <select id="up-status" name="status" defaultValue={po.status} className={selectClass}>
            <option value="draft">{supplyStatusLabel('draft')}</option>
            <option value="ordered">{supplyStatusLabel('ordered')}</option>
            <option value="partial">{supplyStatusLabel('partial')}</option>
            <option value="received">{supplyStatusLabel('received')}</option>
            <option value="cancelled">{supplyStatusLabel('cancelled')}</option>
          </select>
        </Field>
        <Field label="Tahmini teslim tarihi (ETA)" htmlFor="up-eta" hint="Tedarikçinin öngördüğü teslim tarihi.">
          <Input id="up-eta" name="eta" type="date" defaultValue={toDateInput(po.eta)} />
        </Field>
      </FieldRow>
      <Field label="Not" htmlFor="up-notes" hint="Emirle ilgili serbest açıklama.">
        <Textarea id="up-notes" name="notes" defaultValue={po.notes ?? ''} rows={2} className="max-w-lg" />
      </Field>
      <Button type="submit" variant="outline" disabled={pending}>
        <Save /> {pending ? 'Kaydediliyor…' : 'Güncelle'}
      </Button>
      {state.error && <p className="text-sm text-destructive">{state.error}</p>}
    </form>
  );
}
