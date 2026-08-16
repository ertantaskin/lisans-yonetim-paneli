'use client';
import * as React from 'react';
import { Eye, Info, TriangleAlert, EyeOff, FlaskConical } from 'lucide-react';
import { previewDeliveryMailAction } from './actions';
import { Button } from '../../../components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../../../components/ui/dialog';
import { StatusBadge } from '../../../components/ui/badge';
import { useAnnouncer } from '../../../components/a11y/announcer';

/**
 * API `GET /v1/admin/orders/:id/mail-preview` yanıtı (TEK sözleşme — sunucu aksiyonu da
 * bu tipi `import type` ile okur; 'use server' dosyası tip export edemediği için sözleşme
 * burada durur).
 */
export interface DeliveryMailPreview {
  available: boolean;
  message: string;
  subject: string | null;
  to: string | null;
  customerEmail: string | null;
  text: string | null;
  sandbox: boolean;
  masked: boolean;
  itemCount: number;
  guideCount: number;
  regenerated: true;
}

/** Modal içindeki etiket/değer satırı (dar rayda da sarar). */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{value}</span>
    </div>
  );
}

/**
 * "Gönderilen maili önizle" — müşteriye giden metni YENİDEN GÖNDERMEDEN gösterir.
 *
 * ÖNEMLİ (operatöre de yazılır): bu bir ARŞİV DEĞİLDİR. `email_log` yalnız alıcı/konu/durum
 * tutar; gövde hiçbir yerde saklanmaz (düz metin lisans anahtarı log tablosuna yazılmaz —
 * bilinçli tasarım). Gösterilen metin, şablonun SİPARİŞİN GÜNCEL verisiyle yeniden üretilmiş
 * hâlidir ve gerçek gönderimle AYNI kodu (API `DeliveryMailBuilder`) kullanır → panelde
 * görünen ile müşteriye giden ayrışamaz. Sipariş o tarihten sonra değiştiyse (değişim/iptal/
 * yeni atama/şablon düzenlemesi) gönderilen kopya birebir aynı olmayabilir.
 *
 * GÖVDE DÜZ METİN BASILIR (`<pre>`): mail `text/plain` gönderilir ve şablonu OPERATÖR yazar →
 * HTML olarak yorumlamak hem yanlış (gerçekte öyle görünmüyor) hem de gereksiz bir XSS
 * yüzeyi olurdu.
 */
export function MailPreviewButton({
  orderId,
  subject,
  status,
  toEmail,
}: {
  orderId: string;
  /** Log satırındaki konu (gönderim ANINDAKİ konu — önizlemedeki konudan farklı olabilir). */
  subject: string;
  /** email_log durumu (queued/sent/failed/skipped). */
  status: string;
  /** Log satırındaki alıcı. */
  toEmail?: string | null;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [preview, setPreview] = React.useState<DeliveryMailPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const announce = useAnnouncer();

  // Önizleme AÇILINCA istenir (sayfa yüklenirken değil): gövde düz metin sır taşıyabilir ve
  // her açılış bir denetim kaydına düşer — yalnız gerçekten bakılan sipariş için üretilir.
  const load = () => {
    setError(null);
    setPreview(null);
    startTransition(async () => {
      const res = await previewDeliveryMailAction(orderId);
      if (res.ok) {
        setPreview(res.preview);
        announce(
          res.preview.available ? 'Mail önizlemesi hazır.' : 'Mail önizlemesi üretilemedi.',
          { assertive: !res.preview.available },
        );
      } else {
        setError(res.error);
        announce(res.error, { assertive: true });
      }
    });
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={`Mail içeriğini önizle — ${subject}`}
        title="Mail içeriğini önizle (gönderilmez)"
        onClick={() => {
          setOpen(true);
          load();
        }}
      >
        <Eye />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              <Eye className="size-4" aria-hidden /> Mail önizlemesi
            </DialogTitle>
            <DialogDescription>
              Müşteriye gönderilen teslimat mailinin içeriği. Bu ekran mail GÖNDERMEZ.
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
            {pending && <p className="text-sm text-muted-foreground">Hazırlanıyor…</p>}

            {error && (
              <p className="flex items-start gap-1.5 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
              </p>
            )}

            {preview && !preview.available && (
              <p className="flex items-start gap-1.5 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {preview.message}
              </p>
            )}

            {preview?.available && (
              <>
                <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3">
                  <Row label="Konu:" value={preview.subject} />
                  <Row
                    label="Alıcı:"
                    value={
                      preview.sandbox
                        ? `${preview.to} (test modu — müşteri adresi: ${preview.customerEmail})`
                        : preview.to
                    }
                  />
                  <Row
                    label="Gönderim kaydı:"
                    value={
                      <span className="inline-flex items-center gap-2">
                        <StatusBadge status={status} />
                        <span className="text-muted-foreground">
                          {subject}
                          {toEmail ? ` → ${toEmail}` : ''}
                        </span>
                      </span>
                    }
                  />
                  <Row
                    label="İçerik:"
                    value={`${preview.itemCount} lisans kalemi${
                      preview.guideCount > 0 ? ` · ${preview.guideCount} kurulum rehberi` : ''
                    }`}
                  />
                </div>

                {preview.sandbox && (
                  <p className="flex items-start gap-1.5 text-sm text-warning">
                    <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
                    Mağaza TEST MODUNDA: bu mail müşteriye değil yönetici adresine gider.
                  </p>
                )}

                {preview.masked && (
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                    <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    Lisans/parola alanları burada MASKELİ gösteriliyor (düz metin görüntüleme
                    yalnız sahip hesabındadır); müşteriye giden mailde bu alanlar açık gider.
                  </p>
                )}

                {/*
                  Gövde: `text/plain` olduğu gibi. `whitespace-pre-wrap` → satır sonları korunur,
                  uzun anahtarlar sarar (kırpma YOK: operatör tam içeriği teyit etmek istiyor).
                  HTML olarak RENDER EDİLMEZ (şablonu operatör yazar; gerçek mail de düz metindir).
                */}
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed text-foreground">
                  {preview.text}
                </pre>

                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {preview.message}
                </p>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
