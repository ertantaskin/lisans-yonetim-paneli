/**
 * Lisans envanteri DIŞA AKTARMA sözleşmesi — kolonlar, satır metinleri, KVKK varyantları.
 *
 * NEDEN AYRI (ve NÖTR) DOSYA: burada ne `'use client'` ne `'use server'` var. Böylece
 * `lib/**` altındaki birim testleri bu modülü doğrudan import edip kolon SIRASINI ve
 * kaçışlamayı kilitleyebiliyor (vitest `include: lib/**\/*.test.ts`, node ortamı). Aynı
 * desen `app/stock/import/parse.ts` için de kullanılıyor.
 *
 * ── KVKK: İKİ VARYANT (karantina dışa aktarmasıyla BİREBİR aynı kural) ──
 * Mutabakat dosyası çoğu zaman panel dışına çıkar (muhasebe, tedarikçi, arşiv). Müşteri
 * e-postasını TAM lisans değeriyle AYNI SATIRDA birleştirmek, kişisel veriyi hiç gerekmeyen
 * yerlere taşır. Bu yüzden:
 *   · `inventory` → stok/tedarik kolonları. Müşteri e-postası ve mağaza sipariş no YOK.
 *   · `audit`     → tam set (teslimat izi dahil). KİŞİSEL VERİ İÇERİR → dosyanın İÇİNE
 *                   uyarı satırı basılır (dosya yeniden adlandırılıp iletilebilir; uyarı
 *                   yalnız dosya adında kalırsa kaybolur).
 */
import type { LicenseInventoryRow } from '../../app/stock/license-actions';
import type { CsvColumn } from '../../lib/csv';
import {
  assignmentStatusLabel,
  licenseItemStatusLabel,
  productKindLabel,
} from '../../lib/labels';

/** Maske gövdesi (§8) — API owner-olmayan admine bu gövdeyle döner. */
export const MASK_BODY = '••••••';

export type InventoryExportVariant = 'inventory' | 'audit';
export type InventoryExportScope = 'visible' | 'all';
export type InventoryExportFormat = 'csv' | 'txt';

/**
 * Yanıt MASKELİ mi? Normalde API `masked` bayrağını döndürür (tek doğruluk kaynağı).
 * Bu sezgi YALNIZ dağıtım sapması yedeğidir (api/admin ayrı imajlar; eski API alanı
 * göndermez) — bayrak yoksa maskeli dosya SESSİZCE "düz metin" gibi işaretlenmesin.
 */
export function looksMasked(rows: LicenseInventoryRow[]): boolean {
  return rows.some(
    (r) =>
      (r.value ?? '').includes(MASK_BODY) ||
      (r.fields ?? []).some((f) => f.value.includes(MASK_BODY)),
  );
}

/**
 * Bir satırın lisans/hesap değerinin TEK HÜCRELİK metni.
 * Hesap ürününde alanlar `etiket: değer` biçiminde ` | ` ile birleşir — CSV'de tek hücre,
 * .txt'te tek satır kalsın (satır sonu koymak "bir kayıt = bir satır" garantisini bozardı).
 */
export function licenseValueText(row: LicenseInventoryRow): string {
  if (row.kind === 'account') {
    const fields = row.fields ?? [];
    if (fields.length === 0) return '';
    return fields.map((f) => `${f.label}: ${f.value}`).join(' | ');
  }
  return row.value ?? '';
}

/** Boş/geçersiz tarih → BOŞ hücre (Excel'de "—" metni istemiyoruz; karantina deseni). */
function csvDate(iso?: string | null): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? '' : new Date(t).toLocaleString('tr-TR');
}

/** Kuruş → tr-TR ondalık metin ("1250" → "12,50"). Para birimi AYRI kolondadır. */
function costText(cents: number | null): string {
  if (cents == null || !Number.isFinite(cents)) return '';
  return (cents / 100).toLocaleString('tr-TR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Stok ömrü alanları admin tipinde YOK (API sonradan ekledi, `LicenseInventoryRow` bu partide
 * değişmedi) → dar cast ile SAVUNMACI okunur. Alan gelmezse hücre boş kalır, ekran/dosya kırılmaz.
 * (Aynı yaklaşım `license-items-table.tsx` içindeki `stockExpiry` için de kullanılıyor.)
 */
function stockExpiryText(row: LicenseInventoryRow): string {
  const r = row as unknown as { expiresAt?: unknown };
  return typeof r.expiresAt === 'string' ? csvDate(r.expiresAt) : '';
}

/**
 * Stok/tedarik kolonları — KİŞİSEL VERİ YOK.
 * Sıra bilinçlidir: önce "ne" (ürün/değer/durum), sonra "nereden geldi" (parti/tedarikçi/
 * maliyet), en sonda zaman damgaları. Birim testi bu sırayı kilitler.
 */
export const inventoryCsvColumns: CsvColumn<LicenseInventoryRow>[] = [
  { header: 'Ürün', value: (r) => r.productName ?? '' },
  { header: 'SKU', value: (r) => r.productSku ?? '' },
  { header: 'Tür', value: (r) => (r.productType ? productKindLabel(r.productType) : '') },
  { header: 'Lisans/Hesap değeri', value: licenseValueText },
  { header: 'Durum', value: (r) => (r.status ? licenseItemStatusLabel(r.status) : '') },
  // MAK/çok kullanımlı kalemde "1 anahtar = N hak" — mutabakatta satır sayısı yetmez.
  { header: 'Kullanım', value: (r) => (r.usageMode === 'multi' ? `${r.useCount}/${r.maxUses}` : '') },
  { header: 'Kalan hak', value: (r) => (r.usageMode === 'multi' ? r.remainingUses : '') },
  { header: 'Parti kodu', value: (r) => r.batchCode ?? '' },
  { header: 'Tedarikçi', value: (r) => r.supplierName ?? '' },
  { header: 'Birim maliyet', value: (r) => costText(r.unitCostCents) },
  { header: 'Para birimi', value: (r) => r.costCurrency ?? '' },
  { header: 'Stok ömrü bitişi', value: stockExpiryText },
  { header: 'Eklenme', value: (r) => csvDate(r.createdAt) },
];

/** Tam set — teslimat izi. MÜŞTERİ E-POSTASI İÇERİR (panel dışına çıkmamalı). */
export const auditCsvColumns: CsvColumn<LicenseInventoryRow>[] = [
  ...inventoryCsvColumns,
  { header: 'Mağaza sipariş no', value: (r) => r.delivered?.remoteOrderId ?? '' },
  { header: 'Site', value: (r) => r.delivered?.siteDomain ?? '' },
  { header: 'Müşteri e-postası', value: (r) => r.delivered?.customerEmail ?? '' },
  { header: 'Teslim tarihi', value: (r) => csvDate(r.delivered?.assignedAt ?? null) },
  {
    header: 'Atama durumu',
    value: (r) => (r.delivered ? assignmentStatusLabel(r.delivered.assignmentStatus) : ''),
  },
];

/** Düz metin satırı (stok seti): numaralı, tek satır, sütun yok. */
export const inventoryTextLine = (r: LicenseInventoryRow, i: number): string =>
  [
    `${i + 1}. ${r.productName || 'Ürün bilinmiyor'}${r.productSku ? ` (${r.productSku})` : ''}`,
    licenseValueText(r) || '—',
    r.status ? licenseItemStatusLabel(r.status) : '—',
    r.batchCode ? `Parti: ${r.batchCode}` : null,
  ]
    .filter(Boolean)
    .join(' — ');

/** Düz metin satırı (tam set): aynı satır + teslimat izi. */
export const auditTextLine = (r: LicenseInventoryRow, i: number): string => {
  const d = r.delivered;
  if (!d) return inventoryTextLine(r, i);
  const trace = [d.siteDomain, d.remoteOrderId ? `Sipariş ${d.remoteOrderId}` : null, d.customerEmail]
    .filter(Boolean)
    .join(' · ');
  return trace ? `${inventoryTextLine(r, i)} — ${trace}` : inventoryTextLine(r, i);
};

export interface InventoryVariantSpec {
  title: string;
  /** Dosya adı öneki — içeriği de söyler ("iç denetim" dosyasını yanlışlıkla göndermek zorlaşsın). */
  file: string;
  columns: CsvColumn<LicenseInventoryRow>[];
  line: (row: LicenseInventoryRow, index: number) => string;
  /** KVKK uyarısı — YALNIZ kişisel veri taşıyan varyantta (dosyanın İÇİNE yazılır). */
  warning?: string;
}

export const INVENTORY_EXPORT_VARIANT: Record<InventoryExportVariant, InventoryVariantSpec> = {
  inventory: {
    title: 'Envanter (stok & tedarik)',
    file: 'lisans-envanteri',
    columns: inventoryCsvColumns,
    line: inventoryTextLine,
  },
  audit: {
    title: 'İç denetim (teslimat izi dahil)',
    file: 'lisans-envanteri-ic-denetim',
    columns: auditCsvColumns,
    line: auditTextLine,
    warning: 'UYARI: Bu dosya müşteri kişisel verisi içerir — 3. tarafa göndermeyin.',
  },
};

/**
 * Dosyanın İÇİNE yazılacak uyarı satırları (CSV'de ilk hücre / .txt'te başlık).
 *
 * DÜRÜSTLÜK KURALI: kırpılma (`truncated`) ve maskeleme yalnız ekranda yazmaz — dosya
 * yeniden adlandırılıp iletildiğinde de okunabilmeli. Bu yüzden ikisi de metne girer.
 */
export function exportNotices(args: {
  variant: InventoryExportVariant;
  masked: boolean;
  truncated: boolean;
  total: number;
  exported: number;
  limit: number;
}): string[] {
  const out: string[] = [];
  const spec = INVENTORY_EXPORT_VARIANT[args.variant];
  if (spec.warning) out.push(spec.warning);
  if (args.masked) {
    out.push(
      'NOT: Lisans/hesap değerleri MASKELİ — düz metin yalnız sahip (owner) rolüne gösterilir.',
    );
  }
  if (args.truncated) {
    out.push(
      `EKSİK LİSTE: süzgece uyan ${args.total} kayıttan yalnız ${args.exported} tanesi ` +
        `alındı (sunucu üst sınırı ${args.limit}). Süzgeci daraltıp tekrar alın.`,
    );
  }
  return out;
}
