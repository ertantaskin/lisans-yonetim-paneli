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
  /**
   * Gönderen adresi (`MAIL_FROM`, ör. `Lisans Paneli <teslimat@localhost>`).
   *
   * OPSİYONEL: api ve admin AYRI imajlardır ve biri önce dağıtılabilir. Alan gelmezse
   * zarf satırı HİÇ basılmaz (bu projenin standardı: eski API imajına toleranslı ol,
   * "undefined" yazan bir satır GÖSTERME).
   */
  from?: string | null;
}

/** Panelin kendi bilgi şeridindeki etiket/değer satırı (dar rayda da sarar). */
function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground">{value}</span>
    </div>
  );
}

/**
 * "Kâğıdın" (e-posta tıpkıbasımı) zarf başlığı satırı.
 *
 * Renkler SABİT (token DEĞİL) — gerekçe `MailPaper` docstring'inde.
 */
function EnvelopeRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[13px] leading-5">
      <span className="w-14 shrink-0 text-zinc-600">{label}</span>
      <span className="min-w-0 flex-1 break-words text-zinc-800">{value}</span>
    </div>
  );
}

/**
 * Düz metindeki `http(s)://…` adreslerini tıklanabilir yapar.
 *
 * NEDEN `dangerouslySetInnerHTML` YOK: gerçek mail `text/plain` gönderilir (ölçüldü —
 * Mailpit ham kaynağında tek parça `text/plain; charset=utf-8`, HTML parça yok) ve mail
 * şablonunu OPERATÖR yazar. Metni HTML olarak yorumlamak (a) gerçeğe AYKIRI olurdu
 * (müşterinin istemcisi de yorumlamıyor) ve (b) gereksiz bir XSS yüzeyi açardı. Bunun
 * yerine metin parçalara ayrılıp React `<a>` DÜĞÜMLERİ üretiliyor: React her metin
 * parçasını kendisi kaçırır, HTML enjeksiyonu imkânsız. Gerçek istemciler (Gmail/Apple
 * Mail) de düz metindeki URL'leri tam olarak böyle otomatik bağlantıya çevirir.
 */
const URL_SOURCE = 'https?://[^\\s<>()\\[\\]{}"\']+';

function linkify(text: string): React.ReactNode[] {
  // Regex HER ÇAĞRIDA yeniden kurulur: modül düzeyinde `g` bayraklı bir regex paylaşmak
  // `lastIndex` taşımasına (aynı metnin ikinci render'ında bağlantıların kaybolmasına)
  // yol açar — klasik tuzak.
  const re = new RegExp(URL_SOURCE, 'gi');
  const nodes: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    let url = match[0];
    // Cümle sonundaki noktalama adresin parçası değildir ("…adresine gidin." → nokta hariç).
    const trailing = url.match(/[.,;:!?'"»]+$/);
    if (trailing) url = url.slice(0, url.length - trailing[0].length);
    // `https?://` ön eki garanti olduğu için url ASLA boşalmaz → sonsuz döngü riski yok.
    if (match.index > last) nodes.push(text.slice(last, match.index));
    nodes.push(
      <a
        key={`u${key++}`}
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="text-blue-700 underline underline-offset-2 hover:text-blue-800"
      >
        {url}
      </a>,
    );
    last = match.index + url.length;
    // Kırpılan noktalama bir sonraki taramaya GERİ VERİLİR (metinden düşmesin).
    re.lastIndex = last;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/**
 * E-postanın TIPKIBASIMI — müşterinin mail istemcisinde gördüğü mesaj.
 *
 * NEDEN BEYAZ KÂĞIT (panelin teması takip EDİLMEZ, koyu temada da beyaz kalır):
 * bu bölge panelin bir çıktısı değil, DIŞ bir belgenin tıpkıbasımıdır. Operatör buraya
 * "müşteriye ne gidiyor?" sorusunu yanıtlamak için bakar; panelin teması bu yargıyı
 * değiştirmemelidir. Koyu temada gövdeyi açık metin/koyu zemin göstermek, müşterinin
 * ASLA görmeyeceği bir görüntü üretirdi. Bu yüzden renkler token DEĞİL SABİTTİR
 * (`bg-white`, `text-zinc-…`) — token temaya göre değişir, kâğıt değişmemeli.
 *
 * NEDEN ORANTILI (sans) YAZI TİPİ, MONOSPACE DEĞİL: mail `text/plain` gönderiliyor ve
 * Gmail/Apple Mail/Outlook.com düz metin mesajları orantılı yazı tipiyle gösterir.
 * Eski `<pre class="font-mono text-xs">` görünümü panelin hata-ayıklama çıktısı gibi
 * duruyordu; müşterinin gördüğü şey bu değil.
 *
 * Kontrast (beyaz zemin): zinc-800 ≈ 14:1, zinc-600 ≈ 7,6:1, blue-700 ≈ 6,3:1 — hepsi AA üstü.
 */
function MailPaper({
  from,
  to,
  subject,
  previewAt,
  text,
}: {
  from?: string | null;
  to: string | null;
  subject: string | null;
  previewAt: string | null;
  text: string | null;
}) {
  return (
    <article
      aria-label="E-posta önizlemesi"
      className="overflow-hidden rounded-lg border border-zinc-200 bg-white text-zinc-900 shadow-sm"
    >
      {/* Zarf başlığı — istemcinin mesaj üstünde gösterdiği blok. */}
      <header className="space-y-1.5 border-b border-zinc-200 px-4 py-3 sm:px-5 sm:py-4">
        <h3 className="break-words text-[17px] font-semibold leading-snug text-zinc-900">
          {subject ?? '(konu yok)'}
        </h3>
        <div className="space-y-0.5 pt-1">
          {from ? <EnvelopeRow label="Kimden" value={from} /> : null}
          <EnvelopeRow label="Kime" value={to ?? '—'} />
          {/*
            Tarih: gerçek gönderim damgası HİÇBİR YERDE saklanmıyor (`email_log` gövde ve
            gönderim zamanı tutmaz). Uydurma bir "gönderildi" tarihi basmak operatörü
            yanıltırdı → satır AÇIKÇA önizleme anını söyler.
          */}
          {previewAt ? <EnvelopeRow label="Tarih" value={`Önizleme anı · ${previewAt}`} /> : null}
        </div>
      </header>

      {/*
        Gövde: `text/plain` metnin BİREBİR kendisi.
        - `whitespace-pre-wrap` → satır sonları ve madde/kutu-çizgi hizaları korunur.
        - `[overflow-wrap:anywhere]` → uzun lisans anahtarı KIRPILMADAN sarar (yatay kaydırma
          yok; 375px'te bile taşma olmamalı). `break-words` sözcük sınırına bakar, boşluksuz
          40 karakterlik bir anahtarda yetmez.
        - Gövde kendi içinde kayar: zarf başlığı uzun mailde ekrandan kaçmasın.
      */}
      <div className="max-h-[26rem] overflow-y-auto whitespace-pre-wrap px-4 py-3 font-sans text-[14px] leading-[1.6] text-zinc-800 [overflow-wrap:anywhere] sm:px-5 sm:py-4">
        {text ? linkify(text) : null}
      </div>
    </article>
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
 * YERLEŞİM KURALI: mailin kendisi beyaz "kâğıt" içinde (bkz. `MailPaper`); panelin KENDİ
 * bilgi bantları (maskeleme uyarısı, test modu, gönderim kaydı, içerik özeti, "bu bir arşiv
 * değil" notu) kâğıdın DIŞINDA ve panelin normal token'larıyla durur. Karıştırılırsa operatör
 * panelin notunu müşteriye giden metnin parçası sanabilir.
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
  /** Önizlemenin ÜRETİLDİĞİ an (gönderim tarihi DEĞİL) — render sırasında değil, yanıt
   *  gelince yazılır (render'da `new Date()` okumak kararsız çıktı/hidrasyon sapması üretir). */
  const [previewAt, setPreviewAt] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const announce = useAnnouncer();

  // Önizleme AÇILINCA istenir (sayfa yüklenirken değil): gövde düz metin sır taşıyabilir ve
  // her açılış bir denetim kaydına düşer — yalnız gerçekten bakılan sipariş için üretilir.
  const load = () => {
    setError(null);
    setPreview(null);
    setPreviewAt(null);
    startTransition(async () => {
      const res = await previewDeliveryMailAction(orderId);
      if (res.ok) {
        setPreview(res.preview);
        setPreviewAt(
          new Date().toLocaleString('tr-TR', {
            dateStyle: 'medium',
            timeStyle: 'short',
          }),
        );
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
                {/* PANELİN uyarıları — kâğıdın DIŞINDA, panel token'larıyla. */}
                {preview.sandbox && (
                  <p className="flex items-start gap-1.5 text-sm text-warning">
                    <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden />
                    {/* Cümle TEK ifade: JSX, metin ile ifadeyi ayrı satırlara bölünce araya
                        boşluk koyar → müşteri adresi yokken "gider ." gibi bir çıktı olurdu. */}
                    {`Mağaza TEST MODUNDA: bu mail müşteriye değil yönetici adresine gider${
                      preview.customerEmail ? ` (müşteri adresi: ${preview.customerEmail})` : ''
                    }.`}
                  </p>
                )}

                {preview.masked && (
                  <p className="flex items-start gap-1.5 text-sm text-muted-foreground">
                    <EyeOff className="mt-0.5 size-4 shrink-0" aria-hidden />
                    Lisans/parola alanları burada MASKELİ gösteriliyor (düz metin görüntüleme yalnız
                    sahip hesabındadır); müşteriye giden mailde bu alanlar açık gider.
                  </p>
                )}

                <MailPaper
                  from={preview.from}
                  to={preview.to}
                  subject={preview.subject}
                  previewAt={previewAt}
                  text={preview.text}
                />

                {/* Panelin kayıt/özet şeridi — kâğıdın parçası DEĞİL. */}
                <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3">
                  <Row
                    label="Gönderim kaydı:"
                    value={
                      <span className="inline-flex flex-wrap items-center gap-2">
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
