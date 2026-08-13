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
  sold,
}: {
  batchId: string;
  label: string;
  unsold: number;
  sold: number;
}) {
  const router = useRouter();
  const { confirm, dialog } = useConfirm();
  const [busy, setBusy] = React.useState(false);
  const [note, setNote] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const run = async () => {
    const details = [`Satılmamış ${unsold} birim geçersiz kılınacak (geri alınamaz).`];
    if (sold > 0) {
      details.push(`Satılmış ${sold} birim müşterilerde — bunlar için değişim gerekir.`);
    }
    const res = await confirm({
      title: `${label} partisi geri çekilecek`,
      description:
        'Parti "geri çekildi" olur ve stoktaki anahtarları geçersiz kılınır. Teslim edilmiş anahtarlar otomatik değişmez; onları "Toplu Değiştir" ile yenilersiniz.',
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
        setNote(
          `${out.voided ?? 0} anahtar geçersiz kılındı.` +
            ((out.soldNeedingReplacement ?? 0) > 0
              ? ` ${out.soldNeedingReplacement} teslim edilmiş anahtar değişim bekliyor.`
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
