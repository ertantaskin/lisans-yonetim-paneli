'use client';
import { useActionState, type ReactNode } from 'react';
import { CalendarClock, CheckCircle2, RefreshCw, ShieldCheck, TriangleAlert } from 'lucide-react';
import {
  expireMaintenanceAction,
  reconcileMaintenanceAction,
  type MaintenanceState,
} from './actions';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { Alert, AlertDescription } from '../../components/ui/alert';

const initial: MaintenanceState = { ok: false };

/** Tek bir bakım tetikleyicisi — native form POST → server action; buton + inline sonuç. */
function MaintenanceAction({
  action,
  icon,
  label,
  pendingLabel,
  desc,
}: {
  action: (prev: MaintenanceState, formData: FormData) => Promise<MaintenanceState>;
  icon: ReactNode;
  label: string;
  pendingLabel: string;
  desc: string;
}) {
  const [state, formAction, pending] = useActionState(action, initial);

  return (
    <div className="space-y-2">
      <form action={formAction} className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="outline" disabled={pending}>
          {pending ? <RefreshCw className="animate-spin" /> : icon}
          {pending ? pendingLabel : label}
        </Button>
        <span className="text-xs text-muted-foreground">{desc}</span>
      </form>

      {state.error && <p className="text-sm text-destructive">{state.error}</p>}

      {state.ok && state.message && (
        <Alert variant={state.warn ? 'warning' : 'success'}>
          {state.warn ? <TriangleAlert /> : <CheckCircle2 />}
          <div className="min-w-0 flex-1">
            <AlertDescription>{state.message}</AlertDescription>
          </div>
        </Alert>
      )}
    </div>
  );
}

/**
 * Bakım kartı — periyodik işleri (süre-bitişi taraması · mutabakat denetimi) elle tetikler.
 * İşler zaten arka planda periyodik çalışır; bu yalnız ops için manuel kısayol. Mutabakat
 * denetimi DÜZELTME yapmaz, yalnız raporlar (§16).
 */
export function MaintenanceCard() {
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Bakım</CardTitle>
        <CardDescription>
          Periyodik bakım işleri arka planda çalışır; buradan elle tetiklenebilir.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <MaintenanceAction
          action={expireMaintenanceAction}
          icon={<CalendarClock />}
          label="Süre-bitişini tara"
          pendingLabel="Taranıyor…"
          desc="Süresi geçmiş 'hide' atamalarını gizler (expired)."
        />
        <MaintenanceAction
          action={reconcileMaintenanceAction}
          icon={<ShieldCheck />}
          label="Mutabakat denetimi"
          pendingLabel="Denetleniyor…"
          desc="Sayaç ↔ atama tutarlılığını doğrular (düzeltmez, §16)."
        />
      </CardContent>
    </Card>
  );
}
