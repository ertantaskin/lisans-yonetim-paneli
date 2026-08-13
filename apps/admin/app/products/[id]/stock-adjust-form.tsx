'use client';
import { useActionState } from 'react';
import { Info, Plus, TriangleAlert } from 'lucide-react';
import { createStockAdjustmentAction, type StockAdjustState } from './actions';
import { Input, Textarea, selectClass } from '../../../components/ui/input';
import { Button } from '../../../components/ui/button';
import { Field } from '../../../components/ui/field';
import { adjustmentActionLabel } from '../../../lib/labels';

// Başlangıç durumu istemcide (server-action dosyası yalnız async fonksiyon export edebilir).
const initialStockAdjustState: StockAdjustState = { ok: false };

/**
 * DEFTER KAYDI formu (§12) — "Düzeltme" / "Geri çekme notu".
 *
 * MİMARİ (kullanıcı geri bildirimiyle değişti): "Geçersiz kıl / Hasarlı" ARTIK BURADA DEĞİL.
 * Eskiden bu form bir combobox'tan TEK bir lisans seçtiriyordu; bozuk bir tedarikçi partisi
 * geldiğinde 40 anahtarı tek tek seçmek gerekiyordu — operasyonel olarak kullanılamazdı.
 * Doğru yer, kalemlerin zaten listelendiği ve süzülebildiği yer: **Lisans envanteri tablosu**
 * (aşağıdaki "Envanter" sekmesi) — satırları işaretle, tek sebeple topluca düş.
 *
 * Burada yalnız KALEM-KAPSAMSIZ kayıtlar kalır: satılabilir stoğu değiştirmeyen, yalnız
 * denetim defterine düşen notlar. Alan sayısı üçe indi (tür + adet + sebep).
 */
export function StockAdjustForm({ productId }: { productId: string }) {
  const [state, action, pending] = useActionState(
    createStockAdjustmentAction,
    initialStockAdjustState,
  );

  return (
    <form action={action} className="space-y-3 text-sm">
      <input type="hidden" name="productId" value={productId} />

      <div className="flex flex-wrap gap-3">
        <Field
          label="Kayıt türü"
          htmlFor="adj-action"
          hint="Yalnız defter kaydı — satılabilir stok değişmez."
        >
          <select id="adj-action" name="action" defaultValue="correct" className={`${selectClass} w-44`}>
            <option value="correct">{adjustmentActionLabel('correct')}</option>
            <option value="recall">{adjustmentActionLabel('recall')}</option>
          </select>
        </Field>
        <Field label="Adet" htmlFor="adj-qty" hint="Deftere yazılacak adet (stok değişmez).">
          <Input id="adj-qty" name="qty" type="number" min={0} step={1} defaultValue={0} className="w-32" />
        </Field>
      </div>

      <p className="inline-flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        Bozuk kalemleri gerçekten stoktan düşmek için <strong>Envanter</strong> sekmesinden
        satırları işaretleyip “{adjustmentActionLabel('void')}” ya da “
        {adjustmentActionLabel('damage')}” deyin — birden fazla kalem tek seferde seçilebilir.
      </p>

      <Field label="Sebep" htmlFor="adj-reason" required hint="Denetim (audit) kaydına yazılır.">
        <Textarea
          id="adj-reason"
          name="reason"
          required
          rows={2}
          placeholder="ör. sayım farkı — fiziksel kontrol sonrası not"
          className="max-w-md"
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={pending}>
          <Plus /> {pending ? 'Kaydediliyor…' : 'Deftere Yaz'}
        </Button>
        {/* Dürüstlük: bu form stoğu DEĞİŞTİRMEZ, o yüzden yeşil "düşüldü" mesajı da yok. */}
        {state.saved && (
          <span className="inline-flex items-start gap-1.5 text-xs font-medium text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            Kayıt deftere yazıldı — satılabilir stok DEĞİŞMEDİ.
          </span>
        )}
        {state.error && <span className="text-xs text-destructive">{state.error}</span>}
      </div>
    </form>
  );
}
