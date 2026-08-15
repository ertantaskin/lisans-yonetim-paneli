'use client';
import * as React from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight, Mail, Monitor, Pencil, Plus, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { GUIDE_BODY_MAX, renderGuideHtml, renderGuideText } from '@lisans/shared';
import {
  createGuideAction,
  deleteGuideAction,
  updateGuideAction,
  type GuideFormState,
} from '@/app/guides/actions';
import type { GuideRow } from '@/lib/guides';
import { GUIDE_TEMPLATES } from '@/lib/guide-templates';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { CollapsiblePanel } from './ui/collapsible-panel';
import { useConfirm } from './ui/confirm';
import { Field } from './ui/field';
import { HelpNote } from './ui/help-note';
import { Input, Textarea } from './ui/input';
import { EmptyState } from './ui/page-header';

/** 'use server' dosyasından obje export EDİLEMEZ → başlangıç durumu burada yerel sabit. */
const initialState: GuideFormState = { ok: false };

/**
 * Kurulum / etkinleştirme rehberi yönetimi (§7).
 *
 * Rehber ÜRÜNE GÖMÜLMEZ, ayrı kayıttır: aynı anlatı onlarca SKU'da ortaktır (Office 2021
 * Pro Plus / Home & Business / tek-PC…) ve bir adım değişince tek yerden düzelmelidir.
 * Ürün formunda rehber SERBEST YAZILAMAZ, yalnız buradan seçilir.
 */
export function GuidesManager({ guides }: { guides: GuideRow[] }) {
  // `dialog` render edilmezse onay modali HİÇ görünmez ve söz asla çözülmez (donmuş handler).
  const { confirm, dialog } = useConfirm();
  const [editing, setEditing] = React.useState<string | null>(null);

  const onDelete = async (row: GuideRow) => {
    const ok = await confirm({
      title: `“${row.title}” rehberi silinsin mi?`,
      description:
        row.productCount > 0
          ? `Bu rehbere bağlı ${row.productCount} ürün SİLİNMEZ, yalnız rehbersiz kalır — yeni siparişlerde kurulum talimatı gönderilmez.`
          : 'Bu rehber hiçbir ürüne bağlı değil.',
      confirmLabel: 'Sil',
      tone: 'danger',
    });
    if (!ok) return;
    const res = await deleteGuideAction(row.id);
    if (res.ok) toast.success(res.message ?? 'Rehber silindi.');
    else toast.error(res.error ?? 'Silinemedi');
  };

  return (
    <div className="space-y-4">
      {dialog}
      <CollapsiblePanel
        title="Yeni rehber"
        icon={<Plus className="size-3.5" />}
        openLabel="Yeni Rehber"
        description="Örn. “Office 365 kurulum ve etkinleştirme”, “Windows 10 / 11 etkinleştirme”."
      >
        <GuideForm key="create" onDone={() => undefined} />
      </CollapsiblePanel>

      {guides.length === 0 ? (
        <EmptyState
          icon={Plus}
          title="Henüz rehber yok"
          description="Rehber, lisansla birlikte müşteriye giden kurulum/etkinleştirme talimatıdır: sipariş sayfasında görünür ve teslimat e-postasına eklenir. Hazır taslaklardan başlayabilirsiniz."
        />
      ) : (
        <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {guides.map((row) => (
            <li key={row.id} className="p-4">
              {editing === row.id ? (
                <GuideForm
                  guide={row}
                  onDone={() => setEditing(null)}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{row.title}</p>
                      {/*
                       * Hiçbir ürüne bağlı OLMAYAN rehber müşteriye ASLA ulaşmaz. Bu sessiz
                       * bir kayıptır (operatör yazdı, gönderildiğini sanıyor) → görünür uyarı.
                       */}
                      {row.productCount === 0 ? (
                        <Badge variant="warning">
                          <AlertTriangle className="size-3" /> Ürüne bağlı değil
                        </Badge>
                      ) : (
                        <Badge variant="info">{row.productCount} üründe kullanılıyor</Badge>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                      {row.body.slice(0, 180)}
                      {row.body.length > 180 ? '…' : ''}
                    </p>
                    {row.productNames.length > 0 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row.productNames.join(', ')}
                        {row.productCount > row.productNames.length
                          ? ` +${row.productCount - row.productNames.length} ürün`
                          : ''}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button asChild variant="ghost" size="sm">
                      <Link href="/stock">
                        Ürünler <ArrowRight className="size-3.5" />
                      </Link>
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setEditing(row.id)}>
                      <Pencil className="size-3.5" /> Düzenle
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void onDelete(row)}>
                      <Trash2 className="size-3.5" /> Sil
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Çift modlu form: `guide` verilmezse oluşturur, verilirse günceller (gizli id ile). */
function GuideForm({
  guide,
  onDone,
  onCancel,
}: {
  guide?: GuideRow;
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const editing = Boolean(guide);
  const [state, formAction, pending] = React.useActionState<GuideFormState, FormData>(
    editing ? updateGuideAction : createGuideAction,
    initialState,
  );
  const [title, setTitle] = React.useState(guide?.title ?? '');
  const [body, setBody] = React.useState(guide?.body ?? '');
  const [surface, setSurface] = React.useState<'store' | 'mail'>('store');

  React.useEffect(() => {
    if (state.ok) {
      if (state.message) toast.success(state.message);
      onDone?.();
    }
  }, [state.ok, state.message, onDone]);

  const uid = guide?.id ?? 'new';
  const over = body.length > GUIDE_BODY_MAX;
  const near = !over && body.length > GUIDE_BODY_MAX * 0.9;

  /*
   * ÖNİZLEME MÜŞTERİNİN GÖRECEĞİ HTML'İN TA KENDİSİDİR: `renderGuideHtml` paylaşılan
   * pakettedir ve teslimat yanıtını üreten API de AYNI fonksiyonu çağırır. İkinci bir
   * önizleme uygulaması yazılsaydı, operatör panelde doğru gördüğü bir metnin mağazada
   * bozuk çıktığını ancak müşteri şikâyetiyle öğrenirdi.
   *
   * dangerouslySetInnerHTML burada BİLİNÇLİ ve güvenlidir: girdi önce kaçırılır (escape),
   * sonra yalnız tanınan kalıplar etikete çevrilir — ham HTML asla geçmez (guide.test.ts).
   */
  const html = React.useMemo(() => renderGuideHtml(body), [body]);
  const text = React.useMemo(() => renderGuideText(body), [body]);

  return (
    <form action={formAction} className="space-y-3">
      {editing && <input type="hidden" name="id" value={guide!.id} />}

      {!editing && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Hazır taslak:</span>
          {GUIDE_TEMPLATES.map((t) => (
            <Button
              key={t.label}
              type="button"
              variant="outline"
              size="sm"
              title={t.hint}
              onClick={() => {
                setTitle(t.title);
                setBody(t.body);
              }}
            >
              {t.label}
            </Button>
          ))}
        </div>
      )}

      <Field
        label="Rehber başlığı"
        htmlFor={`guide-title-${uid}`}
        required
        hint="Ürün formundaki listede ve müşterinin gördüğü başlıkta bu ad kullanılır."
      >
        <Input
          id={`guide-title-${uid}`}
          name="title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
          maxLength={120}
          placeholder="ör. Office 365 kurulum ve etkinleştirme"
        />
      </Field>

      <div className="grid gap-3 lg:grid-cols-2">
        <Field
          label="Rehber metni"
          htmlFor={`guide-body-${uid}`}
          required
          hint="Müşterinin adım adım izleyeceği talimat. Sağda müşterinin göreceği hâli canlı görünür."
        >
          <Textarea
            id={`guide-body-${uid}`}
            name="body"
            rows={16}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            className="font-mono text-xs"
            placeholder={'1. https://www.office.com adresine gidin.\n2. Oturum aç deyin…'}
          />
          <div className="mt-1 flex items-center justify-between gap-2">
            <span
              className={`text-xs tabular-nums ${
                over ? 'text-destructive' : near ? 'text-warning' : 'text-muted-foreground'
              }`}
            >
              {body.length.toLocaleString('tr-TR')} / {GUIDE_BODY_MAX.toLocaleString('tr-TR')}{' '}
              karakter
            </span>
            {over && (
              <span role="alert" className="text-xs text-destructive">
                Sınır aşıldı — kaydedilemez.
              </span>
            )}
          </div>
          {/*
           * Sınırın SEBEBİ yazılı: operatör "neden 4.000?" diye sormasın ve sınırı keyfî
           * sanıp metni kırpmak yerine ikinci bir rehbere bölmeyi düşünsün.
           */}
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Sınır e-posta içindir: uzun mesajları Gmail gibi istemciler kırpıp “tümünü
            göster” arkasına atar — kırpılan yer de genelde rehberin bulunduğu sondur.
          </p>
        </Field>

        <div className="min-w-0">
          <div className="mb-1.5 flex items-center gap-1">
            <Button
              type="button"
              variant={surface === 'store' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSurface('store')}
            >
              <Monitor className="size-3.5" /> Mağaza sayfası
            </Button>
            <Button
              type="button"
              variant={surface === 'mail' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setSurface('mail')}
            >
              <Mail className="size-3.5" /> E-posta
            </Button>
          </div>
          <div className="h-[22rem] overflow-auto rounded-lg border border-border bg-muted/30 p-3">
            {body.trim() === '' ? (
              <p className="text-xs text-muted-foreground">
                Metni yazdıkça müşterinin göreceği hâli burada belirir.
              </p>
            ) : surface === 'store' ? (
              // Mağaza sayfasındaki görünümün birebir aynısı (aynı render fonksiyonu).
              <div
                className="wpt-guide-preview text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_h4]:mb-1 [&_h4]:mt-3 [&_h4]:font-semibold [&_li]:my-0.5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 first:[&_h4]:mt-0"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            ) : (
              // E-posta DÜZ METİNDİR: biçimleme yoktur, gördüğünüz satırlar aynen gider.
              <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground">
                {text}
              </pre>
            )}
          </div>
        </div>
      </div>

      <HelpNote title="Biçimleme nasıl çalışır?">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <strong>Adım listesi:</strong> satır başına <code>1.</code>, <code>2.</code> yazın.
          </li>
          <li>
            <strong>Madde listesi:</strong> satır başına <code>-</code> koyun.
          </li>
          <li>
            <strong>Ara başlık:</strong> satır başına <code>##</code> koyun.
          </li>
          <li>
            <strong>Vurgu:</strong> <code>**önemli**</code> yazımı kalınlaştırır.
          </li>
          <li>
            <strong>Bağlantı:</strong> adresi <code>https://</code> ile tam yazın — mağaza
            sayfasında tıklanabilir olur. Kısa yazım (<code>office.com</code>) bağlantıya
            çevrilmez.
          </li>
          <li>Boş satır bırakmak yeni paragraf açar. HTML etiketleri çalışmaz, düz metin olarak görünür.</li>
        </ul>
      </HelpNote>

      {state.error && (
        <p role="alert" className="text-xs text-destructive">
          {state.error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || over}>
          <Save className="size-3.5" /> {pending ? 'Kaydediliyor…' : editing ? 'Kaydet' : 'Ekle'}
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            <X className="size-3.5" /> Vazgeç
          </Button>
        )}
      </div>
    </form>
  );
}
