'use client';
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { PackageX } from 'lucide-react';
import { recallBatchAction } from '../app/batches/actions';
import { Alert, AlertDescription } from './ui/alert';
import { Button } from './ui/button';
import { useConfirm } from './ui/confirm';

/**
 * Parti geri çekme düğmesi — PARTİ DETAYI için bağımsız sürüm.
 *
 * `batches-table.tsx` içindeki recall akışı tablo durumuna (seçili satır + modal state)
 * bağlı; detay sayfasında tek parti olduğu için o karmaşaya gerek yok. İkisi de AYNI
 * sunucu aksiyonunu (`recallBatchAction`) çağırır — iş kuralı tek yerde kalır, burada
 * yalnız onay yüzeyi vardır (paylaşılan `useConfirm`, sebep ZORUNLU).
 */
export function BatchRecallButton({
  batchId,
  label,
  unsold,
  customer,
}: {
  batchId: string;
  label: string;
  /** Stoktaki (available) adet — geri çekme BUNLARI geçersiz kılar. */
  unsold: number;
  /** Müşterilerdeki (canlı atamalı) adet — geri çekme bunlara DOKUNMAZ. */
  customer: number;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    const details = [
      `Stoktaki ${unsold} anahtar geçersiz kılınacak — bu geri alınamaz.`,
      customer > 0
        ? `Müşterilerdeki ${customer} anahtara DOKUNULMAZ: çalışmaya devam eder ve müşteri görmeye devam eder. Hangisini değiştireceğinize aşağıdaki "Müşterilerdeki lisanslar" listesinden tek tek karar verirsiniz.`
        : 'Bu partiden müşteride duran anahtar yok.',
    ];
    const res = await confirm({
      title: `${label} partisi geri çekilecek`,
      description:
        'Parti "geri çekildi" durumuna geçer. Geri çekme YALNIZ stoğu etkiler — teslim edilmiş anahtarlar kendiliğinden iptal olmaz, çünkü çalışıyor olabilirler.',
      details,
      tone: 'danger',
      confirmLabel: 'Geri Çek',
      reason: {
        label: 'Geri çekme sebebi',
        placeholder: 'ör. tedarikçi hatalı key partisi bildirdi',
        required: true,
        minLength: 3,
        inputType: 'textarea',
        hint: 'Denetim kaydına yazılır.',
      },
    });
    if (!res) return;

    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const out = await recallBatchAction(batchId, res.reason);
      if (out.ok) {
        // SAYI HİZASI: band, onay modali ve alttaki "Müşterilerdeki lisanslar" listesi AYNI
        // kümeyi (aktif + askıda) saymalı. Eskiden band `soldNeedingReplacement` (yalnız
        // AKTİF) kullanıyordu → askıda ataması olan partide modal "2 anahtar" der, band
        // "1 anahtar" derdi ve işaret ettiği liste 2 satır gösterirdi.
        const held = out.customerHeld ?? out.soldNeedingReplacement ?? 0;
        const auto = out.soldNeedingReplacement ?? 0;
        setNote(
          `Stoktaki ${out.voided ?? 0} anahtar geçersiz kılındı.` +
            (held > 0
              ? ` Müşterilerdeki ${held} anahtar çalışmaya devam ediyor` +
                (held > auto ? ` (${held - auto} tanesi askıda)` : '') +
                ' — aşağıdaki listeden tek tek inceleyip gerekeni değiştirin.'
              : ''),
        );
        router.refresh();
      } else {
        setError(out.error ?? 'Geri çekme başarısız.');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button variant="danger" size="sm" onClick={() => void run()} disabled={busy}>
        <PackageX /> {busy ? 'İşleniyor…' : 'Partiyi geri çek'}
      </Button>
      {note && (
        <Alert variant="success" className="mt-2 w-full">
          <AlertDescription>{note}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive" className="mt-2 w-full">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {dialog}
    </>
  );
}
