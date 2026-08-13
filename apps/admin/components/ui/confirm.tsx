'use client';
import * as React from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Button } from './button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Input, Textarea } from './input';
import { cn } from '../../lib/utils';

/**
 * Panel geneli **teyit** yüzeyi — `window.confirm` / `window.prompt` yerine.
 *
 * NEDEN: tarayıcının yerleşik kutusu (a) panelin dilini/temasını konuşmaz, düğmeleri
 * işletim sistemi dilindedir; (b) yalnız düz metin gösterir — "neyi onaylıyorum?" sorusuna
 * cevap veren bir LİSTE (ör. girilecek anahtarlar, etkilenecek sipariş) koyulamaz;
 * (c) yıkıcı ile sıradan işlemi görsel olarak ayırmaz; (d) tarayıcı tarafından
 * bastırılabilir → onay HİÇ sorulmadan işlem geçer.
 *
 * KULLANIM (söz verilmiş API — `window.confirm`'den geçiş neredeyse birebir):
 *
 * ```tsx
 * const { confirm, dialog } = useConfirm();
 * // …
 * const onDelete = async () => {
 *   if (!(await confirm({ title: 'Silinsin mi?', tone: 'danger', confirmLabel: 'Sil' }))) return;
 *   // …
 * };
 * return (<>{dialog}<Button onClick={onDelete}>Sil</Button></>);
 * ```
 *
 * Gerekçe isteyen akışlarda (`window.prompt` yerine):
 * ```tsx
 * const res = await confirm({ title: 'Geri al', reason: { label: 'Gerekçe', required: true } });
 * if (!res) return;             // iptal
 * doIt(res.reason);
 * ```
 */
export interface ConfirmReasonSpec {
  label: string;
  placeholder?: string;
  /** Boş bırakılamaz — onay düğmesi kilitli kalır. */
  required?: boolean;
  hint?: React.ReactNode;
  /**
   * Girdi türü. Varsayılan çok satırlı gerekçe alanı; `password` maskeli tek satırdır
   * (parola sıfırlama gibi akışlar `window.prompt` ile parolayı DÜZ gösteriyordu).
   */
  inputType?: 'textarea' | 'text' | 'password';
  /** En az bu kadar karakter — altındaysa onay düğmesi kilitli (sessiz alert yerine). */
  minLength?: number;
}

export interface ConfirmOptions {
  title: string;
  /** Tek cümlelik açıklama — ne olacağını ve geri alınabilir mi olduğunu söyler. */
  description?: React.ReactNode;
  /** Serbest içerik: liste, özet tablosu, uyarı bandı… ("neyi onaylıyorum?"). */
  details?: React.ReactNode;
  /** `danger` → kırmızı onay düğmesi + uyarı ikonu; odak İPTAL'de başlar. */
  tone?: 'default' | 'danger';
  confirmLabel?: string;
  cancelLabel?: string;
  reason?: ConfirmReasonSpec;
}

export interface ConfirmResult {
  /** Gerekçe istenmediyse boş dize. */
  reason: string;
}

type PendingState = {
  options: ConfirmOptions;
  resolve: (value: ConfirmResult | null) => void;
};

export function useConfirm() {
  const [pending, setPending] = React.useState<PendingState | null>(null);
  const [reason, setReason] = React.useState('');
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<ConfirmResult | null>((resolve) => {
        setReason('');
        // BİR TIK GECİKME (bilinçli): çağıran çoğu yerde bir dropdown menü öğesidir.
        // Radix menü kapanırken odağı tetikleyiciye GERİ verir; modal aynı karede
        // açılırsa bu geri-verme modalin odak tuzağıyla yarışır. Bir makro-görev
        // beklemek menü kapanışını bitirir, sonra modal odağı temiz alır.
        setTimeout(() => {
          setPending((prev) => {
            // Aynı anda ikinci bir onay istenirse öncekini İPTAL olarak kapat: sözü
            // asla çözülmeyen bir promise (donmuş handler) bırakmayız.
            prev?.resolve(null);
            return { options, resolve };
          });
        }, 0);
      }),
    [],
  );

  const settle = React.useCallback(
    (value: ConfirmResult | null) => {
      setPending((prev) => {
        prev?.resolve(value);
        return null;
      });
    },
    [],
  );

  const opts = pending?.options;
  const danger = opts?.tone === 'danger';
  const spec = opts?.reason;
  const reasonMissing =
    (Boolean(spec?.required) && reason.trim() === '') ||
    (spec?.minLength != null && reason.length > 0 && reason.length < spec.minLength) ||
    (spec?.minLength != null && Boolean(spec.required) && reason.length < spec.minLength);

  const dialog = (
    <Dialog
      open={pending !== null}
      // Dışarı tıklama / Escape / (×) → İPTAL. Onay YALNIZ düğmeyle verilir.
      onOpenChange={(next) => {
        if (!next) settle(null);
      }}
    >
      {opts && (
        <DialogContent
          // Yıkıcı işlemde odak İPTAL'de başlar: modal açılır açılmaz basılan Enter
          // yanlışlıkla silmesin (yerleşik confirm'de bu ayrım yoktur).
          onOpenAutoFocus={
            danger && !opts.reason
              ? (e) => {
                  e.preventDefault();
                  cancelRef.current?.focus();
                }
              : undefined
          }
        >
          <DialogHeader>
            <DialogTitle>
              {danger ? (
                <AlertTriangle className="size-4 shrink-0 text-destructive" aria-hidden />
              ) : (
                <HelpCircle className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
              {opts.title}
            </DialogTitle>
            {opts.description ? (
              <DialogDescription>{opts.description}</DialogDescription>
            ) : (
              // Radix, açıklaması olmayan modalde konsola uyarı basar; sessizce bağlarız.
              <DialogDescription className="sr-only">Onay gerekiyor.</DialogDescription>
            )}
          </DialogHeader>

          {(opts.details || opts.reason) && (
            <div className="-mr-1 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm">
              {opts.details}
              {opts.reason && (
                <div className="space-y-1.5">
                  <label
                    htmlFor="confirm-reason"
                    className="block text-sm font-medium text-foreground"
                  >
                    {opts.reason.label}
                    {opts.reason.required && (
                      <span className="text-destructive" aria-hidden>
                        {' '}
                        *
                      </span>
                    )}
                  </label>
                  {opts.reason.inputType && opts.reason.inputType !== 'textarea' ? (
                    <Input
                      id="confirm-reason"
                      autoFocus
                      type={opts.reason.inputType}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={opts.reason.placeholder}
                      aria-required={opts.reason.required}
                      minLength={opts.reason.minLength}
                      // Parola alanı: tarayıcı bunu kayıtlı bir hesap parolası sanmasın.
                      autoComplete={opts.reason.inputType === 'password' ? 'new-password' : 'off'}
                    />
                  ) : (
                    <Textarea
                      id="confirm-reason"
                      autoFocus
                      rows={3}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder={opts.reason.placeholder}
                      aria-required={opts.reason.required}
                    />
                  )}
                  {opts.reason.hint && (
                    <p className="text-xs text-muted-foreground">{opts.reason.hint}</p>
                  )}
                </div>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" ref={cancelRef} onClick={() => settle(null)}>
              {opts.cancelLabel ?? 'Vazgeç'}
            </Button>
            <Button
              type="button"
              variant={danger ? 'danger' : 'default'}
              disabled={reasonMissing}
              title={reasonMissing ? `${opts.reason?.label} zorunlu` : undefined}
              onClick={() => settle({ reason: reason.trim() })}
              className={cn(danger && 'sm:min-w-32')}
            >
              {opts.confirmLabel ?? 'Onayla'}
            </Button>
          </DialogFooter>
        </DialogContent>
      )}
    </Dialog>
  );

  return { confirm, dialog };
}
