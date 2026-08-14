'use client';
import { useActionState } from 'react';
import { DatabaseBackup, ShieldCheck } from 'lucide-react';
import { requestBackup, type DeployState } from './actions';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';

const initial: DeployState = { ok: false, message: '' };

/**
 * Yedek tetikleyici (owner-only) — iki düğme, TEK form.
 *
 * Hedef, tıklanan düğmenin `name="target"` değerinden gelir: FormData'ya YALNIZ submitter'ın
 * name/value çifti girer (projede stok girişinde de kullanılan desen) → gizli alan/istemci
 * state'i gerekmez, yanlış hedef gönderme riski yoktur.
 *
 * Düğme yalnız KUYRUĞA İSTEK yazar; `pg_dump` host'taki runner'da koşar (panel konteynerine
 * DB/Docker erişimi verilmez).
 */
export function BackupForm({ busy }: { busy: boolean }) {
  const [state, action, pending] = useActionState(requestBackup, initial);
  // Kuyrukta aktif iş varken API zaten 409 döner; düğmeyi baştan kapatmak operatörü
  // "başarısız" mesajıyla karşılaşmadan bilgilendirir (dürüst durum).
  const disabled = pending || busy;
  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {/* Hedef = SUBMITTER'ın name/value'su (projedeki `dryRun` deseni ile aynı). */}
        <Button type="submit" name="target" value="backup" disabled={disabled}>
          <DatabaseBackup />
          {pending ? 'İstek kaydediliyor…' : 'Şimdi yedek al'}
        </Button>
        <Button
          type="submit"
          name="target"
          value="backup-drill"
          variant="outline"
          disabled={disabled}
        >
          <ShieldCheck />
          Tatbikat çalıştır
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        <strong>Yedek al:</strong> veritabanının sıkıştırılmış kopyasını çıkarır, arşivin
        okunabilirliğini doğrular, offsite kancası tanımlıysa dışarı kopyalar ve eski dosyaları
        budar. <strong>Tatbikat:</strong> buna ek olarak yedeği <em>ayrı</em> bir doğrulama
        veritabanına geri yükler, satır sayıları ile çifte-atama=0 kontrolünü koşar ve geri-yükleme
        süresini (RTO) ölçer. Prod veritabanına dokunulmaz.
      </p>
      {busy && (
        <p className="text-xs text-muted-foreground">
          Kuyrukta bekleyen/çalışan bir iş var — aynı anda yalnız tek iş çalışır.
        </p>
      )}
      {state.message && (
        <Alert variant={state.ok ? 'success' : 'destructive'}>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
    </form>
  );
}
