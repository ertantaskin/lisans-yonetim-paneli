'use client';
import * as React from 'react';
import Link from 'next/link';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react';
import {
  bulkAdjustLicenseItemsAction,
  fetchLicenseItemsAction,
  type LicenseInventoryPage,
  type LicenseInventoryRow,
} from '../../app/stock/license-actions';
import { Alert, AlertDescription } from '../ui/alert';
import { Badge, StatusBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { useConfirm } from '../ui/confirm';
import { useAnnouncer } from '../a11y/announcer';
import { EmptyState } from '../ui/page-header';
import { SearchInput } from '../ui/search-input';
import { Skeleton } from '../ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/table';
import { selectClass } from '../ui/input';
import { LICENSE_PAGE_SIZES } from '../../lib/license-page-sizes';
import type { PayloadFieldDef } from '../../lib/api';
import { cn, fmtDateTime } from '../../lib/utils';
import { assignmentStatusLabel, productKindLabel, siteTypeLabel } from '../../lib/labels';
import { LicenseItemActions, statusLabel } from './license-item-actions';
import { LicenseExportPanel, type LicenseExportNote } from './license-export-panel';

/** Sayfa boyutu seçenekleri — TEK KAYNAK lib/license-page-sizes (API bu değerlere kırpar). */
const PAGE_SIZES = LICENSE_PAGE_SIZES;

/**
 * Eylem sütunu SAĞA SABİT.
 *
 * NEDEN: bu tablo dokuz kolonlu; 1024-1280 bandında menü açıkken kap 652px'e iniyor ve tablo
 * kendi kabında yatay kayıyor (proje sözleşmesi: geniş tablo kabında kayar). Kayan kısmın EN
 * SAĞI ise eylem sütunu → "Değiştir/Sil/Yenisiyle değiştir" ekranın dışında kalıyordu
 * (kullanıcı ekran görüntüsüyle bildirdi; 1369px'te 15px, 1030px'te 107px ölçüldü). Bir satırı
 * OKUYAMAMAK kaydırmayla çözülür, ama üzerinde İŞLEM YAPAMAMAK kabul edilemez.
 *
 * Sabitleme + OPAK zemin (hover/seçili dahil) `globals.css`'teki `.sticky-actions`'ta —
 * gerekçesi orada. Utility olarak yazılan arbitrary variant'lar (`[tr:hover>&]:bg-[…]`)
 * SESSİZCE derlenmemişti (CSSOM'da kural yoktu, ölçüldü).
 */
const STICKY_ACTIONS = 'sticky-actions z-10 border-l border-border/60';

/**
 * Durum süzgeci. ETİKETLER TEK KAYNAKTAN (`lib/labels` → statusLabel) gelir — burada yalnız
 * hangi durumların sunulacağı seçilir; ham enum kullanıcıya ÇIKMAZ.
 * 'expired' = STOK ÖMRÜ dolmuş kalem (API bu süzgeci `status='expired'` VEYA `expires_at ≤ now`
 * olarak yorumlar) — "stokta görünüp satılamayan" kalemleri tek listede toplar.
 */
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Tümü' },
  ...['available', 'assigned', 'expired', 'quarantined', 'voided'].map((v) => ({
    value: v,
    label: statusLabel(v),
  })),
];

/**
 * "Kim tutuyor" ekseni — envanter DURUMUNDAN ayrıdır. Çok kullanımlı (MAK) bir anahtar
 * 500 hakkının 3'ü satılmışken hâlâ `status='available'` görünür, yani "müşterilerde mi?"
 * sorusu durum süzgeciyle cevaplanamaz. Geri çekilmiş bir partide "hangi anahtarlar hâlâ
 * müşterilerin elinde, hangisini değiştirmeliyim" sorusunun tek doğru süzgeci budur.
 */
const HOLDER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '', label: 'Tümü' },
  { value: 'customer', label: 'Müşterilerde' },
];

/**
 * Sıralama seçenekleri. "En yeni giriş üstte" = giriş BLOKLARI en yeniden eskiye,
 * blok İÇİNDE operatörün yapıştırdığı sıra korunur (sunucu: `created_at DESC, seq ASC`).
 * Etiketler bunu açıkça söyler — eskiden yalnız "En yeni" yazıyordu ve aynı içe aktarmanın
 * satırları rastgele sırada geldiği için operatör listesini tanıyamıyordu.
 */
const SORT_OPTIONS = [
  { value: 'created_desc', label: 'En yeni giriş üstte' },
  { value: 'created_asc', label: 'En eski giriş üstte' },
  { value: 'assigned_desc', label: 'Son teslim edilen' },
] as const;

// NOT: Bu dosyada yerel bir durum→ton sözlüğü VARDI ve ikonsuz düz `Badge` basıyordu →
// aynı "Teslim edildi" durumu /orders'ta yeşil-ikonlu, burada gri-ikonsuz görünüyordu
// (`quarantined` de burada amber, orada kırmızıydı). Artık panelin TEK rozet bileşeni
// `StatusBadge` kullanılıyor: ton + ikon + Türkçe etiket tek kaynaktan (`ui/badge` +
// `lib/labels`). Yeni bir durum eklenecekse oraya eklenir, buraya değil.

/** Gizli alan maskesi — uzunluk/biçim sızdırmayan sabit gövde (§8 mask deseni). */
const MASK = '••••••';

/**
 * Toplu işlem sonucu — METİN İLE BİRLİKTE TONU da taşır.
 *
 * DENETİM BULGUSU (orta): sonuç notu düz `string` idi ve kutu KOŞULSUZ `variant="success"` +
 * tik ikonu basıyordu. Operatör 40 kalemi "Geçersiz kıl" dediğinde istek düşse bile ekranda
 * YEŞİL ✓ ile "0 lisans düşüldü. Hata: …" beliriyordu → bozuk anahtarlar stokta kalıp
 * satılmaya devam ediyordu. Ton artık sonuçtan türetilir:
 *   destructive → en az bir grup hata verdi (işlem YAPILMADI ya da yarım kaldı)
 *   warning     → hepsi geçti ama bazı kalemler atlandı (arada kapıldı)
 *   success     → istenen her kalem işlendi
 */
type BulkNote = { tone: 'success' | 'warning' | 'destructive'; text: string };

/** Hâlâ "satılabilir" görünen durumlar — stok ömrü dolmuşsa UYARI tonu bunlarda gösterilir. */
const SELLABLE_STATUS = new Set(['available', 'reserved']);

/**
 * GLUE — stok ömrü alanlarının SAVUNMACI okunması.
 *
 * API satırda `expired: boolean` + `expiresAt` döndürür (stock.service.LicenseInventoryRow);
 * admin tarafındaki tip (`app/stock/license-actions.ts`) bu partide DEĞİŞMEDİĞİ için alanlar
 * tipte yok → burada dar bir cast ile okunur. Alan gelmezse (api/admin deploy sapması, eski
 * sürüm) hiçbir şey gösterilmez: bugünkü davranış aynen korunur, ekran KIRILMAZ.
 *
 * NOT: `expired` istemci saatine göre HESAPLANMAZ — sunucudan gelir (tek doğruluk kaynağı).
 */
function stockExpiry(row: LicenseInventoryRow): { expired: boolean; expiresAt: string | null } {
  const r = row as unknown as { expired?: unknown; expiresAt?: unknown };
  const expiresAt = typeof r.expiresAt === 'string' && r.expiresAt.trim() ? r.expiresAt : null;
  return { expired: r.expired === true, expiresAt };
}

/**
 * BOŞ DURUM METNİ — TEK KAYNAK.
 *
 * DENETİM BULGUSU (düşük): metin türetmesi YALNIZ tablo dalında (lg ve üstü) vardı; dar
 * ekrandaki kart dalı `rows.length === 0 ? null` diyordu → 1024px altında arama sonuç
 * vermeyince ekranda HİÇBİR açıklama kalmıyordu (operatör "yükleniyor mu, bozuk mu?"
 * ayrımını yapamıyordu). Metin buraya çıkarıldı ki iki dal AYNI cümleyi göstersin;
 * kopyalanmış ikinci bir metin kümesi ileride sessizce ayrışmasın.
 */
function emptyStateText(args: {
  lockedHolder?: 'customer';
  term: string;
  status: string;
  holder: string;
  productId?: string;
}): { title: string; description: string } {
  const { lockedHolder, term, status, holder, productId } = args;
  // Kilitli kapsamda boş liste bir SONUÇTUR, süzgeç hatası değil: "bu partiden müşterilerde
  // kalem kalmadı" demektir (hepsi değiştirilmiş ya da hiç teslim edilmemiş) — öyle de yazar.
  if (lockedHolder === 'customer' && !term && !status) {
    return {
      title: 'Bu partiden müşterilerde kalem kalmadı.',
      description:
        'Değiştirilecek bir şey yok: bu partinin kalemlerinden hiçbiri şu an bir müşterinin elinde değil.',
    };
  }
  if (term || status || holder) {
    return {
      title: 'Bu süzgeçlerle kayıt bulunamadı.',
      description: 'Aramayı veya süzgeçleri değiştirip tekrar deneyin.',
    };
  }
  if (productId) {
    return {
      title: 'Bu ürüne henüz lisans girilmemiş.',
      description: 'Yukarıdaki “Key / Stok İçe Aktar” bölümünden bu ürüne lisans ekleyebilirsiniz.',
    };
  }
  return {
    title: 'Henüz lisans yok.',
    description:
      'Bir ürünün detay sayfasındaki “Key / Stok İçe Aktar” bölümünden lisans ekleyebilirsiniz.',
  };
}

/**
 * Lisans envanteri tablosu — ürün detayında (`productId` verilir) ve /stock genel
 * listesinde (`showProductColumn`) AYNI bileşen kullanılır.
 *
 * Veri istemciden çekilir ama ADMIN_TOKEN tarayıcıya İNMEZ: `fetchLicenseItemsAction`
 * sunucu action'ı API'ye gider. Arama/filtre/sıralama/sayfalama SUNUCU tarafındadır
 * (LIMIT/OFFSET) → 100 satır seçilse bile istemciye yalnız o sayfa iner, ekran donmaz.
 */
export function LicenseItemsTable({
  productId,
  batchId,
  lockedHolder,
  refreshKey,
  onMutated,
  payloadSchema,
  showProductColumn = false,
  defaultPageSize,
  className,
}: {
  /** Verilirse yalnız bu ürünün kalemleri listelenir (ürün detayı). */
  productId?: string;
  /** Verilirse yalnız bu PARTİYE ait kalemler listelenir (parti detayı). */
  batchId?: string;
  /**
   * Verilirse tablo bu kapsama KİLİTLENİR ve süzgeç kontrolü gösterilmez — kartın başlığı
   * zaten kapsamı söylüyordur (ör. parti detayındaki "Müşterilerdeki lisanslar" kartı).
   */
  lockedHolder?: 'customer';
  /**
   * KARDEŞ TABLO TAZELEME. Aynı sayfada bu tablodan İKİ tane olabilir (parti detayı:
   * "Müşterilerdeki lisanslar" + "Bu partideki lisanslar") ve aynı kalem ikisinde de
   * listelenir. Biri üzerinden değişim/geçersiz kılma yapılınca DİĞERİ bayat kalıyordu →
   * bayat satırdan ikinci tık API'den 400 alıyordu (veri güvenli, ama kafa karıştırıcı).
   * Ebeveyn paylaşılan bir sayaç tutar: her mutasyonda `onMutated` ile artırır, artan
   * `refreshKey` HER İKİ tabloyu birden yeniden çeker.
   */
  refreshKey?: number;
  onMutated?: () => void;
  /**
   * Hesap ürününün alan şeması — YALNIZ tek ürüne daraltılmış listede anlamlı
   * (ürün detayı). Global listede satırlar farklı ürünlerden gelir → gönderilmez.
   */
  payloadSchema?: PayloadFieldDef[] | null;
  /** Global listede ürün kolonu gösterilir (farklı ürünler karışık gelir). */
  showProductColumn?: boolean;
  /**
   * Başlangıç sayfa boyu. Gömülü kullanımlarda (ör. /stock giriş ekranındaki "Son Eklenen
   * Lisanslar" kartı) 25 satır ekranı gereksiz uzatıyordu — orada 10 verilir, operatör
   * yine de kutudan büyütebilir. Verilmezse liste ekranlarındaki davranış aynen korunur.
   */
  defaultPageSize?: (typeof PAGE_SIZES)[number];
  className?: string;
}) {
  const [search, setSearch] = React.useState('');
  const [term, setTerm] = React.useState('');
  const [status, setStatus] = React.useState('');
  const [holder, setHolder] = React.useState<string>(lockedHolder ?? '');
  const [sort, setSort] = React.useState<string>('created_desc');
  const [pageSize, setPageSize] = React.useState<number>(defaultPageSize ?? 25);
  const [page, setPage] = React.useState(1);
  const [reloadKey, setReloadKey] = React.useState(0);

  const [data, setData] = React.useState<LicenseInventoryPage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  // ── TOPLU SEÇİM ──
  // Yalnız STOKTAKİ (available) kalemler seçilebilir: "geçersiz kıl / hasarlı" satılabilir
  // stoğu düşürme işlemidir; teslim edilmiş bir anahtarı buradan öldürmek müşterinin canlı
  // lisansını sessizce bozardı (o akış sipariş detayındaki "Değiştir").
  //
  // KAPSAM: seçim YALNIZ GÖRÜNEN SAYFAYA aittir — sayfa/süzgeç/sıralama değişince SIFIRLANIR
  // (aşağıdaki effect). NEDEN (denetim bulgusu, orta): seçim sayfalar arasında birikiyor ama
  // `runBulk` yalnız o an GÖRÜNEN satırları işleyip ardından TÜM seçimi temizliyordu →
  // 1. sayfada 5, 2. sayfada 3 kalem seçen operatörün 5 kalemi SESSİZCE kayboluyordu
  // (ekranda "3 lisans stoktan düşüldü" yazıyordu, itiraz eden bir uyarı yoktu).
  // İki çözümden (a) "sayfa değişince sıfırla" ve (b) "seçilen satırları Map'te biriktirip
  // tümü üzerinde çalış" arasından (a) seçildi: (b) toplu isteği farklı sayfalardaki
  // (dolayısıyla bayat olabilecek) satırlara yayar ve onay modalindeki önizleme ile gerçek
  // küme yine ayrışabilir. (a) ile sayaç · onay modali · işlenen küme TEK VE AYNI şeyi söyler.
  // Davranış gizli değil: araç çubuğunda ve onay modalinde açıkça yazılır (sessiz davranış yasak).
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = React.useState(false);
  const [bulkNote, setBulkNote] = React.useState<BulkNote | null>(null);
  /** Dışa aktarma sonucu (kaç kayıt indi / kırpıldı mı) — indirme sessiz kalmasın. */
  const [exportNote, setExportNote] = React.useState<LicenseExportNote | null>(null);
  const { confirm, dialog } = useConfirm();
  const announce = useAnnouncer();

  // Aynı sayfada birden çok envanter tablosu olabilir → etiket/kontrol id'leri benzersiz olmalı.
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  // Arama sunucuya gider → tuş başına istek atmamak için debounce.
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(search.trim()), 350);
    return () => clearTimeout(t);
  }, [search]);

  // Süzgeç/sıralama/sayfa boyutu değişince ilk sayfaya dön (aksi halde boş sayfada kalınır).
  React.useEffect(() => {
    setPage(1);
  }, [term, status, holder, sort, pageSize]);

  // Seçim SAYFA/SÜZGEÇ değişiminde bilerek sıfırlanır (yukarıdaki kapsam notu): toplu işlem
  // yalnız görünen sayfayı işlediği için seçimin sayfalar arası birikmesi VAAT EDİLMEYEN bir
  // davranıştı ve sessiz kayba yol açıyordu.
  //
  // SONUÇ NOTU BURADA TEMİZLENMEZ (denetim bulgusu, düşük): toplu geçersiz kılmadan sonra liste
  // daralıyor, son sayfa boşalıyor ve aşağıdaki OTOMATİK sayfa düzeltmesi (`page > pageCount`)
  // `page`i değiştiriyordu → bu effect notu siliyor, operatör "kaç kalem düştü, kaçı atlandı"
  // sonucunu HİÇ göremiyordu (özellikle hata/uyarı tonunu). Not artık yalnız KULLANICI kaynaklı
  // değişimde (`clearBulkNote`: arama/süzgeç/sıralama/sayfa düğmeleri) temizlenir.
  React.useEffect(() => {
    setSelected(new Set());
  }, [page, term, status, holder, sort, pageSize]);

  /**
   * Toplu işlem sonucunu temizler — YALNIZ kullanıcı listeyi kendi değiştirdiğinde çağrılır.
   * Otomatik tazeleme/sayfa düzeltmesi notu silmez (yukarıdaki not).
   */
  const clearBulkNote = React.useCallback(() => {
    setBulkNote(null);
    // Dışa aktarma notu da o ANKİ süzgece aitti (ör. "N kayıt indirildi") — liste değişince
    // yanıltıcı olur, aynı kullanıcı-kaynaklı olayda temizlenir.
    setExportNote(null);
  }, []);

  // Yarışan yanıtlar: yalnız EN SON isteğin sonucu ekrana yazılır (eski yanıt üzerine binmez).
  const reqId = React.useRef(0);
  React.useEffect(() => {
    const id = ++reqId.current;
    let cancelled = false;
    setLoading(true);
    fetchLicenseItemsAction({
      productId,
      batchId,
      status,
      holder: holder || undefined,
      search: term,
      page,
      pageSize,
      sort,
    })
      .then((res) => {
        if (cancelled || id !== reqId.current) return;
        if (res.ok && res.page) {
          setData(res.page);
          setError(null);
        } else {
          setError(res.error ?? 'Lisans listesi alınamadı.');
        }
      })
      .catch(() => {
        if (!cancelled && id === reqId.current) setError('Lisans listesi alınamadı.');
      })
      .finally(() => {
        if (!cancelled && id === reqId.current) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [productId, batchId, status, holder, term, page, pageSize, sort, reloadKey, refreshKey]);

  /** Yalnız BU tabloyu tazeler (süzgeç/sayfa değişimi, "Yenile" düğmesi). */
  const reload = React.useCallback(() => setReloadKey((k) => k + 1), []);
  /**
   * VERİYİ DEĞİŞTİREN işlemden sonra: kendini tazele + ebeveyni haberdar et (kardeş tablo
   * da tazelensin). `onMutated` verilmemişse davranış aynen eskisi gibi kalır.
   */
  const reloadAfterMutation = React.useCallback(() => {
    reload();
    onMutated?.();
  }, [reload, onMutated]);

  const total = data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / (data?.pageSize ?? pageSize)));

  // Kayıt silinince son sayfa boşalabilir → geçerli aralığa çek.
  React.useEffect(() => {
    if (data && page > pageCount) setPage(pageCount);
  }, [data, page, pageCount]);

  const rows = data?.rows ?? [];
  const from = total === 0 ? 0 : (page - 1) * (data?.pageSize ?? pageSize) + 1;
  const to = total === 0 ? 0 : from + rows.length - 1;
  const colCount = (showProductColumn ? 8 : 7) + 1; // +1: seçim kolonu
  // Boş durum metni TEK yerden türetilir → kart (dar ekran) ve tablo (geniş ekran) dalları
  // aynı cümleyi gösterir.
  const empty = emptyStateText({ lockedHolder, term, status, holder, productId });

  // ── Seçim türevleri ──
  const selectableIds = React.useMemo(
    () => rows.filter((r) => r.status === 'available').map((r) => r.id),
    [rows],
  );
  // Seçim sayfa/süzgeç değişiminde sıfırlanır, AMA liste yerinde tazelenebilir (kardeş tablo
  // mutasyonu, "Yenile"): seçili bir kalem o sırada atanmış/iptal edilmiş olabilir. Sayaç ve
  // toplu işlem bu yüzden hâlâ GÖRÜNÜR satırların kimlikleriyle çalışır — id → satır eşlemesi
  // lazım (bayat id ile istek atıp "hata" almak yerine kalem sessizce listeden düşer).
  const rowById = React.useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selectedVisible = React.useMemo(
    () => [...selected].filter((id) => rowById.has(id)),
    [selected, rowById],
  );
  const allVisibleSelected =
    selectableIds.length > 0 && selectableIds.every((id) => selected.has(id));
  const someVisibleSelected = selectableIds.some((id) => selected.has(id));

  const toggleRow = React.useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const toggleAllVisible = React.useCallback(
    (on: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of selectableIds) {
          if (on) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [selectableIds],
  );

  /**
   * Toplu "geçersiz kıl / hasarlı". Seçim farklı ÜRÜNLERE yayılabilir (genel /stock listesi);
   * `/v1/admin/stock-adjustments` ürün-kapsamlı olduğu için istemci ürüne göre gruplar ve
   * grup başına bir istek atar. Sonuç TOPLANIR ve atlananlar dürüstçe raporlanır.
   */
  const runBulk = React.useCallback(
    async (action: 'void' | 'damage') => {
      const ids = selectedVisible.filter((id) => rowById.get(id)?.status === 'available');
      if (ids.length === 0) return;

      const label = action === 'void' ? 'Geçersiz kıl' : 'Hasarlı işaretle';
      const preview = ids
        .slice(0, 8)
        .map((id) => {
          const r = rowById.get(id)!;
          const name = r.kind === 'account'
            ? ((r.fields ?? []).find((f) => !f.secret)?.value ?? 'Hesap kaydı')
            : (r.value ?? 'Anahtar');
          return r.batchCode ? `${name} · ${r.batchCode}` : name;
        });
      if (ids.length > preview.length) preview.push(`… ve ${ids.length - preview.length} kayıt daha`);

      const res = await confirm({
        title: `${ids.length} lisans stoktan düşülecek`,
        description:
          'Bu kalemler "geçersiz" olur; bir daha teslim edilmezler ve Kusurlu Stok ekranında sebebiyle listelenirler. İşlem geri alınamaz. Yalnız BU SAYFADA seçtikleriniz işlenir — sayfa değiştirirseniz seçim sıfırlanır.',
        details: preview,
        tone: 'danger',
        confirmLabel: label,
        reason: {
          label: 'Sebep',
          placeholder: 'ör. tedarikçi partisi bozuk — kalemler etkinleşmiyor',
          required: true,
          minLength: 3,
          inputType: 'textarea',
          hint: 'Denetim kaydına ve Kusurlu Stok listesine yazılır.',
        },
      });
      if (!res) return;

      setBulkBusy(true);
      setBulkNote(null);
      try {
        // Ürüne göre grupla (tek ürünlü listede tek grup olur).
        const groups = new Map<string, string[]>();
        for (const id of ids) {
          const pid = rowById.get(id)!.productId;
          groups.set(pid, [...(groups.get(pid) ?? []), id]);
        }
        let affected = 0;
        let skipped = 0;
        const errors: string[] = [];
        for (const [pid, groupIds] of groups) {
          const out = await bulkAdjustLicenseItemsAction({
            productId: pid,
            licenseItemIds: groupIds,
            action,
            reason: res.reason,
          });
          if (out.ok) {
            affected += out.affected;
            skipped += out.skipped;
          } else {
            errors.push(out.error);
          }
        }
        // SONUÇ TONU (denetim bulgusu): hata da başarı da aynı yeşil kutuya yazılıyordu.
        // Artık en kötü sonuç tonu belirler ve HATA DALINDA SEÇİM KORUNUR — operatör aynı
        // kalemleri yeniden seçmek zorunda kalmadan tekrar deneyebilsin (bozuk anahtarlar
        // stokta kalmışken "başarılı" hissi vermek kabul edilemez).
        const note: BulkNote = errors.length
          ? {
              tone: 'destructive',
              text:
                affected > 0
                  ? `İşlem YARIM kaldı: ${affected} lisans düşüldü, kalanı düşülemedi. Hata: ${errors[0]} — seçim korundu, tekrar deneyebilirsiniz.`
                  : `Hiçbir lisans düşülemedi. Hata: ${errors[0]} — seçim korundu, tekrar deneyebilirsiniz.`,
            }
          : skipped > 0
            ? {
                tone: 'warning',
                text: `${affected} lisans stoktan düşüldü, ${skipped} tanesi atlandı (artık stokta değildi).`,
              }
            : { tone: 'success', text: `${affected} lisans stoktan düşüldü.` };
        setBulkNote(note);
        announce(note.text);
        if (!errors.length) setSelected(new Set());
        // Toplu düşme de veriyi DEĞİŞTİRİR → kardeş tablo da tazelenmeli. Hata dalında da
        // çağrılır: gruplardan biri başarılı olmuş olabilir, liste gerçeği göstermeli.
        reloadAfterMutation();
      } finally {
        setBulkBusy(false);
      }
    },
    [selectedVisible, rowById, confirm, announce, reloadAfterMutation],
  );

  return (
    <div className={cn('space-y-3', className)}>
      {/*
        ── Üst çubuk: arama + süzgeçler ──
        DAR EKRAN: dört süzgeç `flex-wrap` ile alt alta düşüyordu (etiket+kontrol ≈ 50px ×4
        ≈ 200px, tablo daha başlamadan ekran doluyordu). 360px'te iki sütunlu ızgara → aynı
        süzgeçler ~100px'te sığar; sm ve üstünde eski tek satırlık akış aynen korunur.
      */}
      <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
        <div className="col-span-2 flex min-w-56 flex-1 flex-col gap-1">
          <label htmlFor={`${uid}-search`} className="text-xs font-medium text-foreground/70">
            Ara
          </label>
          <SearchInput
            id={`${uid}-search`}
            value={search}
            // Kullanıcı listeyi değiştiriyor → önceki toplu işlem sonucu artık bu listeye ait
            // değil, temizlenir (otomatik tazelemede temizlenmez — bkz. clearBulkNote notu).
            onValueChange={(v) => {
              setSearch(v);
              clearBulkNote();
            }}
            placeholder="Tam anahtar veya son 5 hane, ürün, e-posta, sipariş no…"
            ariaLabel="Lisans ara"
            className="w-full"
          />
        </div>
        <ToolbarSelect
          id={`${uid}-status`}
          label="Durum"
          value={status}
          onChange={(v) => {
            setStatus(v);
            clearBulkNote();
          }}
          options={STATUS_OPTIONS}
        />
        {/* Kapsam kontrolü yalnız KİLİTLİ DEĞİLKEN gösterilir: kilitli kullanımda
            (parti detayındaki "Müşterilerdeki lisanslar" kartı) kapsamı başlık söyler,
            operatörün onu kazara değiştirip listeyi anlamsızlaştırması istenmez. */}
        {!lockedHolder && (
          <ToolbarSelect
            id={`${uid}-holder`}
            label="Kim tutuyor"
            value={holder}
            onChange={(v) => {
              setHolder(v);
              clearBulkNote();
            }}
            options={HOLDER_OPTIONS}
          />
        )}
        <ToolbarSelect
          id={`${uid}-sort`}
          label="Sıralama"
          value={sort}
          onChange={(v) => {
            setSort(v);
            clearBulkNote();
          }}
          options={SORT_OPTIONS}
        />
        <ToolbarSelect
          id={`${uid}-size`}
          label="Sayfada"
          value={String(pageSize)}
          onChange={(v) => {
            setPageSize(Number(v));
            clearBulkNote();
          }}
          options={PAGE_SIZES.map((n) => ({ value: String(n), label: `${n} kayıt` }))}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={reload}
          disabled={loading}
          aria-label="Listeyi yenile"
        >
          <RefreshCw aria-hidden className={loading ? 'animate-spin' : undefined} /> Yenile
        </Button>
        {/*
          DIŞA AKTARMA — mutabakat/muhasebe (§12/§13). Kapsam/içerik/biçim seçimi ve rol+KVKK
          davranışı `license-export-panel.tsx` jsdoc'unda. Süzgeçler AYNEN geçirilir ki
          "tüm süzgeç sonucu" dosyası ekrandaki listeyle aynı kümeyi anlatsın.
        */}
        <LicenseExportPanel
          rows={rows}
          total={total}
          masked={data?.masked}
          disabled={loading}
          onResult={(n) => {
            setExportNote(n);
            announce(n.text);
          }}
          params={{
            productId,
            batchId,
            status,
            holder: holder || undefined,
            search: term,
            sort,
          }}
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Aranabilenler: <strong>anahtarın tamamı</strong> ya da <strong>son 5 hanesi</strong>,
        ürün adı/SKU, müşteri e-postası, mağaza sipariş numarası, parti kodu. Anahtarlar şifreli
        saklandığı için parça arama (ortadan birkaç hane) yapılamaz — tam değer veya son 5 hane
        gerekir; büyük/küçük harf ve boşluk farkı sorun değildir.
      </p>

      {error && (
        <Alert variant="destructive">
          <ShieldAlert aria-hidden />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* Sonuç kutusu TONUYLA gelir (başarı/uyarı/hata) — ikon da tona uyar; hata artık
          yeşil tik ile gösterilmez (bkz. BulkNote notu). */}
      {bulkNote && (
        <Alert variant={bulkNote.tone}>
          {bulkNote.tone === 'success' ? <Check aria-hidden /> : <ShieldAlert aria-hidden />}
          <AlertDescription>{bulkNote.text}</AlertDescription>
        </Alert>
      )}

      {/* Dışa aktarma sonucu — kırpılma UYARI tonuyla gelir (sessiz eksik dosya yasak). */}
      {exportNote && (
        <Alert variant={exportNote.tone}>
          {exportNote.tone === 'success' ? <Check aria-hidden /> : <ShieldAlert aria-hidden />}
          <AlertDescription>{exportNote.text}</AlertDescription>
        </Alert>
      )}

      {/* ── Toplu aksiyon çubuğu ──
          Yalnız seçim varken görünür. Bozuk bir tedarikçi partisini tek tek seçiciden
          bulmak yerine listede süzüp (parti/tedarikçi/arama) topluca düşmenin yolu budur. */}
      {selectedVisible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <span className="text-sm font-medium text-foreground">
            Bu sayfada {selectedVisible.length} lisans seçildi
          </span>
          {/* Seçimin SAYFAYA bağlı olduğu görünür yazılır: kapsam sayaç/onay/işlenen küme
              arasında tek ve aynı olsun, operatör "5'i nereye gitti" demesin. */}
          <span className="text-xs text-muted-foreground">
            (yalnız stoktakiler seçilebilir — teslim edilmiş kalem buradan düşülemez; sayfa veya
            süzgeç değişirse seçim sıfırlanır)
          </span>
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSelected(new Set())}
              disabled={bulkBusy}
            >
              Seçimi temizle
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void runBulk('damage')}
              disabled={bulkBusy}
            >
              <ShieldAlert aria-hidden /> Hasarlı işaretle
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => void runBulk('void')}
              disabled={bulkBusy}
            >
              <ShieldAlert aria-hidden /> Geçersiz kıl
            </Button>
          </span>
        </div>
      )}

      {/*
        ── DAR EKRAN: KART LİSTESİ (md altı) ──
        Kullanıcı: "küçük ekranlarda sıkışıyor, yana kaydırma sorunu var, tablolar çok
        yüksek duruyor". ÖLÇÜLDÜ (375px): kolonları gizlemek YETMİYOR — kalan dört kolonun
        min-content genişliği 856px ve kap 291px, yani tablo hâlâ 565px yana kayıyordu
        (anahtar tek parça monospace metin, ürün adı + SKU, iki metin düğmesi).
        5 kolonlu bir tablo 291px'e SIĞMAZ; bu yüzden dar ekranda satır KARTA dönüşür.
        Hücre bileşenleri (LicenseValueCell/StatusCell/DeliveryCell/LicenseItemActions)
        AYNEN yeniden kullanılır → iki ayrı doğruluk kaynağı oluşmaz.
      */}
      <div className="space-y-2 lg:hidden" aria-busy={loading}>
        {loading && rows.length === 0 ? (
          Array.from({ length: 3 }).map((_, i) => (
            <div key={`mc-sk-${i}`} className="rounded-lg border border-border p-3">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="mt-2 h-3 w-1/3" />
            </div>
          ))
        ) : rows.length === 0 ? (
          // DAR EKRANDA DA BOŞ DURUM (denetim bulgusu): burada `null` dönülüyordu → 1024px
          // altında arama sonuç vermeyince ekranda hiçbir açıklama kalmıyordu. Metin tablo
          // dalıyla AYNI kaynaktan (`emptyStateText`) gelir.
          <div className="rounded-lg border border-border">
            <EmptyState icon={KeyRound} title={empty.title} description={empty.description} />
          </div>
        ) : (
          rows.map((row) => (
            <div
              key={`mc-${row.id}`}
              className={cn(
                'rounded-lg border border-border p-3',
                loading && 'opacity-60',
                selected.has(row.id) && 'bg-accent',
              )}
            >
              <div className="flex items-start gap-2">
                {row.status === 'available' ? (
                  <label className="-m-1 flex size-9 shrink-0 cursor-pointer items-center justify-center">
                    <Checkbox
                      checked={selected.has(row.id)}
                      disabled={bulkBusy}
                      onChange={(e) => toggleRow(row.id, e.currentTarget.checked)}
                      aria-label="Bu lisansı seç"
                    />
                  </label>
                ) : (
                  <span className="size-9 shrink-0" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <LicenseValueCell row={row} />
                  {showProductColumn && (
                    <Link
                      href={`/products/${row.productId}`}
                      className="mt-1 block truncate text-xs font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      {row.productName}
                    </Link>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <StatusCell row={row} />
                    {row.batchCode && <span className="truncate">{row.batchCode}</span>}
                    {row.usageMode === 'multi' && (
                      <span className="tabular-nums">kalan {row.remainingUses}</span>
                    )}
                    {/*
                      Aksiyonlar DURUM SATIRINDA (sağa yaslı) — ayrı bir alt satır kart
                      başına ~36px eklerdi (şikâyet zaten yükseklikti). Kartın SAĞ ÜSTÜNDE
                      de duramaz: orada `shrink-0` ile 165px yiyor ve anahtara 58px kalıyordu
                      → 29 karakterlik anahtar BEŞ satıra sarıyordu (ölçüldü, 375px). Burada
                      anahtar kartın tam genişliğini alır (~223px → en fazla iki satır).
                    */}
                    <div className="ml-auto shrink-0">
                      <LicenseItemActions
                        row={row}
                        payloadSchema={productId ? payloadSchema : undefined}
                        onDone={reloadAfterMutation}
                      />
                    </div>
                  </div>
                  {row.delivered && (
                    <div className="mt-1.5">
                      <DeliveryCell row={row} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ── Tablo (md ve üstü) ── */}
      <div
        className="hidden rounded-lg border border-border lg:block"
        aria-busy={loading}
      >
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {/* Kutunun GÖRSEL boyutu 16px kalır (form kullanımlarıyla tutarlı), dokunma
                  hedefi label sarmalayıcısıyla 44px'e çıkar — toplu seçim ekranın ana işi. */}
              <TableHead className="w-11 p-0">
                <label className="flex size-11 cursor-pointer items-center justify-center">
                  <Checkbox
                    checked={allVisibleSelected}
                    indeterminate={!allVisibleSelected && someVisibleSelected}
                    disabled={selectableIds.length === 0 || bulkBusy}
                    onChange={(e) => toggleAllVisible(e.currentTarget.checked)}
                    aria-label="Bu sayfadaki stoktaki lisansların tümünü seç"
                  />
                </label>
              </TableHead>
              {showProductColumn && <TableHead>Ürün</TableHead>}
              <TableHead>Lisans / Hesap</TableHead>
              <TableHead>Durum</TableHead>
              <TableHead className="hidden 2xl:table-cell">Kapasite</TableHead>
              <TableHead className="hidden 2xl:table-cell">Parti</TableHead>
              <TableHead className="hidden xl:table-cell">Teslimat</TableHead>
              <TableHead className="hidden 2xl:table-cell">Eklenme</TableHead>
              <TableHead className={cn('text-right', STICKY_ACTIONS)}>
                <span className="sr-only">İşlemler</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && rows.length === 0 ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={`sk-${i}`} className="hover:bg-transparent">
                  {Array.from({ length: colCount }).map((__, j) => (
                    <TableCell key={`sk-${i}-${j}`}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount}>
                  {/* Metin `emptyStateText` tek kaynağından (kart dalı da aynısını kullanır). */}
                  <EmptyState icon={KeyRound} title={empty.title} description={empty.description} />
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  className={cn('align-top', loading && 'opacity-60')}
                  data-state={selected.has(row.id) ? 'selected' : undefined}
                >
                  {/* p-0 + 44px label: kutu 16px görünür ama dokunma hedefi 44px olur; label'ın
                      merkezi ~22px'e denk geldiği için komşu hücrenin ilk satırıyla hizası korunur. */}
                  <TableCell className="w-11 p-0">
                    {/* Yalnız STOKTAKİ kalem seçilebilir; diğerlerinde kutu hiç basılmaz ki
                        "neden tıklayamıyorum" sorusu doğmasın (disabled kutu da kafa karıştırır). */}
                    {row.status === 'available' ? (
                      <label className="flex size-11 cursor-pointer items-center justify-center">
                        <Checkbox
                          checked={selected.has(row.id)}
                          disabled={bulkBusy}
                          onChange={(e) => toggleRow(row.id, e.currentTarget.checked)}
                          aria-label="Bu lisansı seç"
                        />
                      </label>
                    ) : (
                      <span className="sr-only">Seçilemez — stokta değil</span>
                    )}
                  </TableCell>
                  {showProductColumn && (
                    <TableCell className="max-w-36 2xl:max-w-40">
                      <Link
                        href={`/products/${row.productId}`}
                        className="block truncate font-medium text-foreground underline-offset-4 hover:underline"
                        title={row.productName}
                      >
                        {row.productName}
                      </Link>
                      <div className="truncate font-mono text-xs text-muted-foreground">
                        {row.productSku}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {productKindLabel(row.productType)}
                      </div>
                    </TableCell>
                  )}

                  {/*
                    TABAN GENİŞLİK ŞART: `break-all` bir hücrenin min-content genişliğini
                    TEK KARAKTERE indirir → tablo auto-layout'ta bu kolon eziliyor ve anahtar
                    beş satıra sarıyordu (1024px'te ölçüldü: kolon 63px, hücre 96px yüksek —
                    kırpmadan bile kötü). `min-w-52` ile kolon en az 208px alır: 29 karakterlik
                    anahtar en fazla iki satır olur, hiçbir hane kaybolmaz.
                  */}
                  <TableCell className="min-w-[19rem]">
                    <LicenseValueCell row={row} />
                    {/*
                      DAR EKRAN ÖZETİ (kullanıcı: "küçük ekranlarda sıkışıyor, yana kaydırma
                      sorunu var"): Kapasite/Parti/Teslimat/Eklenme kolonları md/lg/xl altında
                      GİZLİ — bilgileri kaybolmasın diye burada tek satırda özetlenir. Yalnız
                      DOLU olanlar yazılır; kolonlar görünür olduğunda bu satır kaybolur
                      (aynı bilgiyi iki kez göstermek satırı yine şişirirdi).
                    */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground 2xl:hidden">
                      {row.delivered && (
                        <Link
                          href={`/orders/${row.delivered.orderId}`}
                          className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline xl:hidden"
                        >
                          #{row.delivered.remoteOrderId || '—'}
                        </Link>
                      )}
                      {row.batchCode && <span className="truncate">{row.batchCode}</span>}
                      {row.usageMode === 'multi' && (
                        <span className="tabular-nums 2xl:hidden">
                          kalan {row.remainingUses}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell>
                    <StatusCell row={row} />
                  </TableCell>

                  <TableCell className="hidden whitespace-nowrap tabular-nums text-muted-foreground 2xl:table-cell">
                    {row.usageMode === 'multi' ? (
                      <span title={`${row.useCount} kullanıldı / ${row.maxUses} toplam`}>
                        {row.useCount}/{row.maxUses}
                        <span className="block text-xs">kalan {row.remainingUses}</span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="hidden max-w-40 2xl:table-cell">
                    {row.batchCode ? (
                      <>
                        <div className="truncate text-foreground/90" title={row.batchCode}>
                          {row.batchCode}
                        </div>
                        {row.supplierName && (
                          <div
                            className="truncate text-xs text-muted-foreground"
                            title={row.supplierName}
                          >
                            {row.supplierName}
                          </div>
                        )}
                      </>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>

                  <TableCell className="hidden max-w-56 xl:table-cell">
                    <DeliveryCell row={row} />
                  </TableCell>

                  <TableCell className="hidden whitespace-nowrap tabular-nums text-xs text-muted-foreground 2xl:table-cell">
                    <span title={fmtDateTime(row.createdAt)}>
                      {new Date(row.createdAt).toLocaleDateString("tr-TR", { dateStyle: "short" })}
                    </span>
                  </TableCell>

                  <TableCell className={cn('text-right', STICKY_ACTIONS)}>
                    <LicenseItemActions
                      row={row}
                      payloadSchema={productId ? payloadSchema : undefined}
                      onDone={reloadAfterMutation}
                      compact
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* ── Sayaç + sayfalama ── */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {total === 0
            ? 'Kayıt yok'
            : `${total} kalemden ${from}-${to} arası gösteriliyor`}
        </p>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            Sayfa {page} / {pageCount}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPage((p) => Math.max(1, p - 1));
              clearBulkNote();
            }}
            disabled={loading || page <= 1}
            aria-label="Önceki sayfa"
          >
            <ChevronLeft aria-hidden /> Önceki
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setPage((p) => Math.min(pageCount, p + 1));
              clearBulkNote();
            }}
            disabled={loading || page >= pageCount}
            aria-label="Sonraki sayfa"
          >
            Sonraki <ChevronRight aria-hidden />
          </Button>
        </div>
      </div>

      {/* Onay modali (sebep zorunlu) — toplu geçersiz kılma buradan geçer. */}
      {dialog}
    </div>
  );
}

/** Üst çubuk süzgeci — görünür etiket + native select (klavye/ekran okuyucu dostu). */
function ToolbarSelect({
  id,
  label,
  value,
  onChange,
  options,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-foreground/70">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(selectClass, 'h-8 w-auto py-0 text-xs')}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Durum hücresi — kalemin ham durumu + STOK ÖMRÜ işareti.
 *
 * NEDEN AYRI İŞARET: bir kalem `status='available'` (yani "Stokta") görünürken stok ömrü
 * (`expiresAt`) dolmuş olabilir; API bu kalemi HİÇBİR stok toplamına katmaz ve ATAMAZ. Yalnız
 * "Stokta" yazmak liste ile sayaçları çelişkili gösterir ("stokta görünüyor ama satılmıyor").
 * Ton: satılabilir görünen durumda UYARI (operatör aksiyon almalı — yenile/geçersiz kıl),
 * teslim edilmiş/ölü kayıtta NÖTR (yalnız bilgi, aksiyon gerekmez).
 *
 * Etiketler `lib/labels.ts` tek-kaynağından gelir; ham enum/İngilizce sızmaz.
 */
function StatusCell({ row }: { row: LicenseInventoryRow }) {
  const { expired, expiresAt } = stockExpiry(row);
  // Durumu zaten "Süresi doldu" olan kayıtta ikinci bir işaret gürültüdür.
  const showExpiredFlag = expired && row.status !== 'expired';
  const dateHint = expiresAt
    ? `Stok ömrü ${fmtDateTime(expiresAt)} tarihinde doldu — bu kalem satılamaz/atanamaz.`
    : 'Stok ömrü doldu — bu kalem satılamaz/atanamaz.';

  return (
    <div className="flex flex-col items-start gap-1">
      <StatusBadge status={row.status} />

      {showExpiredFlag &&
        (SELLABLE_STATUS.has(row.status) ? (
          <Badge variant="warning" title={dateHint}>
            <Clock aria-hidden />
            Süresi dolmuş
          </Badge>
        ) : (
          <span className="text-xs text-muted-foreground" title={dateHint}>
            süresi dolmuş
          </span>
        ))}

      {/* Henüz dolmamış ömür: FEFO sırasını anlamak için tarih ipucu (sessiz sürpriz olmasın). */}
      {!expired && expiresAt && (
        <span
          className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
          title="Stok ömrü bitiş tarihi (FEFO: en erken bitecek kalem önce atanır)"
        >
          ömür bitişi {fmtDateTime(expiresAt)}
        </span>
      )}
    </div>
  );
}

/**
 * Lisans/hesap hücresi. Panel kimlik-doğrulamalı olduğu için değer AÇIK gösterilir
 * (sipariş detayı ile aynı politika); yalnız hesap ürününün "gizli" alanları (parola)
 * varsayılan olarak maskelenir — omuz-sörfü riskini azaltır, tek tıkla açılır.
 */
function LicenseValueCell({ row }: { row: LicenseInventoryRow }) {
  const [shown, setShown] = React.useState(false);
  const hasSecret = (row.fields ?? []).some((f) => f.secret);

  if (row.kind === 'account') {
    if (!row.fields || row.fields.length === 0) {
      return <span className="text-xs text-muted-foreground">Hesap alanları okunamadı</span>;
    }
    const copyText = row.fields
      .map((f) => `${f.label}: ${f.value}`)
      .join('\n');
    return (
      <div className="space-y-1">
        {row.fields.map((f) => (
          <div key={f.key} className="flex gap-1.5 text-xs">
            <span className="shrink-0 text-muted-foreground">{f.label}:</span>
            <span
              // Hesap alanı da kırpılmaz (anahtarla aynı gerekçe): parola/kullanıcı adının
              // sonu görünmezse kalem ayırt edilemez. Gizliyse zaten maske basılır.
              className="min-w-0 whitespace-normal break-all font-mono text-foreground/90"
              title={f.secret && !shown ? 'Gizli alan — göstermek için Göster' : f.value}
            >
              {f.secret && !shown ? MASK : f.value}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-1 pt-0.5">
          {hasSecret && (
            <Button
              variant="ghost"
              size="sm"
              // Yükseklik ezmesi kaldırıldı (sm = 32px): yanındaki kopyala düğmesi 32px'e
              // çıktığı için ikilinin aynı ölçekte kalması şart.
              onClick={() => setShown((s) => !s)}
              aria-label={shown ? 'Gizli alanları gizle' : 'Gizli alanları göster'}
            >
              {shown ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
              {shown ? 'Gizle' : 'Göster'}
            </Button>
          )}
          <CopyButton text={copyText} label="Hesap bilgilerini kopyala" />
        </div>
      </div>
    );
  }

  if (!row.value) {
    return <span className="text-xs text-muted-foreground">Lisans okunamadı</span>;
  }
  /*
   * İKİ MOD (ölçüldü):
   * • lg ALTI (kart) — flex DEĞİL, akış: anahtar `inline` sarar, kopyala düğmesi son
   *   harfin HEMEN ardından gelir. Burada flex kullanmak KIRIYORDU: `break-all` ile
   *   min-content 1 karakter olduğu için flex item 20px'e eziliyor ve anahtar dikey
   *   harf sütununa dönüşüyordu (ölçüldü: 20px genişlik / 289px yükseklik).
   * • lg ÜSTÜ (tablo) — flex + tek satır; düğme metnin 6px sağında.
   */
  return (
    <div className="lg:flex lg:items-center lg:gap-1.5">
      {/*
        KIRPMA YOK (kullanıcı: "lisans tamamen görünmüyor, son haneleri"): anahtar
        `truncate` ile tek satıra sıkıştırılıp sonu "…" oluyordu ve dar ekranda kalemi
        AYIRT EDEN kısım (son haneler) tam olarak kaybolan kısımdı. `break-all` ile dar
        alanda iki satıra sarar, geniş ekranda zaten tek satıra sığar (29 karakter ≈ 244px,
        kolon 288px). Kopyalamak için hâlâ tek tık var.
      */}
      <code
        // md ALTI (kart görünümü): sar — kap ~250px, anahtar iki satıra iner, hiçbir hane
        // kaybolmaz. md ÜSTÜ (tablo): TEK SATIR — `break-all` tabloda min-content'i tek
        // karaktere indirip kolonu 140px'e eziyordu (1440px'te bile iki satır; ölçüldü).
        // Kolonun `min-w-[19rem]` tabanıyla 29 karakterlik anahtar tek satıra sığar.
        //
        // `flex-1` YOK (kullanıcı: "copy ikonu çok alakasız yerde, çok mesafe var"):
        // büyütücü verilince metin hücrenin TAMAMINI kaplıyor ve kopyala düğmesi kolonun
        // sağ ucuna itiliyordu (ölçüldü: kısa anahtarda ~330px uzakta). Şimdi metin
        // içeriği kadar yer kaplar, düğme hemen yanında durur; `min-w-0` uzun anahtarın
        // gerektiğinde sarmasını korur.
        className="inline min-w-0 whitespace-normal break-all font-mono text-sm leading-snug text-foreground/90 lg:block lg:whitespace-nowrap lg:break-normal"
        title={row.value}
      >
        {row.value}
      </code>
      <CopyButton
        text={row.value}
        label="Lisans/hesap değerini kopyala"
        // Kart modunda akışta olduğu için kendi boşluğunu kendi verir (tabloda boşluk
        // konteynerin `gap`'inden gelir).
        className="ml-1 align-middle lg:ml-0"
      />
    </div>
  );
}

/** Panoya kopyala + kısa geri bildirim (izin yoksa dürüst uyarı). */
function CopyButton({
  text,
  label,
  className,
}: {
  text: string;
  label: string;
  className?: string;
}) {
  const [state, setState] = React.useState<'idle' | 'ok' | 'fail'>('idle');
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('ok');
    } catch {
      setState('fail');
    }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 1600);
  }

  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <Button
        variant="ghost"
        size="icon-sm"
        // `size-6` ezmesi kaldırıldı: icon-sm zaten 32px ve dokunma hedefi tabanı bu.
        // 24px'e indirmek yoğun tablo satırında yanlış öğeye basma riski üretiyordu.
        className="shrink-0"
        onClick={copy}
        aria-label={label}
        title={label}
      >
        {state === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />}
      </Button>
      {state !== 'idle' && (
        <span
          role="status"
          className={cn('text-xs', state === 'ok' ? 'text-success' : 'text-destructive')}
        >
          {state === 'ok' ? 'Kopyalandı' : 'Kopyalanamadı'}
        </span>
      )}
    </span>
  );
}

/**
 * Teslimat hücresi — kalem bir siparişe verilmişse müşteri/site/sipariş bağlantısı.
 * Mağaza linki (`storeAdminUrl`) YALNIZ backend üretebildiyse görünür ve yeni sekmede
 * açılır: panel mağazaya bağlanmaz/oturum açmaz, SALT URL yönlendirmesidir (§17).
 */
function DeliveryCell({ row }: { row: LicenseInventoryRow }) {
  const d = row.delivered;
  if (!d) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="space-y-0.5 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Link
          href={`/orders/${d.orderId}`}
          className="font-medium tabular-nums text-foreground underline-offset-4 hover:underline"
          title="Panelde sipariş detayını aç"
        >
          #{d.remoteOrderId || '—'}
        </Link>
        {d.storeAdminUrl && (
          <a
            href={d.storeAdminUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 rounded-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            title={`${siteTypeLabel(d.siteType) || 'Mağaza'} panelinde aç`}
            aria-label={`Siparişi ${d.siteDomain} mağaza panelinde yeni sekmede aç`}
          >
            <ExternalLink className="size-3" aria-hidden />
            Mağazada aç
          </a>
        )}
      </div>
      {d.customerEmail && (
        <div className="truncate text-foreground/90" title={d.customerEmail}>
          {d.customerEmail}
        </div>
      )}
      <div className="max-w-40 truncate text-muted-foreground" title={d.siteDomain}>
        {d.siteDomain || '—'}
      </div>
      <div className="tabular-nums text-muted-foreground">
        {d.assignedAt ? fmtDateTime(d.assignedAt) : '—'}
        {d.validUntil && <> · bitiş {fmtDateTime(d.validUntil)}</>}
      </div>
      {d.assignmentStatus !== 'active' && (
        <div className="text-muted-foreground">{assignmentStatusLabel(d.assignmentStatus)}</div>
      )}
    </div>
  );
}
