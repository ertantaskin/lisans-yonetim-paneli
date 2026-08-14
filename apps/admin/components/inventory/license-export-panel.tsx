'use client';
import * as React from 'react';
import { Download, Loader2, ShieldAlert } from 'lucide-react';
import {
  exportLicenseItemsAction,
  type LicenseInventoryRow,
  type LicenseListParams,
} from '../../app/stock/license-actions';
import { downloadCsv, downloadText, stamp, toCsv, toTextList } from '../../lib/csv';
import { fmtDateTime, cn } from '../../lib/utils';
import { Alert, AlertDescription } from '../ui/alert';
import { Button } from '../ui/button';
import { checkboxClass } from '../ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import {
  INVENTORY_EXPORT_VARIANT,
  exportNotices,
  looksMasked,
  type InventoryExportFormat,
  type InventoryExportScope,
  type InventoryExportVariant,
} from './license-export';

/**
 * Envanter DIŞA AKTARMA paneli (§12/§13) — mutabakat/muhasebe için listeyi panelden çıkarma.
 *
 * NEDEN VARDI-YOKTU: karantinada indirme vardı ama ASIL envanterde yoktu; operatör stok
 * sayımını/maliyet mutabakatını panelden alamıyordu (tek yol ekrandan kopyalamaktı).
 *
 * ÜÇ KARAR, HEPSİ GÖRÜNÜR:
 *  1. KAPSAM — "görünen sayfa" (ekranda ne varsa o) ya da "tüm süzgeç sonucu" (sunucudan
 *     tek istekte, tavanlı). İkincisi bilerek AYRI bir sunucu ucunu çağırır: tavan ve
 *     kırpılma bilgisi sunucudan gelir, istemci sayfa sayfa toplayıp tahmin yürütmez.
 *  2. İÇERİK — KVKK ayrımı (bkz. `license-export.ts`): stok seti kişisel veri taşımaz,
 *     iç denetim seti taşır ve dosyanın İÇİNE uyarı basılır.
 *  3. BİÇİM — CSV (Excel) ya da .txt (mesaja yapıştırma).
 *
 * ROL (A1): düz metin YALNIZ owner'a. Owner-olmayan admin maskeli satır alır; panel bunu
 * SÖYLER ve dosyaya da yazar (sessizce "eksik veri" indirtmek yanıltıcı olurdu).
 */
export interface LicenseExportNote {
  tone: 'success' | 'warning';
  text: string;
}

export function LicenseExportPanel({
  rows,
  total,
  params,
  masked,
  disabled,
  onResult,
  className,
}: {
  /** Ekranda GÖRÜNEN sayfa (kapsam: "görünen"). */
  rows: LicenseInventoryRow[];
  /** Süzgece uyan toplam kayıt (sunucudan) — "tüm süzgeç sonucu" seçeneğinde yazılır. */
  total: number;
  /** Tablonun o anki süzgeçleri — sunucu dışa aktarmasına AYNEN geçer (liste = dosya). */
  params: LicenseListParams;
  /** API'nin `masked` bayrağı; gelmezse satırlardan sezilir (dağıtım sapması yedeği). */
  masked?: boolean;
  disabled?: boolean;
  /**
   * İndirme sonucu — SESSİZ BAŞARI YOK: kaç kayıt indi, kırpıldı mı. Sonuç kutusu tablonun
   * kendi uyarı yığınında gösterilir (toolbar satırını şişirmemek için burada render edilmez).
   */
  onResult?: (note: LicenseExportNote) => void;
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState<InventoryExportScope>('visible');
  const [variant, setVariant] = React.useState<InventoryExportVariant>('inventory');
  const [format, setFormat] = React.useState<InventoryExportFormat>('csv');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // Görünen sayfanın maskeli olup olmadığı: bayrak varsa o, yoksa satırlardan sezgi.
  const visibleMasked = masked ?? looksMasked(rows);

  function write(args: {
    data: LicenseInventoryRow[];
    scopeTag: string;
    masked: boolean;
    truncated: boolean;
    total: number;
    limit: number;
  }) {
    const spec = INVENTORY_EXPORT_VARIANT[variant];
    const notices = exportNotices({
      variant,
      masked: args.masked,
      truncated: args.truncated,
      total: args.total,
      exported: args.data.length,
      limit: args.limit,
    });
    const base = `${spec.file}_${args.scopeTag}_${stamp()}`;
    if (format === 'csv') {
      // Uyarılar CSV'nin İLK satırlarına da yazılır: dosya yeniden adlandırılıp iletilebilir,
      // uyarı yalnız ekranda/dosya adında kalamaz (KVKK + "eksik liste" dürüstlüğü).
      downloadCsv(`${base}.csv`, toCsv(args.data, spec.columns, notices));
    } else {
      const header = [
        `Lisans envanteri — ${spec.title}`,
        `${args.data.length} kayıt · ${args.scopeTag === 'gorunen' ? 'görünen sayfa' : 'süzgeç sonucu'} · ${fmtDateTime(new Date().toISOString())}`,
        ...notices,
        '─'.repeat(52),
      ];
      downloadText(`${base}.txt`, toTextList(args.data, spec.line, header));
    }
    onResult?.(
      args.truncated
        ? {
            tone: 'warning',
            text: `${args.data.length} kayıt indirildi — süzgece uyan ${args.total} kayıttan yalnız ilk ${args.limit} tanesi alınabildi. Uyarı dosyanın içinde de var.`,
          }
        : { tone: 'success', text: `${args.data.length} kayıt indirildi.` },
    );
    setOpen(false);
  }

  async function run() {
    setError(null);
    if (scope === 'visible') {
      if (rows.length === 0) return;
      write({
        data: rows,
        scopeTag: 'gorunen',
        masked: visibleMasked,
        truncated: false,
        total: rows.length,
        limit: rows.length,
      });
      return;
    }
    setBusy(true);
    try {
      const res = await exportLicenseItemsAction(params);
      if (!res.ok || !res.data) {
        setError(res.error ?? 'Dışa aktarma başarısız.');
        return;
      }
      if (res.data.rows.length === 0) {
        setError('Bu süzgeçlerle dışa aktarılacak kayıt yok.');
        return;
      }
      write({
        data: res.data.rows,
        scopeTag: 'tumu',
        masked: res.data.masked ?? looksMasked(res.data.rows),
        truncated: res.data.truncated,
        total: res.data.total,
        limit: res.data.limit,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Dışa aktarma başarısız.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={cn('flex flex-col justify-end', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" disabled={disabled || rows.length === 0}>
            <Download aria-hidden />
            Dışa Aktar
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[23rem] space-y-3 p-3">
          <ChoiceGroup<InventoryExportScope>
            legend="Hangi kayıtlar"
            name="envanter-export-kapsam"
            value={scope}
            onChange={setScope}
            options={[
              {
                value: 'visible',
                label: `Görünen sayfa — ${rows.length} kayıt`,
                hint: 'Ekranda o an listelenen satırlar.',
                disabled: rows.length === 0,
              },
              {
                value: 'all',
                label: `Tüm süzgeç sonucu — ${total} kayıt`,
                // DÜRÜSTLÜK: sunucu tavanı var; sığmazsa dosyada ve panelde yazılır.
                hint: 'Sayfalama olmadan, ekrandaki arama/süzgeçlerin tamamı. Sunucu üst sınırını aşarsa dosyada uyarı olur.',
              },
            ]}
          />

          <ChoiceGroup<InventoryExportVariant>
            legend="Hangi bilgiler"
            name="envanter-export-icerik"
            value={variant}
            onChange={setVariant}
            options={[
              {
                value: 'inventory',
                label: 'Envanter (stok & tedarik)',
                hint: 'Ürün, SKU, tür, değer, durum, kullanım, parti, tedarikçi, maliyet, tarihler. Müşteri e-postası YOK.',
              },
              {
                value: 'audit',
                label: 'İç denetim (teslimat izi dahil)',
                hint: 'Yukarıdakiler + mağaza sipariş no, site, müşteri e-postası, teslim tarihi.',
              },
            ]}
          />

          <ChoiceGroup<InventoryExportFormat>
            legend="Biçim"
            name="envanter-export-bicim"
            value={format}
            onChange={setFormat}
            options={[
              { value: 'csv', label: 'CSV (Excel)', hint: 'Noktalı virgül ayraç + UTF-8 BOM.' },
              { value: 'txt', label: 'Düz metin (.txt)', hint: 'Mesaja/e-postaya yapıştırmak için.' },
            ]}
          />

          {INVENTORY_EXPORT_VARIANT[variant].warning && (
            <Alert variant="warning" className="p-2.5">
              <ShieldAlert aria-hidden />
              <AlertDescription>{INVENTORY_EXPORT_VARIANT[variant].warning}</AlertDescription>
            </Alert>
          )}

          {visibleMasked && (
            <Alert variant="warning" className="p-2.5">
              <ShieldAlert aria-hidden />
              <AlertDescription>
                Lisans/hesap değerleri <strong>maskeli</strong> inecek — düz metin yalnız sahip
                (owner) rolüne gösterilir. Uyarı dosyanın içine de yazılır.
              </AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive" className="p-2.5">
              <ShieldAlert aria-hidden />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button className="w-full" size="sm" onClick={() => void run()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            {busy ? 'Hazırlanıyor…' : 'İndir'}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Popover içindeki tek seçimli (radio) grup — klavye ile gezilebilir, görünür açıklamalı. */
function ChoiceGroup<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
}: {
  legend: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string; disabled?: boolean }[];
}) {
  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {legend}
      </legend>
      {options.map((o) => (
        <label
          key={o.value}
          className={cn(
            'flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors',
            o.disabled ? 'cursor-not-allowed opacity-50' : 'hover:bg-accent',
            value === o.value && !o.disabled && 'bg-accent',
          )}
        >
          <input
            type="radio"
            name={name}
            value={o.value}
            checked={value === o.value}
            disabled={o.disabled}
            onChange={() => onChange(o.value)}
            className={cn(checkboxClass, 'mt-0.5 rounded-full')}
          />
          <span className="min-w-0">
            <span className="block text-sm leading-tight text-foreground">{o.label}</span>
            {o.hint && (
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
                {o.hint}
              </span>
            )}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
