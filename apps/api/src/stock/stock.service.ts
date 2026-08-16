import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  AccountPayloadSchema,
  AUTO_RECEIPT_NOTE_PREFIX,
  parseAccountPayload,
  serializeAccountPayload,
  maskSecret,
  looksMasked,
  maskAccountFields,
  type AccountPayloadSchema as AccountPayloadSchemaT,
} from '@lisans/shared';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { CryptoService } from '../crypto/crypto.service';
import {
  auditLog,
  batches,
  fulfillmentEvents,
  licenseItems,
  orderLines,
  orders,
  products,
  purchaseOrders,
  stockAdjustments,
  suppliers,
  type NewLicenseItem,
  type Product,
} from '../db/schema';
import { notExpiredCond } from '../assignment/assign';
import { ProductsService } from '../products/products.service';
import { FulfillmentService } from '../orders/fulfillment.service';
import { buildStoreAdminUrl } from '../orders/store-admin-url';
// "Kaç birim eksik" yükleminin TEK kaynağı (notExpiredCond deseni) — bkz. orders/fill-target.ts.
import { remainingUnitsSql } from '../orders/fill-target';
import {
  AUTOCOMPLETE_INLINE_CAP_DEFAULT,
  AUTOCOMPLETE_INLINE_CAP_ENV,
  AUTOCOMPLETE_JOB,
  AUTOCOMPLETE_JOB_OPTS,
  AUTOCOMPLETE_QUEUE,
  type AutocompleteJob,
} from './autocomplete.queue';

export interface ImportRejection {
  index: number;
  reason: string;
}

/**
 * Stok girişiyle AYNI istekte "teslim alınmış" parti (+ otomatik satın alma emri) açma
 * girdisi (§12). Sözleşme doğrulaması controller'dadır; servis de aynı kuralları
 * SAVUNMA amaçlı yeniden uygular (iç çağıranlar controller'ı atlayabilir).
 *
 * `qtyReceived` BİLEREK YOKTUR — adet, gerçekten girilen kayıt sayısından türetilir.
 */
export interface NewBatchInput {
  /** Mevcut tedarikçi. `supplierName` ile birlikte verilemez. */
  supplierId?: string;
  /** Serbest tedarikçi adı — aynı ad varsa YENİDEN KULLANILIR, yoksa oluşturulur. */
  supplierName?: string;
  label: string;
  /** ISO tarih. Verilmezse "şimdi". Aralık: [2000-01-01, şimdi+24sa]. */
  receivedAt?: string;
  /** Birim maliyet (kuruş) — satın alma emrinde tutulur, tedarikçi ZORUNLUDUR. */
  unitCostCents?: number;
  currency?: string;
  /** Operatör notu (otomatik oluşturma önekinin ardına eklenir). */
  notes?: string;
}

/**
 * Yeni parti sonucunun raporu. `created=false` iken `reason` neden oluşmadığını söyler
 * (kuru çalıştırma / tüm satırlar reddedildi) — sessiz "oluştu sandım" durumu olmasın.
 */
export interface NewBatchOutcome {
  created: boolean;
  reason?: 'dry_run' | 'all_rejected';
  batchId?: string;
  purchaseOrderId?: string | null;
  supplierId: string | null;
  supplierName: string | null;
  /** Tedarikçi bu istekte OLUŞTURULDU mu? (kuru çalıştırmada: oluşturulacak mı — tahmin) */
  supplierCreated?: boolean;
  /** Ad eşleşmesiyle MEVCUT tedarikçi mi kullanıldı? (mükerrer 'Acme' üretilmedi) */
  supplierExisting?: boolean;
  label: string;
  receivedAt: string;
  qtyReceived: number;
  unitCostCents: number | null;
  currency: string | null;
  /** Girilen lisans kayıtlarına COGS maliyet anlık-görüntüsü yazıldı mı? */
  costSnapshotApplied: boolean;
  /** Aynı üründe aynı etiketli parti zaten var mı? Engel DEĞİL — yalnız uyarı. */
  labelDuplicate?: boolean;
}

/**
 * Yeni parti PLANI — transaction içinde hesaplanır, satırlar adet belli olunca yazılır.
 * (Dışa açılmaz: yalnız import akışının iç adımıdır.)
 */
interface AutoReceiptPlan {
  batchId: string;
  purchaseOrderId: string | null;
  supplierId: string | null;
  supplierName: string | null;
  supplierCreated: boolean;
  label: string;
  receivedAt: Date;
  unitCostCents: number | null;
  currency: string | null;
  /** Operatör notu (ham) — otomatik önekin ardına eklenir. */
  notes: string | null;
  labelDuplicate: boolean;
  /** license_items'a yazılacak COGS anlık-görüntüsü (yalnız maliyet + tedarikçi varsa). */
  costSnapshot: { unitCostCents: number; costCurrency: string } | null;
}

/** Maliyet girildi ama tedarikçi yok — controller ve servis AYNI metni kullanır. */
const COST_NEEDS_SUPPLIER_MSG =
  'Birim maliyet girildi ama tedarikçi seçilmedi. Maliyet satın alma emrinde tutulur; ' +
  'tedarikçi seçin ya da maliyeti boş bırakın.';

export interface ImportResult {
  requested: number;
  imported: number;
  duplicates: number;
  /** Doğrulamadan geçemeyen satırlar (account şema / keyFormat) — sessizce yutulmaz. */
  rejected: number;
  rejections: ImportRejection[];
  /** INLINE (istek içinde) tamamlanan bekleyen satır sayısı — davranış eskisiyle aynı. */
  autoCompleted: number;
  /**
   * Kalan backlog (inline cap'i aşan bekleyen satırlar) ARKA PLAN kuyruğuna atıldı mı? (perf).
   * true → küçük backlog inline bitti + fazlası arka planda tamamlanacak; false → ya hepsi inline
   * bitti ya da stok tükendi (kuyruğa gerek yok). Enqueue best-effort'tur: atma patlarsa import
   * yine başarılı döner (yalnız inline tamamlananla), bu bayrak false kalır.
   */
  autoCompleteQueued?: boolean;
  /** Kuru çalıştırma (§7): true ise HİÇBİR şey commit edilmedi (yalnız doğrulama). */
  dryRun?: boolean;
  /** Kuru çalıştırma tahmini: doğrulamayı geçip (dedupe sonrası) GİRİLECEK satır sayısı. */
  wouldImport?: number;
  /**
   * Aynı istekte parti (+ otomatik satın alma emri) istendiyse sonucu. Alan OPSİYONELDİR —
   * `newBatch` gönderilmeyen klasik import'ta HİÇ dönmez (mevcut sözleşme değişmez).
   */
  newBatch?: NewBatchOutcome;
  /**
   * Operatörün YAPIŞTIRDIĞI satır sayısı ile gerçekten kaydedilen adet farklıysa (mükerrer
   * ya da reddedilen satırlar) uyarı. Satın alma emri GERÇEK adetle açıldığı için harcama
   * doğrudur; bu alan yalnız "beklediğinden az girdi" bilgisini görünür kılar.
   */
  qtyMismatch?: { declared: number; imported: number };
}

export type ImportItem = { payload: string | Record<string, unknown>; expiresAt?: string };

/** "Onayla ve Dağıt" önizleme (§13): girilecek stok bekleyen talebi ne kadar karşılar. */
export interface StockPreview {
  /** İstenen giriş adedi (birim). */
  count: number;
  /** Bu ürün için bekleyen (pending/partial, iptal olmayan, incelemede olmayan) satır sayısı. */
  pendingLines: number;
  /**
   * Bekleyen TOPLAM birim = Σ(qty − canceled_units − fulfilled_qty) — otomatik dolacak +
   * dolmayacak birlikte. Yüklem `orders/fill-target.ts` `remainingUnitsSql` (TEK tanım):
   * panelden KALICI iptal edilmiş birim bekleyen iş DEĞİLDİR (autoComplete onu doldurmaz).
   */
  pendingUnits: number;
  /**
   * Stok girişiyle OTOMATİK dolacak birim (efektif politika partial-auto + ön sipariş
   * penceresi kapalı). `wouldFill`/`remainingAfter` bu sayıdan türetilir.
   */
  autoUnits: number;
  /**
   * Otomatik DOLMAYACAK bekleyen birim (all-or-nothing / partial-approval satırlar, ya da
   * ön sipariş penceresi açıkken tüm bekleyen talep). Elle "Kalanları Ata"/onay gerekir —
   * önizleme bunu "karşılanacak talep" diye SAYMAZ (yanlış vaat vermez).
   */
  manualUnits: number;
  /** Bu giriş kaç bekleyen birimi OTOMATİK tamamlar = min(count, autoUnits). */
  wouldFill: number;
  /** Otomatik dolacaklar karşılandıktan sonra artan stok = max(count - autoUnits, 0). */
  remainingAfter: number;
}

/** Lisans envanteri: sayfa başına izinli adetler (UI "25 / 50 / 100" seçeneği). */
/**
 * İzinli sayfa boyları. `clampPageSize` gelen değeri bu kümenin EN YAKININA çeker, yani
 * listede olmayan bir değer SESSİZCE başka bir sayıya döner. Bu yüzden admin'deki seçenek
 * listesiyle (license-items-table `PAGE_SIZES`) BİREBİR aynı kalmalı — aksi halde kutuda
 * "10 kayıt" yazarken tablo 25 satır gösterirdi.
 * 10: gömülü kartlarda (/stock giriş ekranı) ekranı uzatmamak için eklendi.
 */
export const LICENSE_PAGE_SIZES = [10, 25, 50, 100] as const;

/** license_items.status enum'unun TAM listesi (UI facet'i genelde ilk 4'ünü kullanır). */
export const LICENSE_ITEM_STATUSES = [
  'available',
  'assigned',
  'suspended',
  'replaced',
  'revoked',
  'quarantined',
  'depleted',
  'expired',
  'voided',
] as const;
export type LicenseItemStatus = (typeof LICENSE_ITEM_STATUSES)[number];

// ─── keyFormat (anahtar biçimi) güvenlik kapısı — ReDoS ────────────────────────────────
/**
 * `products.key_format` operatörün yazdığı SERBEST bir düzenli ifadedir ve stok girişinde
 * 10.000'e kadar payload'a karşı SENKRON `test()` edilir. Node'da regex için zaman aşımı
 * YOKTUR: katastrofik geri-izlemeli TEK bir desen (`^(a+)+$` + uygun bir payload) event
 * loop'unu üstel süre bloklar → sipariş teslimatı dahil TÜM API donar. Eskiden girdi
 * doğrulaması yalnız `z.string().optional()` idi: ne uzunluk tavanı ne desen denetimi vardı.
 *
 * KARAR — neden RE2 gibi YENİ BİR BAĞIMLILIK EKLENMEDİ:
 *  · `re2` native (node-gyp) bir eklentidir; runtime imajlarımızda derleme zinciri yok →
 *    Dockerfile + dağıtım zinciri (deploy.sh) değişirdi. Bu bulgu bir DOĞRULAMA boşluğu,
 *    altyapı eksiği değil; düzeltmenin maliyeti kapsamıyla orantılı kalmalı.
 *  · Regex'i worker thread'e taşımak da izole EDER ama ENGELLEMEZ (thread yine tükenir,
 *    kuyruk birikir) ve senkron import yolunu asenkronlaştırıp transaction sınırlarını bozar.
 *  · Saldırı yüzeyi DAR: deseni yalnız admin yazar, ürün başına TEK kez. Bu yüzden savunma
 *    bağımlılıksız ve ÜÇ KATMANLI:
 *      1) KAYIT ANI (products.controller): uzunluk tavanı + derleme denemesi + statik sezgi →
 *         riskli desen 400 ile reddedilir; hata import anında değil, kaydederken görünür.
 *      2) KULLANIM ANI (compileKeyFormat / updateLicenseItem): bu denetimden ÖNCE kaydedilmiş
 *         ürünler için aynı kapı tekrar uygulanır — eski riskli desen sessizce çalışmaya
 *         devam etmesin (yalnız kayıt anını korumak, mevcut satırları açıkta bırakırdı).
 *      3) GİRDİ TAVANI (normalizePayload): desen ancak `KEY_FORMAT_MAX_INPUT_LENGTH` karaktere
 *         kadar payload'a uygulanır — sezgiyi atlatan bir desende bile girdi boyu SABİTTİR.
 *  · Sezgi TAM DEĞİLDİR (katastrofik geri-izlemeyi statik olarak kesin tespit etmek imkânsız):
 *    bilerek TEMKİNLİ tarafta durur. Yanlış-pozitifte sessiz reddetme YOK — operatör ne
 *    yapacağını söyleyen Türkçe mesaj görür (aşağıdaki iki sabit).
 */
export const KEY_FORMAT_MAX_LENGTH = 200;

/**
 * Desenin test edilebileceği EN UZUN payload. `UpdateLicenseItemBody.value` zaten
 * `.max(4_000)` kullanıyor (stock.controller) → aynı sayı; import ve tekil düzenleme
 * yolları aynı tavanda buluşur.
 */
export const KEY_FORMAT_MAX_INPUT_LENGTH = 4_000;

/**
 * Dış niceleyici bunun üstünde tekrar edebiliyorsa "çoğaltıcı" sayılır. `{4}` gibi küçük
 * SABİT tekrarlar (ör. `(-[A-Z0-9]{5}){4}` — en yaygın meşru anahtar biçimi) elenir;
 * sınırsız (`*`, `+`, `{n,}`) olanlar her zaman çoğaltıcıdır.
 */
const OUTER_REPEAT_RISK_THRESHOLD = 10;

const NESTED_QUANTIFIER_MSG =
  'Anahtar biçimi riskli: tekrarlanan bir grubun İÇİNDE de değişken tekrar var ' +
  '(ör. "(a+)+", "([A-Z]+-)*"). Bu kalıp katastrofik geri-izlemeye (ReDoS) yol açıp stok ' +
  "girişini ve tüm API'yi kilitleyebilir. Grubu SABİT tekrarla yazın " +
  '(ör. "([A-Z0-9]{5}-){4}") ya da içteki değişken tekrarı kaldırın.';

const AMBIGUOUS_ALTERNATION_MSG =
  'Anahtar biçimi riskli: tekrarlanan grupta birbirinin aynısı ya da ön eki olan seçenekler ' +
  'var (ör. "(a|a)*", "(a|ab)+"). Aynı metni birden çok yoldan eşleştiren bu kalıp ' +
  'katastrofik geri-izlemeye (ReDoS) yol açar. Seçenekleri örtüşmeyecek biçimde ayrıştırın.';

interface KeyFormatQuantifier {
  min: number;
  max: number;
  /** Niceleyiciden SONRAKİ ilk konum (tembel `?` eki dahil atlanır). */
  end: number;
}

/** `[...]` karakter sınıfını atlar (içindeki `*`/`+`/`|` niceleyici DEĞİLDİR). */
function skipCharClass(pattern: string, start: number): number {
  let i = start + 1;
  if (pattern[i] === '^') i += 1;
  // Sınıfın İLK `]` karakteri literaldir (`[]]`), sınıfı kapatmaz.
  if (pattern[i] === ']') i += 1;
  while (i < pattern.length) {
    if (pattern[i] === '\\') {
      i += 2;
      continue;
    }
    if (pattern[i] === ']') return i + 1;
    i += 1;
  }
  return pattern.length;
}

/**
 * `pos` konumundaki niceleyiciyi okur: `*` `+` `?` `{n}` `{n,}` `{n,m}`. Yoksa null
 * (ör. literal `{` — `new RegExp` bunu niceleyici saymaz, biz de saymayız).
 * Tembel/aç gözlü AYRIMI YAPILMAZ: tembel niceleyici de aynı şekilde geri-izler.
 */
function readKeyFormatQuantifier(pattern: string, pos: number): KeyFormatQuantifier | null {
  const skipLazy = (p: number) => (pattern[p] === '?' ? p + 1 : p);
  const c = pattern[pos];
  if (c === '*') return { min: 0, max: Infinity, end: skipLazy(pos + 1) };
  if (c === '+') return { min: 1, max: Infinity, end: skipLazy(pos + 1) };
  if (c === '?') return { min: 0, max: 1, end: skipLazy(pos + 1) };
  if (c !== '{') return null;
  const close = pattern.indexOf('}', pos);
  if (close < 0) return null;
  const m = /^(\d+)(,(\d*))?$/.exec(pattern.slice(pos + 1, close));
  if (!m) return null;
  const min = Number(m[1]);
  // `{n}` → sabit; `{n,}` → sınırsız; `{n,m}` → m.
  const max = m[2] === undefined ? min : m[3] ? Number(m[3]) : Infinity;
  return { min, max, end: skipLazy(close + 1) };
}

/** `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<ad>` öneki (grup gövdesinin parçası değildir). */
const GROUP_PREFIX_RE = /^\(\?(:|=|!|<=|<!|<[A-Za-z_$][\w$]*>)/;

/**
 * Gövdede HERHANGİ bir derinlikte "değişken" (min≠max) niceleyici var mı?
 * `{5}` gibi SABİT tekrar değişken değildir — `(x{5}){4}` patlamaz, `(x+){4}` patlar.
 */
function hasVariableQuantifier(body: string): boolean {
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      i = skipCharClass(body, i);
      continue;
    }
    if (c === '(') {
      // Grup önekindeki `?` bir niceleyici DEĞİLDİR — atlanmazsa `(?:ab)` yanlış-pozitif olurdu.
      const m = GROUP_PREFIX_RE.exec(body.slice(i));
      i += m ? m[0].length : 1;
      continue;
    }
    const q = readKeyFormatQuantifier(body, i);
    if (q) {
      if (q.min !== q.max) return true;
      i = q.end;
      continue;
    }
    i += 1;
  }
  return false;
}

/** Gövdeyi ÜST düzey `|` işaretlerinden böler (grup/sınıf içindekiler bölmez). */
function splitTopLevelAlternatives(body: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === '\\') {
      current += body.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === '[') {
      const end = skipCharClass(body, i);
      current += body.slice(i, end);
      i = end;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (c === '|' && depth === 0) {
      out.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += c;
    i += 1;
  }
  out.push(current);
  return out;
}

/**
 * ÇOĞALTICI bir niceleyiciyle tekrarlanan grup gövdesini denetler. İki klasik katastrofik
 * kalıbı arar: (a) iç içe değişken niceleyici `(a+)+`, (b) belirsiz alternasyon `(a|a)*` /
 * `(a|ab)+` (aynı metni birden çok yoldan eşleştirir → geri-izleme dallanır).
 */
function inspectRepeatedBody(body: string): string | null {
  if (hasVariableQuantifier(body)) return NESTED_QUANTIFIER_MSG;
  const alts = splitTopLevelAlternatives(body).filter((a) => a.length > 0);
  for (let a = 0; a < alts.length; a += 1) {
    for (let b = a + 1; b < alts.length; b += 1) {
      const x = alts[a]!;
      const y = alts[b]!;
      if (x.startsWith(y) || y.startsWith(x)) return AMBIGUOUS_ALTERNATION_MSG;
    }
  }
  return null;
}

/**
 * Deseni gezip ÇOĞALTICI niceleyiciyle tekrarlanan grupları bulur ve gövdelerini denetler.
 * Sözdizimi ayrıştırıcısı DEĞİLDİR (kaçışları ve karakter sınıflarını doğru atlayan bir
 * tarayıcıdır) — deseni `new RegExp` zaten ayrıca derliyor, buradaki iş yalnız risk sezgisi.
 */
function findRiskyRepetition(pattern: string): string | null {
  const stack: number[] = [];
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      i = skipCharClass(pattern, i);
      continue;
    }
    if (c === '(') {
      stack.push(i);
      i += 1;
      continue;
    }
    if (c === ')') {
      const start = stack.pop();
      if (start === undefined) {
        // Dengesiz parantez — `new RegExp` zaten reddeder; sezgi burada karar vermez.
        i += 1;
        continue;
      }
      const quant = readKeyFormatQuantifier(pattern, i + 1);
      if (quant && (quant.max === Infinity || quant.max >= OUTER_REPEAT_RISK_THRESHOLD)) {
        const raw = pattern.slice(start + 1, i);
        const prefix = GROUP_PREFIX_RE.exec(`(${raw}`);
        const body = prefix ? raw.slice(prefix[0].length - 1) : raw;
        const reason = inspectRepeatedBody(body);
        if (reason) return reason;
      }
      i = quant ? quant.end : i + 1;
      continue;
    }
    i += 1;
  }
  return null;
}

/**
 * `keyFormat` deseni kabul edilebilir mi? Sorun varsa OPERATÖRE gösterilecek Türkçe sebebi,
 * yoksa null döner. String döndürür (exception DEĞİL) ki hem zod (`ctx.addIssue`) hem servis
 * (`BadRequestException`) aynı TEK kaynaktan beslenebilsin.
 */
export function checkKeyFormatSafety(pattern: string): string | null {
  // Boş dize = "biçim kuralı yok" (mevcut davranış: compileKeyFormat null döner).
  if (pattern.length === 0) return null;
  if (pattern.length > KEY_FORMAT_MAX_LENGTH) {
    return `Anahtar biçimi deseni en fazla ${KEY_FORMAT_MAX_LENGTH} karakter olabilir (girilen: ${pattern.length}).`;
  }
  try {
    new RegExp(pattern);
  } catch (err) {
    return `Anahtar biçimi geçerli bir düzenli ifade değil: ${err instanceof Error ? err.message : String(err)}`;
  }
  return findRiskyRepetition(pattern);
}

export type LicenseInventorySort = 'created_desc' | 'created_asc' | 'assigned_desc';

/** Hesap (account) ürününde alan-alan çözülmüş payload. */
export interface LicenseInventoryField {
  key: string;
  label: string;
  value: string;
  /** true ise şemada "gizli" işaretli alan (parola vb.) — UI istersen gizli tutabilir. */
  secret: boolean;
}

/** Lisans TESLİM EDİLMİŞSE bağlı sipariş/site bilgisi (yoksa null). */
export interface LicenseInventoryDelivery {
  assignmentId: string;
  assignmentStatus: string;
  units: number;
  assignedAt: Date | null;
  validUntil: Date | null;
  orderId: string;
  remoteOrderId: string;
  customerEmail: string;
  siteId: string;
  siteDomain: string;
  siteType: string;
  /**
   * Mağaza admin panelinde siparişi açan URL — SALT YÖNLENDİRME (§17). Panel mağazaya
   * bağlanmaz/oturum açmaz; yalnız link üretir. Şablon yoksa/desteklenmeyen kanalda null.
   */
  storeAdminUrl: string | null;
}

export interface LicenseInventoryRow {
  id: string;
  productId: string;
  productName: string;
  productSku: string;
  /** products.kind ham değeri: key | account | code | custom. */
  productType: string;
  usageMode: string;
  status: string;
  maxUses: number;
  useCount: number;
  /** Kalan kapasite (multi/MAK): max_uses − use_count (negatif olamaz). */
  remainingUses: number;
  /** Gösterim tipi: account → fields dolu, diğer her şey → value dolu. */
  kind: 'key' | 'account';
  value: string | null;
  fields: LicenseInventoryField[] | null;
  batchId: string | null;
  batchCode: string | null;
  supplierName: string | null;
  unitCostCents: number | null;
  costCurrency: string | null;
  createdAt: Date;
  /** Stok ömrü bitiş anı (FEFO). null = süresiz. `validUntil` (müşteri lisansı) DEĞİLDİR. */
  expiresAt: Date | null;
  /**
   * Stok ömrü DOLMUŞ mu (expires_at ≤ now)? true ise kalem `status='available'` görünse bile
   * ATANAMAZ — hiçbir stok toplamına girmez (products/stock/dashboard hepsi notExpiredCond
   * uygular). UI ham durumun yanında bunu göstermeli ki liste ile sayaçlar çelişmesin.
   */
  expired: boolean;
  delivered: LicenseInventoryDelivery | null;
}

export interface LicenseInventoryPage {
  rows: LicenseInventoryRow[];
  /**
   * Süzgece uyan kayıt sayısı. `totalCapped` true ise "EN AZ bu kadar" demektir
   * (bkz. LICENSE_COUNT_CAP) — istemci bunu "10.000+" gibi dürüstçe yazmak zorundadır.
   */
  total: number;
  /** Sayım tavana dayandı mı? true → `total` gerçek toplam DEĞİL, alt sınırdır. */
  totalCapped: boolean;
  /** Sayımın kırpıldığı sınır (LICENSE_COUNT_CAP) — istemci metni buradan kurar. */
  countCap: number;
  page: number;
  pageSize: number;
  /**
   * Bu yanıttaki lisans/hesap değerleri MASKELİ mi (A1: düz metin yalnız owner'a)?
   * İstemci bunu bilmek ZORUNDA: dışa aktarılan dosyaya "değerler maskeli" uyarısını
   * basabilmesi için. Alan additive'dir — eski istemci görmezden gelir.
   */
  masked: boolean;
}

/**
 * Envanter DIŞA AKTARMA yanıtı — sayfalı listeden farkı: tek istekte `limit` kadar satır
 * döner ve kırpılma DÜRÜSTÇE raporlanır (`truncated` + `total`).
 */
export interface LicenseInventoryExport {
  rows: LicenseInventoryRow[];
  /**
   * Süzgece uyan TOPLAM kayıt (kırpılmadan önce). `totalCapped` true ise ALT SINIRDIR
   * (sayım LICENSE_COUNT_CAP ile tavanlanır) — `truncated` kararı bundan ETKİLENMEZ,
   * çünkü tavan (10.000) dışa aktarma limitinden (5.000) büyüktür.
   */
  total: number;
  /** Sayım tavana dayandı mı? true → `total` alt sınırdır ("10.000+"). */
  totalCapped: boolean;
  /** Sayımın kırpıldığı sınır (LICENSE_COUNT_CAP). */
  countCap: number;
  /** Sunucu üst sınırı (LICENSE_EXPORT_LIMIT). */
  limit: number;
  /** total > limit → dosyada eksik kayıt var; istemci bunu GÖRÜNÜR yazmak zorunda. */
  truncated: boolean;
  /** Değerler maskeli mi (owner-olmayan admin). */
  masked: boolean;
}

/**
 * Dışa aktarmanın SUNUCU TAVANI.
 *
 * NEDEN 5000 (ve neden "sınırsız" değil): her satırın payload'ı AES-256-GCM ile TEK TEK
 * çözülür — yani maliyet satır başına CPU'dur, sorgu değil. 5000 satır ≈ 2-3 MB JSON ve
 * tek istekte ölçülebilir bir iş; üstü hem Next sunucusunda hem tarayıcıda belleğe alınır.
 * Sayı BİLEREK karantina dışa aktarmasıyla (QUARANTINE_LIMIT) AYNI: operatör panelde tek bir
 * "5.000" sınırı öğrenir, ekrandan ekrana değişen tavanlarla uğraşmaz.
 *
 * SESSİZ KIRPMA YASAK: tavana dayanıldığında `truncated` döner ve UI hem panelde hem DOSYANIN
 * İÇİNDE bunu yazar (dosya yeniden adlandırılıp iletilebilir — uyarı sadece ekranda kalamaz).
 */
export const LICENSE_EXPORT_LIMIT = 5_000;

/**
 * `total` üst sınırı (envanter listesi + dışa aktarma).
 *
 * NEDEN VAR (denetim bulgusu — ORTA): toplam `count(*) OVER ()` penceresiyle hesaplanıyordu
 * ve pencere fonksiyonu LIMIT'ten ÖNCE, süzgece uyan TÜM bölüm üzerinde çalışır. Yani
 * SÜZGEÇSİZ açılışta (varsayılan /stock "Son Eklenen Lisanslar" kartı ve envanter ekranı)
 * her görüntüleme `license_items` tablosunun TAMAMINI sayıyordu — sayfanın kendisi indexten
 * (created_at + LIMIT) karşılanırken sayacın taraması ekranı zamanla kullanılamaz hale
 * getirirdi; `license_items` sistemin en hızlı büyüyen tablolarından biri.
 *
 * ÇÖZÜM `audit.service.AUDIT_COUNT_CAP` ile BİREBİR AYNI desendir: sayım `LIMIT CAP+1` ile
 * sınırlı bir alt sorgudan yapılır. Gerçek toplam sınırın altındaysa TAM doğrudur; üstündeyse
 * `totalCapped=true` ile DÜRÜSTÇE söylenir ("10.000+"). Sessizce yanlış toplam göstermek bu
 * projede yasak (sessiz kırpma sınıfı).
 *
 * DEĞER audit ile aynı büyüklükte (10.000) ve BİLEREK `LICENSE_EXPORT_LIMIT`ten (5.000)
 * BÜYÜK: dışa aktarmanın `truncated` kararı `total > rows.length` ile verilir; tavan dışa
 * aktarma limitinin üstünde kaldığı sürece o karar tavandan ETKİLENMEZ (total kırpılan tüm
 * senaryolarda zaten 10.000 > 5.000 ⇒ truncated true).
 */
export const LICENSE_COUNT_CAP = 10_000;

/** `listLicenseItems` iç ayarları — dışa aktarma yolu için (dış sözleşme değişmez). */
interface ListLicenseItemsOptions {
  /**
   * Sayfa boyunu izinli küme (10/25/50/100) YERİNE bu değere ayarlar. YALNIZ dışa aktarma
   * kullanır; `LICENSE_EXPORT_LIMIT` ile tavanlanır (uç, keyfi büyük sayfa açamaz).
   */
  pageSizeOverride?: number;
  /**
   * false → bu çağrı 'reveal' audit'i YAZMAZ. Dışa aktarma kendi TEK kaydını yazar
   * (`meta.op='export'`); aksi halde aynı işlem için iki kayıt düşerdi.
   */
  audit?: boolean;
}

export interface ListLicenseItemsParams {
  productId?: string;
  status?: string;
  /**
   * `'customer'` → yalnız CANLI ataması olan kalemler (assignment.status ∈ active|suspended),
   * yani "şu anda müşterinin elinde olanlar". `status` süzgecinden AYRI bir eksendir: MAK
   * anahtarı kısmen satılmışken hâlâ `status='available'` görünür, o yüzden "müşterilerde mi?"
   * sorusu kalemin durumundan okunamaz. Parti geri çekildikten sonra "hangi anahtarlar hâlâ
   * müşterilerde, hangilerini değiştirmem gerek" sorusunun cevabı bu süzgeçtir.
   */
  holder?: 'customer';
  search?: string;
  siteId?: string;
  batchId?: string;
  page?: number;
  pageSize?: number;
  sort?: LicenseInventorySort;
}

/** PATCH gövdesi: key ürününde `value`, account ürününde `fields` verilir. */
export interface UpdateLicenseItemInput {
  value?: string;
  fields?: Record<string, string>;
  reason: string;
}

/** Tek sorguluk envanter satırının HAM (snake_case) şekli. */
interface LicenseItemRawRow {
  id: string;
  product_id: string;
  product_name: string;
  product_sku: string;
  product_kind: string;
  usage_mode: string;
  payload_schema: unknown;
  payload_enc: string;
  status: string;
  max_uses: number;
  use_count: number;
  batch_id: string | null;
  batch_code: string | null;
  supplier_name: string | null;
  unit_cost_cents: number | null;
  cost_currency: string | null;
  created_at: Date;
  expires_at: Date | null;
  /** Sunucu tarafında `NOT notExpiredCond` ile hesaplanır (istemci saatine GÜVENİLMEZ). */
  is_expired: boolean;
  assignment_id: string | null;
  assignment_status: string | null;
  units: number | null;
  assigned_at: Date | null;
  valid_until: Date | null;
  order_id: string | null;
  remote_order_id: string | null;
  customer_email: string | null;
  site_id: string | null;
  site_domain: string | null;
  site_type: string | null;
  admin_order_url_template: string | null;
}

/** Teslim edilmiş lisansı iptal/düzenleme denemesinde dönen TEK mesaj (UI birebir gösterir). */
const DELIVERED_MSG =
  "Bu lisans müşteriye teslim edilmiş. Değiştirmek için sipariş detayındaki 'Değiştir' işlemini kullanın.";

@Injectable()
export class StockService {
  private readonly logger = new Logger(StockService.name);

  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
    private readonly products: ProductsService,
    private readonly fulfillment: FulfillmentService,
    private readonly config: ConfigService,
    @InjectQueue(AUTOCOMPLETE_QUEUE) private readonly autocompleteQueue: Queue,
  ) {}

  /** Inline tamamlanacak azami satır (env AUTOCOMPLETE_INLINE_CAP; geçersizse varsayılan). */
  private inlineCap(): number {
    const raw = this.config.get<string>(AUTOCOMPLETE_INLINE_CAP_ENV);
    const n = raw != null ? Number(raw) : NaN;
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : AUTOCOMPLETE_INLINE_CAP_DEFAULT;
  }

  /**
   * Stok import (§12). Her payload şifrelenir (envelope), içerik hash'iyle mükerrer
   * engellenir (UNIQUE payload_hash → onConflictDoNothing). Çok kullanımlıkta (multi)
   * her key ürünün max_uses kapasitesiyle girer.
   *
   * `newBatch` (opsiyonel, §12): operatör "12 Ağustos'ta Acme'den aldım, birim 10,00 ₺"
   * bilgisini stok girişiyle AYNI istekte verir → panel tedarikçiyi çözer (ad eşleşiyorsa
   * MEVCUDU kullanır), `status='received'` bir satın alma emri + partiyi TEK transaction'da
   * açar ve lisans kayıtlarını o partiye bağlar. Adet operatörün BEYANINDAN değil, gerçekten
   * girilen (mükerrer/reddedilen düşülmüş) kayıt sayısından türer. Migration GEREKMEZ —
   * mevcut suppliers/purchase_orders/batches tabloları kullanılır.
   *
   * TRANSACTION SINIRI (bilinçli): payload ŞİFRELEME ve `autoCompleteProduct` + kuyruk
   * tx DIŞINDADIR. autoComplete kendi transaction'ını açar; SKIP LOCKED ile henüz commit
   * EDİLMEMİŞ satırlarımızı göremez (sessizce hep 0 tamamlar) ve dış tx olarak thread
   * edilirse yan etkiler ertelenir → teslimat maili + `order.fulfilled` webhook'u HİÇ gitmez.
   */
  async import(
    productId: string,
    items: ImportItem[],
    batchId?: string,
    dryRun = false,
    actor = 'panel:admin',
    newBatch?: NewBatchInput,
  ): Promise<ImportResult> {
    const product = await this.products.getById(productId);

    // Sözleşme guard'ları — controller'daki superRefine ile AYNI kurallar. Servis de uygular
    // çünkü iç çağıranlar (test/script/başka servis) controller'ı atlayabilir.
    if (newBatch && batchId) {
      throw new BadRequestException(
        'Mevcut parti ile yeni parti bilgisi birlikte gönderilemez — birini seçin.',
      );
    }
    if (newBatch?.unitCostCents != null && !newBatch.supplierId && !newBatch.supplierName) {
      throw new BadRequestException(COST_NEEDS_SUPPLIER_MSG);
    }

    // Çok kullanımlık (MAK) ürün maxUses>1 ZORUNLU — aksi halde her key kapasite=1'e
    // düşer ve MAK anahtarı tek satışta tükenir (sessiz misconfig'i erken yakala).
    if (product.usageMode === 'multi' && (product.maxUses == null || product.maxUses <= 1)) {
      throw new BadRequestException(
        "usageMode='multi' ürün için max_uses > 1 tanımlı olmalı — import reddedildi.",
      );
    }
    const maxUses = product.usageMode === 'multi' ? product.maxUses! : 1;

    // Hesap ürünü için alan şemasını çöz (import doğrulaması + kanonik serialize).
    const accountSchema = this.resolveAccountSchema(product);
    const keyRegex = this.compileKeyFormat(product);

    const rejections: ImportRejection[] = [];
    const values: NewLicenseItem[] = [];

    items.forEach((it, index) => {
      let plaintext: string;
      try {
        plaintext = this.normalizePayload(it.payload, product, accountSchema, keyRegex);
      } catch (err) {
        rejections.push({ index, reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      // id'yi uygulamada üretiyoruz ki payload'ı bu satıra AAD ile bağlayabilelim
      // (satır-taşıma engeli, §8). insert bu id ile yapılır.
      const id = randomUUID();
      values.push({
        id,
        productId,
        // batch_id + COGS snapshot TRANSACTION İÇİNDE doldurulur (aşağıda): parti ya orada
        // DOĞRULANIR (legacy `batchId`) ya da orada OLUŞTURULUR (`newBatch`). Pahalı olan
        // şifreleme burada, tx dışında kalır.
        batchId: null,
        payloadEnc: this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id)),
        payloadHash: this.crypto.payloadHash(plaintext),
        // HESAP ÜRÜNÜNDE SON-5 ARAMASI ANLAMSIZ (denetim bulgusu) — bu yüzden hash YAZILMAZ.
        // `plaintext` burada KANONİK JSON'dur (`{"password":"…","username":"…"}`), dolayısıyla
        // son 5 hane parolanın/kullanıcı adının sonu değil, JSON'un kuyruğudur (`ne"}` gibi) →
        // operatörün "parolanın son 5 hanesi" diye arattığı şey ASLA eşleşmez. Üstelik kuyruğun
        // 2 karakteri (`"}`) SABİT olduğu için efektif entropi 5→3'e düşer, yani yazılan değer
        // hem işe yaramaz hem de zayıf bir parmak izidir. NULL bırakmak dürüst olandır; arama
        // ipucu metni de hesap ürününde bu aramanın geçerli olmadığını söyler.
        payloadSuffixHash: accountSchema ? null : this.crypto.payloadSuffixHash(plaintext),
        maxUses,
        expiresAt: it.expiresAt ? new Date(it.expiresAt) : null,
        status: 'available',
        unitCostCents: null,
        costCurrency: null,
      });
    });

    // Erken çıkış yolları (kuru çalıştırma / hepsi reddedildi) TX AÇMAZ; ama legacy `batchId`
    // doğrulaması BUGÜNKÜ gibi burada da koşar → geçersiz/başka ürüne ait/geri çağrılmış parti
    // sessizce 200 dönmez (davranış korunur).
    if ((dryRun || values.length === 0) && batchId) {
      await this.resolveBatchForImport(productId, batchId);
    }

    // Kuru çalıştırma (§7): payloadlar DOĞRULANDI + rejected raporu üretildi; buradan
    // ötesi (DB insert, audit, autoCompleteProduct) HİÇ ÇALIŞMAZ — hiçbir şey commit edilmez.
    // Dedupe yalnız salt-okunur TAHMİN edilir: mevcut payload_hash'ler + parti-içi tekrar.
    if (dryRun) {
      let duplicates = 0;
      let wouldImport = 0;
      if (values.length > 0) {
        const hashes = values.map((v) => v.payloadHash);
        const existing = await this.db
          .select({ hash: licenseItems.payloadHash })
          .from(licenseItems)
          .where(inArray(licenseItems.payloadHash, hashes));
        const existingSet = new Set(existing.map((r) => r.hash));
        const seen = new Set<string>();
        for (const v of values) {
          // Zaten DB'de var VEYA bu partide daha önce görüldü → mükerrer (girilmez).
          if (existingSet.has(v.payloadHash) || seen.has(v.payloadHash)) {
            duplicates += 1;
          } else {
            seen.add(v.payloadHash);
            wouldImport += 1;
          }
        }
      }
      // Yeni parti istendiyse KURU ÇALIŞTIRMA da onu DOĞRULAR (tedarikçi var mı, tarih
      // aralığı, etiket çakışması, ad eşleşmesi) ve sonucu echo eder. Aksi halde kuru koşu
      // "temiz" der, gerçek koşu 404/400 verirdi — mevcut `batchId` davranışıyla simetri.
      return {
        requested: items.length,
        imported: 0,
        duplicates,
        rejected: rejections.length,
        rejections,
        autoCompleted: 0,
        dryRun: true,
        wouldImport,
        newBatch: newBatch ? await this.probeNewBatch(productId, newBatch, wouldImport) : undefined,
      };
    }

    if (values.length === 0) {
      // Hiçbir satır doğrulamayı geçmedi → parti/satın alma emri OLUŞTURULMAZ (boş parti
      // + sıfır adetli emir tedarik raporlarını kirletirdi). Tarih/tedarikçi doğrulaması
      // bilerek koşmaz: operatörün görmesi gereken asıl sorun `rejections` listesidir.
      return {
        requested: items.length,
        imported: 0,
        duplicates: 0,
        rejected: rejections.length,
        rejections,
        autoCompleted: 0,
        newBatch: newBatch
          ? {
              created: false,
              reason: 'all_rejected',
              supplierId: newBatch.supplierId ?? null,
              supplierName: newBatch.supplierName?.trim() ?? null,
              label: (newBatch.label ?? '').trim(),
              receivedAt: newBatch.receivedAt ?? new Date().toISOString(),
              qtyReceived: 0,
              unitCostCents: newBatch.unitCostCents ?? null,
              currency: newBatch.currency ? normalizeCurrency(newBatch.currency) : null,
              costSnapshotApplied: false,
            }
          : undefined,
      };
    }

    // ── TEK TRANSACTION: parti çözümü/oluşumu + lisans kayıtları + audit ──
    // Legacy `batchId` doğrulaması da buraya taşındı: doğrulama ile insert arasındaki
    // TOCTOU (araya giren recall) ücretsiz kapanır. Yeni parti ise henüz commit edilmediği
    // için ancak AYNI tx'ten görülebilir → `resolveBatchForImport` de `exec` alır.
    const { inserted, duplicates, outcome } = await this.db.transaction(async (tx) => {
      let plan: AutoReceiptPlan | null = null;
      let resolvedBatchId: string | null = batchId ?? null;
      let costSnapshot: { unitCostCents: number; costCurrency: string } | null = null;

      if (newBatch) {
        plan = await this.prepareAutoReceipt(tx, productId, newBatch, actor);
        resolvedBatchId = plan.batchId;
        costSnapshot = plan.costSnapshot;
      } else {
        costSnapshot = await this.resolveBatchForImport(productId, batchId, tx);
      }

      for (const v of values) {
        v.batchId = resolvedBatchId;
        // COGS snapshot: legacy yolda partinin PO'sundan OKUNUR; yeni parti yolunda İSTEK
        // gövdesinden gelir (parti henüz yeni yazıldı, DB'den okumaya gerek yok).
        v.unitCostCents = costSnapshot?.unitCostCents ?? null;
        v.costCurrency = costSnapshot?.costCurrency ?? null;
      }

      /*
       * CHUNK'LI TOPLU YAZIM — sistemin EN BÜYÜK toplu insert'i, tavan koruması YOKTU.
       *
       * Her satır 11 kolonu açıkça taşır (id/productId/batchId/payloadEnc/payloadHash/
       * payloadSuffixHash/maxUses/expiresAt/status/unitCostCents/costCurrency — `null` da bir
       * bind parametresidir), PostgreSQL Bind mesajı ise parametre sayısını int16'da taşır
       * (65534) → tavan ~5.957 satır. DTO ise 10.000 satıra İZİN VERİYOR ve gövde sınırına da
       * sığıyor, yani DESTEKLENDİĞİ İLAN EDİLEN girdi ulaşılabilir ve kırıyordu.
       *
       * Kırılma biçimi özellikle kötüydü: "Onayla ve Dağıt" modalini besleyen KURU ÇALIŞTIRMA
       * ayrı bir salt-okunur yol kullandığı için (satır başına 1 parametre) TEMİZ geçiyor ve
       * "8.000 kayıt girilecek" diyordu; gerçek gönderim `MAX_PARAMETERS_EXCEEDED` ile opak 500
       * veriyordu. Veri güvendeydi (tam rollback) ama giriş HİÇ yapılamıyor ve sebebi panelden
       * anlaşılmıyordu.
       *
       * Aynı tuzak bu kod tabanında üç yerde ÇOKTAN çözülmüştü (atama insert'i, releaseAllocations,
       * katalog senkronu) — en büyüğü atlanmıştı. `onConflictDoNothing` dilim başına uygulanır;
       * anlam DEĞİŞMEZ, çünkü mükerrerlik UNIQUE(payload_hash) ile TABLO genelinde tanımlıdır
       * (aynı istek içindeki tekrarlar da farklı dilimlerde yakalanır) ve hepsi TEK transaction.
       */
      const IMPORT_INSERT_CHUNK = 1000; // 1000 × 11 = 11.000 parametre (65534 sınırının altında)
      const rows: Array<{ id: string }> = [];
      for (let i = 0; i < values.length; i += IMPORT_INSERT_CHUNK) {
        const part = await tx
          .insert(licenseItems)
          .values(values.slice(i, i + IMPORT_INSERT_CHUNK))
          .onConflictDoNothing({ target: licenseItems.payloadHash })
          .returning({ id: licenseItems.id });
        rows.push(...part);
      }

      // duplicates = doğrulamayı geçip DB'de mükerrer (payload_hash) çıkanlar.
      const dup = values.length - rows.length;

      // Tek bir TAZE kayıt bile girmediyse yeni parti/emir AÇILMAZ → tam rollback (aksi
      // halde 0 adetli hayalet emir + boş parti kalırdı). Legacy/partisiz yol DEĞİŞMEDİ:
      // orada mükerrer giriş bugünkü gibi 200 + duplicates döner.
      if (plan && rows.length === 0) {
        throw new ConflictException(
          `Girilen ${values.length} anahtarın tamamı sistemde zaten kayıtlı — ` +
            'yeni parti ve satın alma emri OLUŞTURULMADI.',
        );
      }

      // PO + parti lisans kayıtlarından SONRA yazılır: adet, operatörün beyanı değil
      // GERÇEKTEN girilen kayıt sayısıdır (license_items.batch_id'de FK yok, id'ler
      // uygulamada üretildiği için sıra serbest — hepsi aynı tx'te commit olur).
      const receipt = plan
        ? await this.commitAutoReceipt(tx, productId, plan, rows.length, actor)
        : undefined;

      // Sebepli stok değişikliği audit'e düşer (§12). Aktör çağırandan gelir (x-admin-actor).
      await tx.insert(auditLog).values({
        action: 'import',
        actor,
        targetType: 'product',
        targetId: productId,
        meta: {
          imported: rows.length,
          duplicates: dup,
          rejected: rejections.length,
          ...(resolvedBatchId ? { batchId: resolvedBatchId } : {}),
          ...(receipt
            ? {
                autoReceipt: {
                  purchaseOrderId: receipt.purchaseOrderId ?? null,
                  supplierId: receipt.supplierId,
                  label: receipt.label,
                },
              }
            : {}),
        },
      });

      return { inserted: rows.length, duplicates: dup, outcome: receipt };
    });

    // Stok girişinde tamamlama motorunu tetikle (§5 partial-auto FIFO).
    //
    // PERF (bounded-inline + offload): eskiden burada `autoCompleteProduct(productId)` SINIRSIZ
    // koşuyordu → büyük backlog'da (on binlerce bekleyen satır) N seri transaction import ucunun
    // HTTP yanıtını DAKİKALARCA bloklardı. Artık inline yalnız CAP satır tamamlanır (küçük backlog
    // anında biter → hızlı geri bildirim korunur) ve DAHA fazlası varsa (hasMore) kalan backlog
    // arka plan kuyruğuna atılır (AutocompleteProcessor sınırsız koşar, backlog bitene dek).
    // Davranış: küçük backlog → eski hızlı deneyim; büyük backlog → import HIZLI döner + kalan arkada.
    let autoCompleted = 0;
    let autoCompleteQueued = false;
    if (inserted > 0) {
      const cap = this.inlineCap();
      const inline = await this.fulfillment.autoCompleteProduct(productId, cap);
      autoCompleted = inline.completed;
      if (inline.hasMore) {
        // Kalanı arka plana at — best-effort (createOrder'daki mail/webhook enqueue deseni):
        // enqueue patlarsa (Redis erişilemez vb.) import YİNE BAŞARILI döner, yalnız inline
        // tamamlananla; operatör sonraki import ya da elle "Kalanları Ata" ile devam edebilir.
        // jobId=productId → aynı ürün için kuyrukta zaten iş varsa BullMQ ikinciyi eklemez (dedupe).
        try {
          await this.autocompleteQueue.add(
            AUTOCOMPLETE_JOB,
            { productId } satisfies AutocompleteJob,
            { jobId: productId, ...AUTOCOMPLETE_JOB_OPTS },
          );
          autoCompleteQueued = true;
        } catch (err) {
          this.logger.warn(
            `Stok tamamlama backlog'u kuyruğa alınamadı (product ${productId}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }

    return {
      requested: items.length,
      imported: inserted,
      duplicates,
      rejected: rejections.length,
      rejections,
      autoCompleted,
      autoCompleteQueued,
      newBatch: outcome,
      // Yapıştırılan satır sayısı ile kaydedilen adet ayrıştıysa görünür kıl (emir GERÇEK
      // adetle açıldı; operatör "100 girdim ama 97 kaydedildi" bilgisini kaybetmesin).
      qtyMismatch:
        outcome && items.length !== inserted
          ? { declared: items.length, imported: inserted }
          : undefined,
    };
  }

  /**
   * Parti DOĞRULAMASI + COGS snapshot kaynağı (§12, D17) — tek okuma.
   *
   * DOĞRULAMA (denetim bulgusu): `batchId` şimdiye kadar HİÇ doğrulanmıyordu; şemada da
   * license_items.batch_id için FK yok (bilinçli — migration eklemiyoruz). Sonuç: var olmayan
   * bir parti id'si sessizce yazılabiliyor, BAŞKA ürünün partisine stok girilebiliyor
   * (maliyet/zayi/karne raporları o ürüne yazılır) ve GERİ ÇAĞRILMIŞ (recalled/voided) bir
   * partiye taze anahtar eklenebiliyordu — recall süpürmesi zaten geçtiği için bu anahtarlar
   * "geri çağrılmış parti"nin altında SATILABİLİR kalıyordu. Artık:
   *   · parti yok            → 404,
   *   · parti başka ürüne ait→ 400 (ürün/parti uyuşmazlığı sessizce kabul edilmez),
   *   · parti aktif değil    → 409 (recalled/voided partiye stok eklenmez).
   *
   * SNAPSHOT: partinin PO'sundan birim maliyet + para birimi kopyalanır (import anında
   * sabitlenir, sonradan değişmez). PO bağı yoksa ya da maliyet tanımsızsa null döner
   * (kayıt snapshot'sız kalır → maliyet raporunda "kapsanamayan"). PO join'i LEFT'tir:
   * PO'suz elle parti artık DOĞRULAMADAN geçer ama maliyetsiz kalır (eskiden innerJoin
   * olduğu için bu satır zaten null dönüyordu — davranış aynı).
   *
   * `exec`: import artık TEK transaction'da koştuğu için okuma da o tx'ten yapılmalıdır —
   * aksi halde aynı istekte oluşturulan parti (henüz commit edilmemiş) GÖRÜLMEZ ve 404 tüm
   * transaction'ı geri alır. Erken çıkış yolları (kuru çalıştırma / hepsi reddedildi) tx
   * açmadığı için varsayılan `this.db` ile çağırır.
   */
  private async resolveBatchForImport(
    productId: string,
    batchId?: string,
    exec: Database = this.db,
  ): Promise<{ unitCostCents: number; costCurrency: string } | null> {
    if (!batchId) return null;
    const [row] = await exec
      .select({
        batchProductId: batches.productId,
        batchStatus: batches.status,
        batchLabel: batches.label,
        unitCostCents: purchaseOrders.unitCostCents,
        costCurrency: purchaseOrders.currency,
      })
      .from(batches)
      .leftJoin(purchaseOrders, eq(purchaseOrders.id, batches.purchaseOrderId))
      .where(eq(batches.id, batchId))
      .limit(1);

    if (!row) throw new NotFoundException('Parti (batch) bulunamadı.');
    if (row.batchProductId !== productId) {
      throw new BadRequestException(
        `Seçilen parti (${row.batchLabel}) başka bir ürüne ait — stok bu partiye yazılamaz. ` +
          'Doğru ürünün partisini seçin ya da partisiz içe aktarın.',
      );
    }
    if (row.batchStatus !== 'active') {
      throw new ConflictException(
        `Parti (${row.batchLabel}) aktif değil (durum: ${row.batchStatus}) — stok eklenemez. ` +
          'Geri çağrılmış/iptal edilmiş partiye eklenen anahtarlar recall süpürmesine yakalanmaz. ' +
          'Yeni bir parti açın ya da partisiz içe aktarın.',
      );
    }
    if (row.unitCostCents == null || row.costCurrency == null) return null;
    return { unitCostCents: row.unitCostCents, costCurrency: row.costCurrency };
  }

  // ─── Stok girişiyle aynı istekte parti + otomatik satın alma emri (§12) ──────────────

  /**
   * Yeni parti PLANI (transaction İÇİNDE hesaplanır): tedarikçi çözümü + kimlikler +
   * tarih/maliyet doğrulaması. Hiçbir PO/parti satırı BURADA yazılmaz — adet henüz
   * bilinmiyor (gerçekten girilen kayıt sayısından türeyecek), bkz. commitAutoReceipt.
   */
  private async prepareAutoReceipt(
    exec: Database,
    productId: string,
    input: NewBatchInput,
    actor: string,
  ): Promise<AutoReceiptPlan> {
    const label = (input.label ?? '').trim();
    if (!label) throw new BadRequestException('Parti etiketi zorunludur.');

    const receivedAt = parseReceivedAt(input.receivedAt);
    const supplier = await this.resolveSupplier(exec, input, true, actor);
    if (input.unitCostCents != null && !supplier) {
      throw new BadRequestException(COST_NEEDS_SUPPLIER_MSG);
    }

    const currency = normalizeCurrency(input.currency);
    // Satın alma emri YALNIZ tedarikçi çözüldüyse açılır; tedarikçisiz giriş bağımsız parti
    // olur (batches.supplier_id / purchase_order_id NULL olabilir — şema destekliyor).
    const purchaseOrderId = supplier ? randomUUID() : null;

    return {
      batchId: randomUUID(),
      purchaseOrderId,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      supplierCreated: supplier?.created ?? false,
      label,
      receivedAt,
      unitCostCents: input.unitCostCents ?? null,
      currency: purchaseOrderId ? currency : null,
      notes: (input.notes ?? '').trim() || null,
      labelDuplicate: await this.hasBatchLabel(exec, productId, label),
      costSnapshot:
        purchaseOrderId && input.unitCostCents != null
          ? { unitCostCents: input.unitCostCents, costCurrency: currency }
          : null,
    };
  }

  /**
   * Planı yazar: (varsa) 'received' satın alma emri + parti + denetim izi.
   * `qty` GERÇEKTEN girilen kayıt sayısıdır — operatörün beyanı değil.
   */
  private async commitAutoReceipt(
    exec: Database,
    productId: string,
    plan: AutoReceiptPlan,
    qty: number,
    actor: string,
  ): Promise<NewBatchOutcome> {
    const note = autoReceiptNote(plan.label, plan.notes);

    if (plan.purchaseOrderId && plan.supplierId) {
      await exec.insert(purchaseOrders).values({
        id: plan.purchaseOrderId,
        supplierId: plan.supplierId,
        productId,
        // Mal zaten elde: emir doğrudan 'received' açılır (panel 'Teslim Al' eylemini
        // otomatik-giriş önekinden tanıyıp gizler → ikinci kez teslim alınıp stok şişmez).
        status: 'received',
        // Mükerrer atlanan anahtarlar ZATEN önceki partide sayıldı; onları da yazmak
        // tedarik harcamasını ÇİFT gösterirdi.
        qtyOrdered: qty,
        qtyReceived: qty,
        unitCostCents: plan.unitCostCents,
        currency: plan.currency ?? 'TRY',
        // orderedAt BİLEREK null: tedarikçi karnesi avgLeadDays = avg(received_at − ordered_at)
        // hesaplar; ikisini eşitlemek her stok girişine "0 gün" ekleyip KPI'ı sıfıra çekerdi.
        orderedAt: null,
        eta: null,
        receivedAt: plan.receivedAt,
        notes: note,
      });
    }

    await exec.insert(batches).values({
      id: plan.batchId,
      supplierId: plan.supplierId,
      purchaseOrderId: plan.purchaseOrderId,
      productId,
      label: plan.label,
      qtyReceived: qty,
      // AÇIKÇA yazılır (kolon default'u now()): maliyet raporu ayları doğrudan bu tarihe göre
      // gruplar — operatörün bildirdiği teslim tarihi korunmalı.
      receivedAt: plan.receivedAt,
      notes: note,
    });

    await exec.insert(auditLog).values({
      action: 'receive',
      actor,
      targetType: plan.purchaseOrderId ? 'purchase_order' : 'batch',
      targetId: plan.purchaseOrderId ?? plan.batchId,
      meta: {
        kind: 'stock_import_auto_receipt',
        source: 'stock_import',
        batchId: plan.batchId,
        purchaseOrderId: plan.purchaseOrderId,
        supplierId: plan.supplierId,
        label: plan.label,
        qtyReceived: qty,
        unitCostCents: plan.unitCostCents,
        currency: plan.currency,
        receivedAt: plan.receivedAt.toISOString(),
      },
    });

    return {
      created: true,
      batchId: plan.batchId,
      purchaseOrderId: plan.purchaseOrderId,
      supplierId: plan.supplierId,
      supplierName: plan.supplierName,
      supplierCreated: plan.supplierCreated,
      supplierExisting: plan.supplierId != null && !plan.supplierCreated,
      label: plan.label,
      receivedAt: plan.receivedAt.toISOString(),
      qtyReceived: qty,
      unitCostCents: plan.unitCostCents,
      currency: plan.currency,
      costSnapshotApplied: plan.costSnapshot != null,
      labelDuplicate: plan.labelDuplicate,
    };
  }

  /**
   * Kuru çalıştırma SONDASI: hiçbir şey yazmaz ama gerçek koşuda patlayacak her şeyi
   * ŞİMDİ doğrular (tedarikçi var mı → 404, tarih aralığı → 400, maliyet-tedarikçi
   * tutarlılığı → 400) ve tahmini sonucu echo eder. `supplierCreated` burada bir
   * TAHMİNDİR ("bu adla tedarikçi açılacak"), gerçek koşuda kilit altında kesinleşir.
   */
  private async probeNewBatch(
    productId: string,
    input: NewBatchInput,
    qty: number,
  ): Promise<NewBatchOutcome> {
    const label = (input.label ?? '').trim();
    if (!label) throw new BadRequestException('Parti etiketi zorunludur.');

    const receivedAt = parseReceivedAt(input.receivedAt);
    const supplier = await this.resolveSupplier(this.db, input, false, 'panel:admin');
    if (input.unitCostCents != null && !supplier) {
      throw new BadRequestException(COST_NEEDS_SUPPLIER_MSG);
    }
    const currency = normalizeCurrency(input.currency);

    return {
      created: false,
      reason: 'dry_run',
      purchaseOrderId: null,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      supplierCreated: supplier?.created ?? false,
      supplierExisting: supplier?.existing ?? false,
      label,
      receivedAt: receivedAt.toISOString(),
      qtyReceived: qty,
      unitCostCents: input.unitCostCents ?? null,
      currency: supplier ? currency : null,
      costSnapshotApplied: supplier != null && input.unitCostCents != null,
      labelDuplicate: await this.hasBatchLabel(this.db, productId, label),
    };
  }

  /**
   * Tedarikçi çözümü. `supplierId` verilmişse VARLIĞI doğrulanır (FK ihlaliyle 500 yerine
   * temiz 404). `supplierName` verilmişse ad eşleşmesi aranır: bulunursa MEVCUT kayıt
   * yeniden kullanılır (aksi halde her girişte bir 'Acme' daha birikirdi — `suppliers.name`
   * UNIQUE DEĞİL), yoksa `create=true` iken yeni kayıt açılır.
   *
   * KİLİT: ad yolunda `pg_advisory_xact_lock` alınır (voidLicenseItem deseni) — kilitsiz iki
   * eşzamanlı giriş "yok → ekle" yarışında iki ayrı tedarikçi üretirdi. Kilit anahtarı SQL
   * `lower()` ile kurulur ki arama yüklemiyle BİREBİR aynı normalizasyonu kullansın (JS
   * `toLowerCase` Türkçe 'İ'de ayrışabilir).
   *
   * `create=false` (kuru çalıştırma) yalnız sondalar: kilit almaz, kayıt açmaz.
   */
  private async resolveSupplier(
    exec: Database,
    input: NewBatchInput,
    create: boolean,
    actor: string,
  ): Promise<{ id: string | null; name: string; created: boolean; existing: boolean } | null> {
    if (input.supplierId && input.supplierName) {
      throw new BadRequestException(
        'Tedarikçi ya listeden seçilir ya da yeni ad girilir — ikisi birlikte gönderilemez.',
      );
    }

    if (input.supplierId) {
      const [row] = await exec
        .select({ id: suppliers.id, name: suppliers.name })
        .from(suppliers)
        .where(eq(suppliers.id, input.supplierId))
        .limit(1);
      if (!row) throw new NotFoundException('Seçilen tedarikçi bulunamadı.');
      return { id: row.id, name: row.name, created: false, existing: true };
    }

    const name = (input.supplierName ?? '').trim();
    if (!name) return null;

    if (create) {
      await exec.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext('supplier:name:' || lower(${name})))`,
      );
    }

    // Pasif (active=false) tedarikçi de YENİDEN KULLANILIR: aynı gerçek firmadır, ikinci bir
    // kayıt açmak mükerrer ad üretirdi. Pasiflik ayrı bir yönetim kararıdır (/suppliers).
    const [existing] = await rawRows<{ id: string; name: string }>(exec, sql`
      SELECT id, name FROM suppliers
      WHERE lower(name) = lower(${name})
      ORDER BY created_at ASC
      LIMIT 1;
    `);
    if (existing) return { id: existing.id, name: existing.name, created: false, existing: true };
    if (!create) return { id: null, name, created: true, existing: false };

    const [row] = await exec
      .insert(suppliers)
      .values({ name, notes: `${AUTO_RECEIPT_NOTE_PREFIX} Stok girişinde otomatik oluşturuldu.` })
      .returning({ id: suppliers.id, name: suppliers.name });
    if (!row) throw new ConflictException('Tedarikçi oluşturulamadı — girişi tekrarlayın.');

    // NOT: audit_action enum'unda 'create' YOK ve migration eklemiyoruz → kaydın kaynağı
    // 'import' eylemi + meta.op ile taşınır (targetType='supplier').
    await exec.insert(auditLog).values({
      action: 'import',
      actor,
      targetType: 'supplier',
      targetId: row.id,
      meta: { op: 'create', source: 'stock_import', name: row.name },
    });
    return { id: row.id, name: row.name, created: true, existing: false };
  }

  /** Aynı üründe aynı etiketli parti var mı? Engel DEĞİL — yalnız operatöre uyarı. */
  private async hasBatchLabel(
    exec: Database,
    productId: string,
    label: string,
  ): Promise<boolean> {
    const rows = await rawRows<{ id: string }>(exec, sql`
      SELECT id FROM batches
      WHERE product_id = ${productId} AND lower(label) = lower(${label})
      LIMIT 3;
    `);
    return rows.length > 0;
  }

  /** Ürün account ise payloadSchema'yı doğrulayıp döner; değilse null. */
  private resolveAccountSchema(product: Product): AccountPayloadSchemaT | null {
    if (product.kind !== 'account') return null;
    const parsed = AccountPayloadSchema.safeParse(product.payloadSchema);
    if (!parsed.success) {
      throw new BadRequestException(
        "kind='account' ürünün payload_schema'sı geçersiz — import reddedildi.",
      );
    }
    return parsed.data;
  }

  /**
   * keyFormat regex'ini derler (bozuk regex → import reddedilir, sessiz kabul yok).
   *
   * GÜVENLİK (2. katman, bkz. `checkKeyFormatSafety` başlığı): desen artık KAYIT ANINDA da
   * denetleniyor, ama bu denetimden ÖNCE kaydedilmiş ürünlerde riskli desen DB'de duruyor
   * olabilir. Import 10.000 payload'a karşı senkron `test()` ettiği için kapı burada da
   * uygulanır: riskli/bozuk desen 400 ile reddedilir (eskiden API'yi kilitleyebiliyordu).
   */
  private compileKeyFormat(product: Product): RegExp | null {
    if (!product.keyFormat) return null;
    const reason = checkKeyFormatSafety(product.keyFormat);
    if (reason) {
      throw new BadRequestException(
        `Ürünün anahtar biçimi (key_format) kullanılamıyor — ${reason} Ürünü düzenleyip deseni düzeltin.`,
      );
    }
    return new RegExp(product.keyFormat);
  }

  /**
   * Import satırını depolanacak KANONİK düz metne çevirir + doğrular.
   * - account: girdi (nesne veya JSON string) şemaya göre doğrulanıp kanonik JSON olur.
   * - key/code/custom: düz string; keyFormat varsa regex'e uyması şart.
   * @throws satır geçersizse (çağıran rejections'a düşürür)
   */
  private normalizePayload(
    payload: string | Record<string, unknown>,
    product: Product,
    accountSchema: AccountPayloadSchemaT | null,
    keyRegex: RegExp | null,
  ): string {
    if (accountSchema) {
      // account: nesne bekle; string gelirse JSON parse et.
      let input: unknown = payload;
      if (typeof payload === 'string') {
        try {
          input = JSON.parse(payload);
        } catch {
          throw new Error('Hesap payload geçerli JSON değil');
        }
      }
      return serializeAccountPayload(accountSchema, input);
    }

    // account olmayan: düz string bekle.
    if (typeof payload !== 'string') {
      throw new Error('Bu ürün tipi için payload düz string olmalı');
    }
    // BAŞ/SON BOŞLUK KIRPILIR — iki yazma yolu AYNI kuralı uygulasın diye (denetim bulgusu).
    // `updateLicenseItemPayload` (kalem düzenleme) girdiyi `.trim()`liyordu, içe aktarma
    // yolu HİÇBİR dönüşüm yapmıyordu. Aynı anahtarın iki farklı yolda iki farklı
    // `payload_hash`i olması, mükerrer denetiminin (UNIQUE payload_hash) KAÇMASI demektir:
    // tedarikçi listesinden sondaki boşlukla gelen bir anahtar ikinci kez stoğa girer ve
    // İKİ MÜŞTERİYE satılabilir. Baştaki/sondaki boşluk hiçbir lisans biçiminin parçası
    // değildir, dolayısıyla bu "sessiz veri değişikliği" değil normalizasyondur.
    //
    // ORTADAKİ görünmez karakterler (sıfır-genişlik vb.) BİLEREK dokunulmadan bırakılır:
    // stok girişi ekranı onları sayar ve tek tıkla temizletir ("temizlemeyiz, GÖSTERİRİZ"
    // kararı) — burada sessizce silmek operatörün gördüğü veriyle kaydedileni ayırırdı.
    payload = payload.trim();
    if (!payload) {
      throw new Error('Payload boş olamaz');
    }
    if (keyRegex) {
      // GÜVENLİK (3. katman — ÇALIŞMA ZAMANI TAVANI): regex'in üzerinde çalışacağı girdi
      // boyu SABİTLENİR. Statik sezgi (checkKeyFormatSafety) tam değildir; onu atlatan bir
      // desende bile geri-izleme maliyeti girdi uzunluğuyla üstel büyüdüğü için tavan tek
      // başına anlamlı bir fren. Sayı `UpdateLicenseItemBody.value` (.max(4_000)) ile aynı.
      // Reddetme SATIR bazındadır (rejections'a düşer) — import bütünüyle patlamaz ve
      // keyFormat'ı OLMAYAN ürünler bu daldan hiç geçmez (davranış değişmez).
      if (payload.length > KEY_FORMAT_MAX_INPUT_LENGTH) {
        throw new Error(
          `Payload çok uzun (${payload.length} karakter) — anahtar biçimi denetimi en fazla ${KEY_FORMAT_MAX_INPUT_LENGTH} karakterde yapılır.`,
        );
      }
      if (!keyRegex.test(payload)) {
        throw new Error('Payload key_format desenine uymuyor');
      }
    }
    return payload;
  }

  /**
   * "Onayla ve Dağıt" önizleme (§13): bu ürüne N birim stok girilirse bekleyen
   * (pending/partial) talebin ne kadarının kapanacağını gösterir. Salt-okunur;
   * import/atama mantığını TETİKLEMEZ — yalnız mevcut açık satırları toplar.
   *
   * TESLİMAT POLİTİKASI (denetim bulgusu): stok girişi yalnız `autoCompleteProduct` FIFO
   * süpürmesini tetikler ve o süpürme SADECE efektif politikası `partial-auto` olan satırları
   * doldurur (all-or-nothing ve partial-approval satırlar elle onay/atama bekler). Önizleme
   * bu filtreyi uygulamadığı için "N bekleyen birimi tamamlar" YANLIŞ VAAT veriyordu:
   * operatör stoğu giriyor, satırlar bekliyor kalıyordu. Artık iki sayı AYRI raporlanır —
   * `autoUnits` (otomatik dolacak) ve `manualUnits` (elle iş gerektiren); wouldFill/
   * remainingAfter YALNIZ autoUnits'ten türetilir. Filtreler autoCompleteProduct ile birebir:
   * iptal (canceled) satır yok, incelemedeki (held_for_review) sipariş yok,
   * coalesce(policy_override, product.fulfillment_policy) = 'partial-auto'.
   */
  async preview(productId: string, count: number): Promise<StockPreview> {
    // Ürün gerçekten var mı? (yoksa 404 — sessiz sıfır göstermeyiz)
    const product = await this.products.getById(productId);

    // Ön sipariş/stoksuz kapısı (§11): release_at gelecekteyse autoCompleteProduct erken
    // çıkar (stok girse bile HİÇBİR satır dolmaz) → otomatik dolacak birim SIFIRdır.
    const preorderWindowOpen = Boolean(
      product.stockless && product.releaseAt && new Date(product.releaseAt).getTime() > Date.now(),
    );

    const [row] = await this.db
      .select({
        // Açık satır sayısı (politikadan bağımsız TOPLAM açık talep).
        lines: sql<number>`count(*)`,
        /*
         * Bekleyen birim — TEK TANIM (denetim R1): `remainingUnitsSql` (orders/fill-target.ts)
         * = qty − canceled_units − fulfilled_qty. Burada ham `qty − fulfilled_qty` yazılıydı;
         * panelden KALICI iptal edilmiş birimler (per-atama "İptal") hâlâ karşılanacak talep
         * sayılıyordu. `autoCompleteProduct` o birimleri ASLA doldurmaz (hedef fill-target'tan
         * gelir) → "Onayla ve Dağıt" modali "bu giriş N bekleyen birimi teslim eder" diye
         * TUTULAMAYACAK bir söz veriyordu (aynı sınıf yanlış vaat bu metodun politika
         * süzgeciyle bir kez düzeltilmişti; iptal defteri açığı kalmıştı).
         */
        units: sql<number>`coalesce(sum(${remainingUnitsSql('order_lines')}), 0)`,
        // Bunun otomatik dolacak kısmı — efektif politika partial-auto olan satırlar.
        autoUnits: sql<number>`coalesce(sum(${remainingUnitsSql('order_lines')})
          FILTER (WHERE coalesce(${orderLines.policyOverride}, ${products.fulfillmentPolicy}) = 'partial-auto'), 0)`,
      })
      .from(orderLines)
      // autoCompleteProduct ("Onayla ve Dağıt" import) ile AYNI filtreler: iptal/iade
      // satırları (canceled) ve incelemedeki (held_for_review) siparişleri oto-tamamlamaz →
      // önizleme de bunları 'karşılanacak talep' saymamalı (yanıltıcı wouldFill düzelir).
      .innerJoin(orders, eq(orderLines.orderId, orders.id))
      // Efektif politikayı okuyabilmek için ürün join'i (satır override > ürün).
      .innerJoin(products, eq(orderLines.productId, products.id))
      .where(
        and(
          eq(orderLines.productId, productId),
          inArray(orderLines.status, ['pending', 'partial']),
          eq(orderLines.canceled, false),
          eq(orders.heldForReview, false),
        ),
      );

    const pendingLines = Number(row?.lines ?? 0);
    const pendingUnits = Number(row?.units ?? 0);
    // Ön sipariş penceresi açıkken hiçbir satır otomatik dolmaz → tümü "elle".
    const autoUnits = preorderWindowOpen ? 0 : Number(row?.autoUnits ?? 0);
    const manualUnits = Math.max(pendingUnits - autoUnits, 0);
    const safeCount = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
    const wouldFill = Math.min(safeCount, autoUnits);
    const remainingAfter = Math.max(safeCount - autoUnits, 0);

    return {
      count: safeCount,
      pendingLines,
      pendingUnits,
      autoUnits,
      manualUnits,
      wouldFill,
      remainingAfter,
    };
  }

  /**
   * Ürün başına anlık SATILABİLİR stok (single: satır sayısı; multi: kalan kapasite).
   * notExpiredCond ile atama sorgusuyla HİZALI: stok ömrü (expires_at) dolmuş kalemler
   * atanamadıkları için sayılmaz — aksi halde panel var olmayan stok gösterirdi.
   */
  async availableCount(productId: string): Promise<number> {
    const [row] = await this.db
      .select({
        count: sql<number>`coalesce(sum(${licenseItems.maxUses} - ${licenseItems.useCount}), 0)`,
      })
      .from(licenseItems)
      .where(
        and(
          eq(licenseItems.productId, productId),
          eq(licenseItems.status, 'available'),
          notExpiredCond('license_items'),
        ),
      );
    return Number(row?.count ?? 0);
  }

  // ─── Lisans envanteri (§12/§13): listeleme + tekil iptal + tekil düzenleme ───────────

  /**
   * Lisans envanteri listesi — HEM ürün-bazlı (ürün detayı tablosu) HEM global
   * (/stock "son eklenen lisanslar") aynı fonksiyondan beslenir; fark yalnız `productId`.
   *
   * PERFORMANS: TEK sorgu + join (N+1 YOK). Sayfa VE toplam artık aynı sorgudan gelir
   * (`count(*) OVER ()` — ayrı COUNT taraması yok); süzgeç + sıralama + LIMIT/OFFSET bir
   * alt-sorguda (page_slice) yalnız license_items üzerinde çalışır, sunum join'leri ve
   * `delivered` LATERAL'i bu sayfaya (≤100 satır) uygulanır. LATERAL lisans başına EN İLGİLİ
   * atamayı verir (önce aktif, sonra en yeni) → çok atamalı MAK anahtarında satır çoğalmaz.
   * Payload çözme de YALNIZ dönen sayfa için yapılır. Sıralama kolonları bilerek
   * license_items'a sınırlıdır ki index'lerden karşılansın (created / status+created / assigned).
   *
   * GÜVENLİK: admin ucudur (AdminGuard) ve sipariş detayıyla aynı politikayı izler — panel
   * kimlik-doğrulamalı olduğu için lisans TAM görünür, bu yüzden her LİSTE görüntülemesi
   * TEK 'reveal' audit kaydına düşer (per-satır değil). Audit yazımı best-effort'tur:
   * hata okuma yolunu düşürmez (sipariş detayı deseni).
   *
   * TUTARLILIK: 'available' süzgeci stok TOPLAMLARIYLA (availableCount / products.list /
   * düşük-stok) AYNI yüklemi kullanır — bkz. aşağıdaki status fragmanı. Her satır ayrıca
   * `expired` bayrağı taşır: `status='available'` görünüp stok ömrü dolmuş kalem hiçbir
   * satılabilir toplamda yoktur, listede de bu bayrakla ayırt edilir.
   */
  async listLicenseItems(
    params: ListLicenseItemsParams = {},
    actor = 'panel:admin',
    // A1: düz-metin lisans YALNIZ owner'a. owner-olmayan 'admin' maskeli görür (sipariş detayıyla aynı politika).
    reveal = true,
    // Dışa aktarma yolu için iç ayarlar (varsayılanlar mevcut davranışı BİREBİR korur).
    opts: ListLicenseItemsOptions = {},
  ): Promise<LicenseInventoryPage> {
    const page = params.page && params.page > 0 ? Math.floor(params.page) : 1;
    // Sayfa boyu normalde izinli kümeye (10/25/50/100) çekilir; dışa aktarma tek istekte
    // tavana kadar satır ister → override yine LICENSE_EXPORT_LIMIT ile tavanlanır.
    const pageSize =
      opts.pageSizeOverride && opts.pageSizeOverride > 0
        ? Math.min(Math.floor(opts.pageSizeOverride), LICENSE_EXPORT_LIMIT)
        : clampPageSize(params.pageSize);
    const offset = (page - 1) * pageSize;
    const { productId, batchId, siteId, status } = params;

    // ── Filtreler ──
    // Fragman TEK yerde kurulur; hem sayfa alt-sorgusu (page_slice) hem de yedek COUNT
    // BİREBİR aynısını kullanır → toplam ile liste asla ayrışamaz.
    const conds: SQL[] = [sql`true`];
    // Bu iki süzgeç doğrudan index'e oturur: li.batch_id → `license_items_batch_idx`,
    // li.product_id → `license_items_product_created_idx` (product_id, created_at, seq —
    // sıralamayı da karşılar). ÖNCEDEN product_id için yalnız `WHERE status='available'`
    // KISMİ index'leri vardı, yani "bu ürünün tüm kalemleri" tam tablo taramasıydı.
    if (productId) conds.push(sql`li.product_id = ${productId}`);
    if (batchId) conds.push(sql`li.batch_id = ${batchId}`);
    // PERF: eski `li.status::text = $1` yazımı KOLONU fonksiyona sokuyordu → sargable değildi,
    // yani `license_items_status_created_idx (status, created_at DESC)` hiç kullanılamazdı.
    // Cast artık PARAMETREdedir: karşılaştırma kolonun kendi tipinde yapılır (index kullanılabilir)
    // ve tip çıkarımı yine sürücüden bağımsız/deterministik kalır.
    // Bilinmeyen değerde Postgres 22P02 (→500) atmasın diye enum listesi önce uygulamada
    // doğrulanır; geçersiz statü ESKİSİYLE AYNI sonucu verir: boş liste (`false` → 0 satır).
    //
    // SATILABİLİR ("available") TANIMI — TEK YÜKLEM (regresyon düzeltmesi): stok toplamları
    // (products.list availableStock, ürün detayı, stock.availableCount, düşük-stok…) süresi
    // GEÇMİŞ kalemleri saymıyor; envanter listesi ise ham `status='available'` süzüyordu →
    // aynı ürün için sayaç "7", "Satılabilir" filtreli liste "12" satır gösteriyordu. Artık
    // envanter de atama yolunun koşulunu (notExpiredCond, tek kaynak assignment/assign.ts)
    // uygular; iki farklı yüklem KALMADI.
    //
    // Süresi dolmuş kalemler KAYBOLMAZ (operatörün görmesi gerekir): filtresiz listede
    // (`expired` bayrağıyla) durur ve 'expired' süzgeciyle DOĞRUDAN listelenir. `status='expired'`
    // enum değerini hiçbir kod yazmıyor (atama süresi AYRI kavram: assignments.status) — bu
    // yüzden 'expired' süzgeci "stok ömrü dolmuş" kalemleri gösterir; ikisi OR'lanır ki ileride
    // enum değeri kullanılırsa da liste eksilmesin.
    if (status) {
      conds.push(
        !(LICENSE_ITEM_STATUSES as readonly string[]).includes(status)
          ? sql`false`
          : status === 'available'
            ? sql`(li.status = ${status}::license_item_status AND ${notExpiredCond('li')})`
            : status === 'expired'
              ? sql`(li.status = ${status}::license_item_status
                     OR (li.status = 'available' AND NOT ${notExpiredCond('li')}))`
              : sql`li.status = ${status}::license_item_status`,
      );
    }
    // "Müşterilerde" süzgeci: kalemin CANLI (active|suspended) bir ataması var mı?
    // 'suspended' de canlıdır — askı geri alınabilir, anahtar hâlâ o siparişe bağlıdır
    // (H1 dersi: askıdaki atamayı "ölü" saymak bedava lisans üretiyordu).
    if (params.holder === 'customer') {
      conds.push(sql`EXISTS (
        SELECT 1 FROM assignments a4
        WHERE a4.license_item_id = li.id AND a4.status IN ('active', 'suspended')
      )`);
    }
    // Site süzgeci: lisansın HERHANGİ bir ataması bu siteye aitse listede kalır (lateral
    // gösterimi de aynı siteye daraltılır → "site X'e teslim edilenler" tutarlı okunur).
    if (siteId) {
      conds.push(sql`EXISTS (
        SELECT 1 FROM assignments a2
        JOIN orders o2 ON o2.id = a2.order_id
        WHERE a2.license_item_id = li.id AND o2.site_id = ${siteId}
      )`);
    }

    // ── Arama (§13) ──
    // ŞİFRELİ payload üzerinde LIKE YAPILAMAZ → anahtar araması global aramadaki
    // (search.service) ANAHTARLI son-hane hash'i üzerinden yapılır: payload_suffix_hash
    // `suffix:<son 5 karakter>` HMAC'idir. Bu yüzden anahtar araması ancak girilen metnin
    // SON 5 karakteri anahtarın son 5 karakteriyle eşleşirse çalışır (5+ karakter girdi;
    // 4 hane TEK BAŞINA eşleşmez — kısıt bilinçli, sır sızdırmayan tek yol budur).
    // Diğer eksenler düz metin: müşteri e-postası, mağaza sipariş no, parti kodu.
    const term = (params.search ?? '').trim();
    if (term.length >= 2) {
      const pattern = `%${escapeLike(term)}%`;

      /*
       * ANAHTAR ARAMASI İKİ YOLLU (kullanıcı: "lisansı tam haliyle de arayabilelim").
       *
       * Payload ŞİFRELİ, üzerinde LIKE yapılamaz — arama yalnız ANAHTARLI hash eşitliğiyle
       * mümkündür. İki hash var ve ikisi de kullanılır:
       *   1) payload_hash        → TAM eşleşme (operatör anahtarın tamamını yapıştırır)
       *   2) payload_suffix_hash → son 5 hane (elinde yalnız kuyruğu varken)
       *
       * BİÇİM TOLERANSI: operatör anahtarı büyük/küçük harf ya da farklı boşluklarla
       * yapıştırabilir; hash birebir metin üzerinden hesaplandığı için tek varyant denemek
       * "yok" derdi. Bu yüzden birkaç kanonik varyant (ham · boşluklar sadeleşmiş · boşluksuz,
       * her biri ayrıca BÜYÜK harfli) denenir. Sayı sabittir (≤6), maliyeti ihmal edilebilir.
       * NOT: hash'ler anahtarlıdır (master key) → DB'yi ele geçiren biri bu aramayı yapamaz.
       */
      const collapsed = term.replace(/\s+/g, ' ');
      const variants = new Set<string>([
        term,
        collapsed,
        collapsed.replace(/\s+/g, ''),
        term.toUpperCase(),
        collapsed.toUpperCase(),
        collapsed.replace(/\s+/g, '').toUpperCase(),
      ]);
      const exactList = [...variants].map((v) => sql`${this.crypto.payloadHash(v)}`);

      // Son-5 yolu: 5+ karakter girildiyse. Varyantların son 5'i farklı olabileceği için
      // (ör. boşluklu yapıştırma) hepsi denenir; 4 hane TEK BAŞINA eşleşmez (bilinçli kısıt).
      const suffixList = [...variants]
        .filter((v) => v.length >= 5)
        .map((v) => sql`${this.crypto.payloadSuffixHash(v)}`);
      // Varyant yoksa DAL HİÇ ÜRETİLMEZ — eski `OR false` ile birebir aynı sonuç kümesi.
      const suffixBranch =
        suffixList.length > 0
          ? sql`
        UNION ALL
        -- 2) son 5 hane → license_items_suffix_idx
        SELECT ls.id FROM license_items ls
        WHERE ls.payload_suffix_hash IN (${sql.join(suffixList, sql`, `)})`
          : sql``;

      /*
       * PLAN (denetim bulgusu — ORTA): eskiden bütün eksenler TEK dev OR bloğuydu:
       *   (payload_hash IN (…) OR payload_suffix_hash IN (…) OR b.label ILIKE …
       *    OR p.name ILIKE … OR p.sku ILIKE … OR EXISTS (assignments JOIN orders …))
       * Postgres bir OR'u ancak TÜM dalları indekslenebilirse BitmapOr ile karşılar. Buradaki
       * ILIKE dalları ve KORELE `EXISTS` indekslenemez → planlayıcı OR'un tamamını satır
       * süzgecine düşürüyordu: en yaygın senaryoda bile (operatör TAM anahtarı yapıştırır,
       * `license_items_payload_hash_uniq` ile tek satır bulunabilir) `license_items` TAM
       * TARANIYOR ve eşleşmeyen HER satır için 3-join'li EXISTS alt-planı koşuyordu.
       *
       * Artık aday id kümesi UNION ALL ile ayrı dallardan üretilir: hash dalları kendi
       * UNIQUE/suffix indekslerinden karşılanır, metinsel dallar KÜÇÜK tablolarda (batches,
       * products) ve assignments/orders üzerinde YALNIZ BİR KEZ (korelasyon yok) koşar.
       * `IN (alt sorgu)` semi-join'e dönüşür → satır ÇOĞALTMAZ (UNION ALL'ın mükerrer id'leri
       * sonucu etkilemez), bu yüzden `count(*) OVER ()` toplamı da değişmez.
       *
       * NEDEN CTE DEĞİL, SATIR-İÇİ ALT SORGU: bu fragman İKİ sorguda kullanılıyor (page_slice
       * ve yedek countLicenseItems). Ayrı bir `WITH` bloğu iki sorgunun başına AYRI AYRI
       * eklenmek zorunda kalır ve ikisinin ayrışması bu projede daha önce yaşanan "toplam ile
       * liste çelişir" hatasını doğurur. Alt sorgu `where` fragmanının İÇİNDE kaldığı için iki
       * sorgu otomatik olarak BİREBİR aynı süzgeci taşır. Plan şekli aynıdır (uncorrelated
       * alt sorgu — hash'lenip tek kez değerlendirilir).
       *
       * DAVRANIŞ BİREBİR KORUNUR: hangi girdinin hangi satırı bulduğu değişmedi (tam anahtar,
       * son-5 hane, ürün adı, SKU, parti kodu, müşteri e-postası, mağaza sipariş no). Metinsel
       * dallarda LEFT JOIN → JOIN dönüşümü sonucu değiştirmez: eski yazımda da `b.label` NULL
       * (partisiz kalem) ILIKE'ı asla sağlamıyordu.
       */
      conds.push(sql`li.id IN (
        -- 1) TAM anahtar → license_items_payload_hash_uniq (UNIQUE index)
        SELECT lh.id FROM license_items lh
        WHERE lh.payload_hash IN (${sql.join(exactList, sql`, `)})${suffixBranch}
        UNION ALL
        -- 3) parti kodu
        SELECT lb.id FROM license_items lb
        JOIN batches b2 ON b2.id = lb.batch_id
        WHERE b2.label ILIKE ${pattern} ESCAPE '\\'
        UNION ALL
        -- 4) ÜRÜN ADI/SKU: operatör çoğu zaman "hangi üründen kaç kalem var" diye arıyor;
        --    eskiden bu eksen YOKTU ve ürün adı yazınca liste boş dönüyordu (yanıltıcı).
        SELECT lp.id FROM license_items lp
        JOIN products p2 ON p2.id = lp.product_id
        WHERE p2.name ILIKE ${pattern} ESCAPE '\\'
           OR p2.sku ILIKE ${pattern} ESCAPE '\\'
        UNION ALL
        -- 5) müşteri e-postası / mağaza sipariş no (artık korele DEĞİL: tek geçiş)
        SELECT a3.license_item_id FROM assignments a3
        JOIN orders o3 ON o3.id = a3.order_id
        WHERE o3.customer_email ILIKE ${pattern} ESCAPE '\\'
           OR o3.remote_order_id ILIKE ${pattern} ESCAPE '\\'
      )`);
    }

    const where = sql.join(conds, sql` AND `);
    // Lateral'i site süzgecine bağla (yukarıdaki EXISTS ile tutarlı gösterim).
    const lateralSite = siteId ? sql`AND o.site_id = ${siteId}` : sql`AND true`;
    // ── Sıralama ──
    // KURAL: sıralama YALNIZ license_items kolonlarından kurulur. Böylece sayfa alt-sorgusu
    // (aşağıda) index'ten karşılanır ve pahalı LATERAL yalnız DÖNEN sayfa için koşar.
    //
    // `assigned_desc` eskiden LATERAL'in `d.assigned_at`ine (atamanın delivered/created zamanı)
    // göre sıralıyordu → sıralayabilmek için LATERAL'in EŞLEŞEN HER satır için çalışması
    // gerekiyordu (satır başına 3-join'li alt-sorgu). Artık `li.assigned_at` kolonu kullanılır
    // (atama anında yazılır) → `license_items_assigned_idx (assigned_at DESC NULLS LAST)`.
    //
    // BİLİNEN SAPMA (tek-kullanımda pratikte aynı, iki kenar durumda değil):
    //  · atama geri alınıp kalem 'available'a DÖNDÜYSE (all-or-nothing rollback / adet düşürme)
    //    li.assigned_at NULL'lanır → kalem artık sona düşer. Doğrusu da budur: kalem teslim
    //    edilmiş değildir. ('quarantined' olan iade/değişim kalemlerinde assigned_at KORUNUR.)
    //  · MULTI/MAK kapasite düşümü artık `assigned_at = COALESCE(assigned_at, now())` yazıyor
    //    (assign.ts, consumeMultiUseCapacity) → MAK kalemleri de sıralamada doğru yerde çıkar.
    //    Damga İLK teslimi gösterir; sonraki kapasite düşümleri onu kaydırmaz.
    // TIE-BREAK = `li.seq` (ekleme sırası), `li.id` DEĞİL.
    // Bir içe aktarmanın tüm satırları TEK transaction'da yazılır → `created_at` hepsinde
    // AYNI (ölçüldü: 15 satırlık giriş tek damga). Eski tie-break rastgele UUID olduğu için
    // operatörün yapıştırdığı liste ekranda KARIŞIK görünüyordu.
    //
    // YÖN (kullanıcı kararı): SATIR SATIR en yeni üstte → `created_at DESC, seq DESC`.
    // Yani bir girişte `test1, test2` yapıştırıldıysa listede `test2` ÜSTTE görünür; bloklar
    // arası da en yeni giriş üstte. "Blok içi ASC" (yapıştırma sırası) İLK denenen yorumdu,
    // kullanıcı ekran görüntüsüyle düzeltti: liste bir AKIŞ, en son eklenen her zaman başta.
    // TESLİMAT bundan BAĞIMSIZ ve TERS yönde kalır (assign.ts: FEFO → created_at → seq ASC,
    // yani önce girilen önce teslim edilir) — listeleme sunum, atama iş kuralı.
    //
    // PLANLAYICI: `(created_at DESC, seq DESC)` sıralaması `license_items_created_asc_idx`
    // `(created_at ASC, seq ASC)` btree'sinin GERİYE taramasıyla karşılanır (geriye tarama
    // her iki kolonun yönünü de çevirir). Bu yüzden burada `NULLS LAST` YAZILMAZ: geriye
    // tarama `DESC NULLS FIRST` üretir ve `DESC`in SQL varsayılanı da NULLS FIRST'tür →
    // pathkey birebir eşleşir. (`NULLS LAST` yazarsak eşleşme kaçar, tam sort'a düşeriz.)
    // Her iki kolon da NOT NULL olduğu için sonuç kümesi zaten aynıdır.
    const orderBy =
      params.sort === 'created_asc'
        ? sql`li.created_at ASC, li.seq ASC`
        : params.sort === 'assigned_desc'
          ? sql`li.assigned_at DESC NULLS LAST, li.created_at DESC, li.seq DESC`
          : sql`li.created_at DESC, li.seq DESC`;

    // ── Sayfa + toplam: TEK sorgu (iki CTE) ──
    // Eskiden rows ve count(*) AYRI iki sorguydu; ikisi de aynı süzgeçle license_items'ı
    // baştan tarıyordu (iki tam geçiş + iki tur ağ). Sonra toplam `count(*) OVER ()` ile
    // sayfa alt-sorgusuna alındı — ama PENCERE FONKSİYONU LIMIT'ten ÖNCE, süzgece uyan TÜM
    // bölüm üzerinde çalışır: süzgeçsiz açılışta her görüntüleme tabloyu BAŞTAN SAYIYORDU
    // (denetim bulgusu — ORTA). Artık sayım AYRI ve TAVANLI bir CTE'de yapılır
    // (`LIMIT CAP+1` → en çok 10.001 satıra dokunur; bkz. LICENSE_COUNT_CAP).
    //
    // TEK SORGU KORUNUR (ayrı bir COUNT turu açılmaz): tavanlı CTE sayfayla CROSS JOIN edilir
    // — bir satır döndürdüğü için satır sayısını ETKİLEMEZ. Süzgeç fragmanı ikisinde de
    // BİREBİR aynı `where` nesnesidir (iki ayrı yazım bu projede "toplam ile liste çelişir"
    // hatasını doğurmuştu).
    //
    // Sayfa alt sorgusu ayrıca N+1'in tersini de çözer: LIMIT/OFFSET, JOIN'lerden ve
    // LATERAL'den ÖNCE uygulanır → ürün/parti/tedarikçi join'leri ve teslimat LATERAL'i
    // yalnız ≤100 satır için koşar (eskiden LATERAL, sıralamadan önce eşleşen HER satır
    // için çalışabiliyordu).
    const rows = await rawRows<LicenseItemRawRow & { total_count: number }>(this.db, sql`
        WITH page_slice AS (
          -- Süzgeç ARTIK yalnız license_items'a dokunur: arama fragmanı b/p join'lerine değil
          -- kendi UNION ALL aday alt sorgusuna dayanıyor (yukarı bkz.) → sayfa alt-sorgusu
          -- index'ten karşılanır, sunum join'leri (aşağıda) yalnız dönen sayfaya uygulanır.
          -- Süzgeç fragmanı countLicenseItems ile BİREBİR aynı olmalı, yoksa toplam ile
          -- liste ayrışır; bu yüzden fragman TEK yerde kurulur ve join gerektirmez.
          -- (NOT: bu SQL bir template literal — yorumda TERS TIRNAK kullanılamaz, şablonu kapatır.)
          SELECT li.id AS id
          FROM license_items li
          WHERE ${where}
          ORDER BY ${orderBy}
          LIMIT ${pageSize} OFFSET ${offset}
        ),
        capped_total AS (
          -- SINIRLI sayım (audit.service deseni): iç LIMIT sayesinde planlayıcı CAP+1 satır
          -- görür görmez durur. SELECT 1 yeter — sayım için kolon okumaya gerek yok.
          SELECT count(*)::int AS n
          FROM (SELECT 1 FROM license_items li WHERE ${where} LIMIT ${LICENSE_COUNT_CAP + 1}) capped
        )
        SELECT
          li.id                       AS id,
          li.product_id               AS product_id,
          p.name                      AS product_name,
          p.sku                       AS product_sku,
          p.kind::text                AS product_kind,
          p.usage_mode::text          AS usage_mode,
          p.payload_schema            AS payload_schema,
          li.payload_enc              AS payload_enc,
          li.status::text             AS status,
          li.max_uses                 AS max_uses,
          li.use_count                AS use_count,
          li.batch_id                 AS batch_id,
          b.label                     AS batch_code,
          s.name                      AS supplier_name,
          li.unit_cost_cents          AS unit_cost_cents,
          li.cost_currency            AS cost_currency,
          li.created_at               AS created_at,
          li.expires_at               AS expires_at,
          -- "Satılabilir mi?" kararı SUNUCUDA verilir (now() DB saatidir) ve stok
          -- toplamlarıyla AYNI yüklemden türetilir → liste ile sayaçlar asla ayrışmaz.
          (NOT ${notExpiredCond('li')})
                                      AS is_expired,
          d.assignment_id             AS assignment_id,
          d.assignment_status         AS assignment_status,
          d.units                     AS units,
          d.assigned_at               AS assigned_at,
          d.valid_until               AS valid_until,
          d.order_id                  AS order_id,
          d.remote_order_id           AS remote_order_id,
          d.customer_email            AS customer_email,
          d.site_id                   AS site_id,
          d.site_domain               AS site_domain,
          d.site_type                 AS site_type,
          d.admin_order_url_template  AS admin_order_url_template,
          ct.n                        AS total_count
        FROM page_slice ps
        CROSS JOIN capped_total ct
        JOIN license_items li ON li.id = ps.id
        JOIN products p ON p.id = li.product_id
        LEFT JOIN batches b ON b.id = li.batch_id
        LEFT JOIN suppliers s ON s.id = b.supplier_id
        LEFT JOIN LATERAL (
          SELECT
            a.id AS assignment_id,
            a.status::text AS assignment_status,
            a.units AS units,
            COALESCE(a.delivered_at, a.created_at) AS assigned_at,
            a.valid_until AS valid_until,
            o.id AS order_id,
            o.remote_order_id AS remote_order_id,
            o.customer_email AS customer_email,
            st.id AS site_id,
            st.domain AS site_domain,
            st.type::text AS site_type,
            st.admin_order_url_template AS admin_order_url_template
          FROM assignments a
          JOIN orders o ON o.id = a.order_id
          JOIN sites st ON st.id = o.site_id
          WHERE a.license_item_id = li.id ${lateralSite}
          ORDER BY (a.status = 'active') DESC, a.created_at DESC
          LIMIT 1
        ) d ON TRUE
        -- Süzgeç/limit page_slice'ta uygulandı; burada yalnız sıra yeniden kurulur
        -- (join sonrası satır sırası GARANTİ DEĞİLDİR).
        ORDER BY ${orderBy};
      `);

    const mapped = rows.map((r) => this.mapInventoryRow(r, reveal));

    // Toplam: normalde tavanlı CTE'den (ek sorgu turu YOK). Tek istisna, OFFSET'in sonuç
    // kümesini AŞMASIDIR: CROSS JOIN hiç satır üretmez → sayaç da gelmez. Bu durumda kontratı
    // korumak için (total = süzgece uyan kayıt sayısı, sayfa boş olsa bile) yedek sayım
    // koşulur — yalnız page>1 iken, yani "3. sayfadayken filtre daraldı" senaryosunda.
    // 1. sayfa boşsa toplam zaten 0'dır, gereksiz sorgu açılmaz. Yedek sayım da AYNI tavanı
    // uygular (yoksa kaçış yolu tam tablo taraması olurdu — düzeltilen hatanın ta kendisi).
    //
    // HAM değer CAP+1 olabilir; dışarıya CAP olarak verilir ve `totalCapped` ile "en az bu
    // kadar" olduğu SÖYLENİR (audit.service ile birebir aynı sözleşme).
    const rawTotal =
      rows.length > 0
        ? Number(rows[0]?.total_count ?? 0)
        : page > 1
          ? await this.countLicenseItems(where)
          : 0;
    const totalCapped = rawTotal > LICENSE_COUNT_CAP;
    const total = totalCapped ? LICENSE_COUNT_CAP : rawTotal;

    // Görüntüleme audit'i (§8 "reveal audit'e düşer"): YALNIZ düz-metin gerçekten gösterildiğinde
    // (owner, reveal=true) yazılır — owner-olmayan 'admin' maskeli gördüğünden reveal değildir (A1).
    // `audit: false` → çağıran kendi TEK kaydını yazar (dışa aktarma) — çift kayıt olmasın.
    if (reveal && opts.audit !== false && mapped.length > 0) {
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor,
          targetType: 'license_item_list',
          targetId: productId ?? 'all',
          meta: {
            auto: true,
            view: 'license_inventory',
            count: mapped.length,
            page,
            pageSize,
            productId: productId ?? null,
            siteId: siteId ?? null,
            batchId: batchId ?? null,
            status: status ?? null,
            // Arama metni BİLEREK yazılmaz: kısmi anahtar olabilir (§8 audit meta'ya
            // payload düz metni ASLA girmez).
            hasSearch: term.length >= 2,
          },
        });
      } catch {
        /* audit yazımı başarısız → liste yine de döner */
      }
    }

    // `masked` = "bu yanıttaki değerler düz metin DEĞİL". İstemci dosyaya uyarı basmak için
    // bunu bilmek zorunda (kendi başına maske gövdesini aramak kırılgan bir tahmindir).
    return {
      rows: mapped,
      total,
      totalCapped,
      countCap: LICENSE_COUNT_CAP,
      page,
      pageSize,
      masked: !reveal,
    };
  }

  /**
   * Lisans envanteri DIŞA AKTARMA (§12/§13) — mutabakat/muhasebe için tek istekte liste.
   *
   * NEDEN AYRI UÇ (sayfaları istemcide döngüyle toplamak yerine):
   *  · Sayfalı ucu 50 kez çağırmak 50 ayrı derin-OFFSET sorgusu + 50 ayrı 'reveal' audit kaydı
   *    demekti; denetim izi "kim neyi dışa aktardı" sorusunu cevaplayamaz hâle gelirdi.
   *  · Sayfalar arasında veri DEĞİŞEBİLİR (aynı anda import/atama) → dosyada mükerrer ya da
   *    atlanmış satır oluşurdu. Tek sorgu tutarlı bir anlık görüntü verir.
   *  · Tavan SUNUCUDA uygulanır; istemcinin "ne kadar isterse o kadar" çekme yolu YOK.
   *
   * Süzgeç/sıralama/maskeleme mantığı TEKRARLANMAZ: `listLicenseItems` aynen çağrılır
   * (tek doğruluk kaynağı — liste ile dosya asla farklı kayıt kümesi gösteremez).
   */
  async exportLicenseItems(
    params: ListLicenseItemsParams = {},
    actor = 'panel:admin',
    reveal = true,
  ): Promise<LicenseInventoryExport> {
    const limit = LICENSE_EXPORT_LIMIT;
    const page = await this.listLicenseItems({ ...params, page: 1 }, actor, reveal, {
      pageSizeOverride: limit,
      audit: false,
    });
    // Kırpılma kararı `total > rows.length` ile verilir. `total` artık LICENSE_COUNT_CAP ile
    // tavanlı olabilir, AMA karar bundan ETKİLENMEZ: tavan (10.000) dışa aktarma limitinden
    // (5.000) büyük olduğu için tavana dayanılan her senaryoda zaten 10.000 > 5.000 ⇒ true.
    // (Tavan bir gün limitin ALTINA çekilirse bu çıkarım bozulur — ikisi birlikte okunmalı.)
    const truncated = page.total > page.rows.length;

    // §8 DEĞİŞMEZ KURAL: "reveal audit'e düşer". Dosyaya düz metin YAZILDIĞINDA tek bir kayıt
    // düşer; owner-olmayan admin maskeli dosya indirdiğinde reveal GERÇEKLEŞMEZ (A1) → yazılmaz.
    // Anahtarın KENDİSİ meta'ya ASLA girmez; yalnız kapsam (kaç kalem, hangi süzgeç) yazılır.
    if (reveal && page.rows.length > 0) {
      try {
        await this.db.insert(auditLog).values({
          action: 'reveal',
          actor,
          targetType: 'license_item_list',
          targetId: params.productId ?? 'all',
          meta: {
            op: 'export',
            view: 'license_inventory',
            count: page.rows.length,
            total: page.total,
            totalCapped: page.totalCapped,
            truncated,
            limit,
            productId: params.productId ?? null,
            siteId: params.siteId ?? null,
            batchId: params.batchId ?? null,
            status: params.status ?? null,
            holder: params.holder ?? null,
            sort: params.sort ?? null,
            // Arama METNİ yazılmaz: kısmi/tam anahtar olabilir (audit meta'ya payload girmez).
            hasSearch: (params.search ?? '').trim().length >= 2,
          },
        });
      } catch {
        /* audit yazımı başarısız → dışa aktarma yine de döner (okuma yolu düşmez) */
      }
    }

    return {
      rows: page.rows,
      total: page.total,
      totalCapped: page.totalCapped,
      countCap: page.countCap,
      limit,
      truncated,
      masked: page.masked,
    };
  }

  /**
   * Toplam kayıt sayısının YEDEK sorgusu — yalnız "sayfa boş ama page>1" kenar durumunda
   * çalışır (bkz. listLicenseItems). Süzgeç fragmanı ana sorguyla BİREBİR aynıdır: `where`
   * artık YALNIZ `li` kolonlarına ve kendi kendine yeten alt sorgulara dayandığı için
   * (arama adayları UNION ALL alt sorgusunda) burada batches/products join'i GEREKMEZ —
   * iki sorgunun join listesi ayrışıp sonuçların çelişmesi de imkânsızlaşır.
   *
   * TAVAN BURADA DA UYGULANIR (aynı `LIMIT CAP+1` deseni): aksi halde "derin sayfada süzgeç
   * daraldı" kenar durumu, tam da kaçınmak istediğimiz tam tablo taramasına açılan bir kaçış
   * yolu olurdu. Dönen değer CAP+1 olabilir; çağıran tavanı uygular.
   */
  private async countLicenseItems(where: SQL): Promise<number> {
    const rows = await rawRows<{ c: number }>(this.db, sql`
      SELECT count(*)::int AS c
      FROM (SELECT 1 FROM license_items li WHERE ${where} LIMIT ${LICENSE_COUNT_CAP + 1}) capped;
    `);
    return Number(rows[0]?.c ?? 0);
  }

  /** HAM satır → API sözleşmesi (payload çözme + mağaza admin linki burada üretilir). */
  private mapInventoryRow(r: LicenseItemRawRow, reveal = true): LicenseInventoryRow {
    const decoded = this.decodeInventoryPayload(r, reveal);
    const maxUses = Number(r.max_uses ?? 1);
    const useCount = Number(r.use_count ?? 0);
    return {
      id: r.id,
      productId: r.product_id,
      productName: r.product_name,
      productSku: r.product_sku,
      productType: r.product_kind,
      usageMode: r.usage_mode,
      status: r.status,
      maxUses,
      useCount,
      remainingUses: Math.max(maxUses - useCount, 0),
      kind: decoded.kind,
      value: decoded.value,
      fields: decoded.fields,
      batchId: r.batch_id,
      batchCode: r.batch_code,
      supplierName: r.supplier_name,
      unitCostCents: r.unit_cost_cents == null ? null : Number(r.unit_cost_cents),
      costCurrency: r.cost_currency,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      // Sunucudan gelen karar (istemci saati/zaman dilimi HESABA KATILMAZ).
      expired: r.is_expired === true,
      delivered:
        r.assignment_id && r.order_id && r.site_id
          ? {
              assignmentId: r.assignment_id,
              assignmentStatus: r.assignment_status ?? 'active',
              units: Number(r.units ?? 1),
              assignedAt: r.assigned_at,
              validUntil: r.valid_until,
              orderId: r.order_id,
              remoteOrderId: r.remote_order_id ?? '',
              customerEmail: r.customer_email ?? '',
              siteId: r.site_id,
              siteDomain: r.site_domain ?? '',
              siteType: r.site_type ?? '',
              // Mağaza adminindeki sipariş — SALT LİNK (tek kaynak: orders/store-admin-url.ts).
              storeAdminUrl: buildStoreAdminUrl(
                {
                  type: r.site_type,
                  domain: r.site_domain,
                  adminOrderUrlTemplate: r.admin_order_url_template,
                },
                r.remote_order_id,
              ),
            }
          : null,
    };
  }

  /**
   * Şifreli payload'ı çözer. account ürününde şemaya göre alan-alan; diğer tiplerde düz
   * değer. Çözme hatası (bozuk kayıt / AAD uyuşmazlığı) listeyi DÜŞÜRMEZ — value/fields
   * null döner (UI "okunamadı" gösterir).
   */
  private decodeInventoryPayload(
    r: LicenseItemRawRow,
    reveal = true,
  ): {
    kind: 'key' | 'account';
    value: string | null;
    fields: LicenseInventoryField[] | null;
  } {
    const isAccount = r.product_kind === 'account';
    let plain: string;
    try {
      plain = this.crypto.decrypt(r.payload_enc, CryptoService.licenseItemAad(r.id));
    } catch {
      return { kind: isAccount ? 'account' : 'key', value: null, fields: null };
    }
    // A1: owner-olmayan 'admin' → maskeli (key son-4; account alan-alan kuyruksuz maske).
    if (!isAccount) return { kind: 'key', value: reveal ? plain : maskSecret(plain), fields: null };

    const parsed = AccountPayloadSchema.safeParse(r.payload_schema);
    if (!parsed.success) {
      // Şema bozuk/eksik → ham JSON'u kolonlara DÖKMEK yerine tek alan olarak göster (maskeli değilse maskele).
      return {
        kind: 'account',
        value: null,
        fields: [
          { key: 'payload', label: 'Lisans (ham)', value: reveal ? plain : maskSecret(plain), secret: false },
        ],
      };
    }
    const parsedFields = parseAccountPayload(parsed.data, plain);
    const shown = reveal ? parsedFields : maskAccountFields(parsedFields);
    return {
      kind: 'account',
      value: null,
      fields: shown.map((f) => ({
        key: f.key,
        label: f.label,
        value: f.value,
        secret: f.secret,
      })),
    };
  }

  /**
   * Tekil lisans İPTALİ (§12). Kayıt SİLİNMEZ — `status='voided'` olur (izlenebilirlik:
   * hangi anahtar neden düştü, karantina ekranından okunur). Yalnız TESLİM EDİLMEMİŞ ve
   * hâlâ satılabilir (available) kalem iptal edilebilir.
   *
   * TOCTOU: advisory-lock (kalem id'si) + `FOR UPDATE` + koşullu UPDATE — iptal ile
   * eşzamanlı atama (SKIP LOCKED) yarışında ikisinden yalnız biri kazanır; atama kazanırsa
   * iptal 409 verir (asla teslim edilmiş anahtar void'lenmez).
   *
   * STOK SAYIMI: availableCount/products.list Σ(max_uses − use_count) WHERE status='available'
   * AND notExpiredCond hesapladığı için 'voided' kalem otomatik düşer; MULTI'de KALAN kapasite
   * düşer (fire miktarı stock_adjustments.qty'ye de aynı şekilde yazılır → maliyet/zayi doğru).
   */
  async voidLicenseItem(id: string, reason: string, actor: string) {
    const trimmed = (reason ?? '').trim();
    if (!trimmed) throw new BadRequestException('İptal sebebi zorunludur.');

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'license_item:' + id}))`);

      const [item] = await rawRows<{
        id: string;
        product_id: string;
        status: string;
        max_uses: number;
        use_count: number;
      }>(tx, sql`
        SELECT id, product_id, status::text AS status, max_uses, use_count
        FROM license_items WHERE id = ${id} LIMIT 1 FOR UPDATE;
      `);
      if (!item) throw new NotFoundException('Lisans bulunamadı.');

      // Teslim edilmiş mi? (aktif VEYA askıya alınmış atama = müşteride canlı lisans)
      const live = await rawRows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM assignments
        WHERE license_item_id = ${id} AND status IN ('active', 'suspended');
      `);
      if (Number(live[0]?.n ?? 0) > 0) throw new ConflictException(DELIVERED_MSG);

      if (item.status !== 'available') {
        throw new ConflictException(
          item.status === 'voided'
            ? 'Bu lisans zaten iptal edilmiş.'
            : `Yalnız satılabilir (available) durumdaki lisans iptal edilebilir. Mevcut durum: ${item.status}.`,
        );
      }

      const [updated] = await rawRows<{ id: string; max_uses: number; use_count: number }>(tx, sql`
        UPDATE license_items SET status = 'voided'
        WHERE id = ${id} AND status = 'available'
        RETURNING id, max_uses, use_count;
      `);
      if (!updated) throw new ConflictException(DELIVERED_MSG);

      // Fire miktarı: tek-kullanım → 1, multi/MAK → KALAN kapasite (supply-ops deseni).
      const remaining = Number(updated.max_uses) - Number(updated.use_count);
      const qty = remaining > 0 ? remaining : 1;

      await tx.insert(stockAdjustments).values({
        productId: item.product_id,
        licenseItemId: id,
        action: 'void',
        qty,
        reason: trimmed,
        actor,
      });
      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: 'license_item',
        targetId: id,
        meta: { action: 'void', qty, reason: trimmed, source: 'license_inventory' },
      });

      return { id, status: 'voided' as const, productId: item.product_id, qty };
    });
  }

  /**
   * Tekil lisans DEĞİŞTİRME (payload düzeltme, §12). Yanlış/bozuk girilmiş bir anahtarı
   * ya da hesap alanlarını yeniden yazar: yeni düz metin envelope ile ŞİFRELENİR (AES-256-GCM,
   * AAD `license_item:<id>` KORUNUR → ciphertext satır-taşıma hâlâ imkânsız) ve dedupe
   * alanları (payload_hash / payload_suffix_hash) birlikte güncellenir.
   *
   * SINIR: yalnız TESLİM EDİLMEMİŞ + available kalem. Teslim edilmiş anahtarın değişimi
   * envanterin işi DEĞİLDİR — o akış assignment replace'tir (eski anahtar karantinaya
   * gider, müşteriye TAZE anahtar atanır). Aksi halde müşterideki anahtar sessizce
   * geçersizleşirdi.
   */
  async updateLicenseItemPayload(id: string, input: UpdateLicenseItemInput, actor: string) {
    const reason = (input.reason ?? '').trim();
    if (!reason) throw new BadRequestException('Değişiklik sebebi zorunludur.');

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'license_item:' + id}))`);

      const [row] = await rawRows<{
        id: string;
        product_id: string;
        status: string;
        payload_hash: string;
        kind: string;
        payload_schema: unknown;
        key_format: string | null;
      }>(tx, sql`
        SELECT li.id, li.product_id, li.status::text AS status, li.payload_hash,
               p.kind::text AS kind, p.payload_schema, p.key_format
        FROM license_items li
        JOIN products p ON p.id = li.product_id
        WHERE li.id = ${id} LIMIT 1 FOR UPDATE OF li;
      `);
      if (!row) throw new NotFoundException('Lisans bulunamadı.');

      const live = await rawRows<{ n: number }>(tx, sql`
        SELECT count(*)::int AS n FROM assignments
        WHERE license_item_id = ${id} AND status IN ('active', 'suspended');
      `);
      if (Number(live[0]?.n ?? 0) > 0) throw new ConflictException(DELIVERED_MSG);

      if (row.status !== 'available') {
        throw new ConflictException(
          `Yalnız satılabilir (available) durumdaki lisans düzenlenebilir. Mevcut durum: ${row.status}.`,
        );
      }

      // ── MASKELİ DEĞER KAPISI (denetim bulgusu) — otoriter katman SUNUCUDA ──
      //
      // Owner OLMAYAN admin envanterde bir kaydı düzenlerken form alanları MASKELİ değerlerle
      // ön-doldurulur (canRevealPlaintext=false). Yalnız bir alanı düzeltip kaydederse kalan
      // alanlarda `••••••` gider ve GERÇEK sırrın üzerine bu dize şifrelenir → satılmamış
      // lisans sessizce yok olur (eski ciphertext üzerine yazıldığı için geri dönüş yoktur;
      // hata da alınmaz, "Değişiklik kaydedildi" der). `serializeAccountPayload` için `••••••`
      // geçerli bir dolu değerdir, dolayısıyla kapı BURADA olmak zorunda.
      //
      // İstemci tarafındaki düğme-kilidi tek başına yeterli değildir: bu servis doğrudan da
      // çağrılabilir ve projenin kuralı gereği otoriter kontrol sunucudadır.
      const maskedInput = [
        ...(input.fields ? Object.values(input.fields) : []),
        ...(input.value != null ? [input.value] : []),
      ].some((v) => typeof v === 'string' && looksMasked(v));
      if (maskedInput) {
        throw new BadRequestException(
          'Maskeli değer kaydedilemez. Görüntüleme yetkiniz olmadığı için alanlar maskeli ' +
            'geldi; bu kaydı düzenlemek için tam değerleri girin veya owner yetkisi isteyin.',
        );
      }

      // ── Yeni düz metni üret + doğrula (import yoluyla BİREBİR aynı kurallar) ──
      let plaintext: string;
      let fields: LicenseInventoryField[] | null = null;
      if (row.kind === 'account') {
        const parsed = AccountPayloadSchema.safeParse(row.payload_schema);
        if (!parsed.success) {
          throw new BadRequestException(
            'Ürünün hesap alan şeması (payload_schema) geçersiz — düzenleme yapılamaz.',
          );
        }
        if (!input.fields || typeof input.fields !== 'object') {
          throw new BadRequestException('Hesap ürününde `fields` (alan → değer) zorunludur.');
        }
        try {
          plaintext = serializeAccountPayload(parsed.data, input.fields);
        } catch (err) {
          throw new BadRequestException(err instanceof Error ? err.message : String(err));
        }
        fields = parseAccountPayload(parsed.data, plaintext).map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          secret: f.secret,
        }));
      } else {
        const value = (input.value ?? '').trim();
        if (!value) throw new BadRequestException('Yeni lisans değeri (`value`) zorunludur.');
        if (row.key_format) {
          // İKİNCİ derleme noktası — import yoluyla AYNI kapıdan geçer (checkKeyFormatSafety).
          // Burası ayrıca bir TRANSACTION İÇİNDEDİR: katastrofik bir desen yalnız event
          // loop'unu değil, açık kalan tx'in kilitlerini de süresiz tutardı.
          const reason = checkKeyFormatSafety(row.key_format);
          if (reason) {
            throw new BadRequestException(
              `Ürünün anahtar biçimi (key_format) kullanılamıyor — ${reason} Ürünü düzenleyip deseni düzeltin.`,
            );
          }
          // Girdi tavanı: DTO zaten `.max(4_000)` uyguluyor, savunma derinliği için tekrar
          // (iç çağıranlar controller'ı atlayabilir — bu dosyanın genel deseni).
          if (value.length > KEY_FORMAT_MAX_INPUT_LENGTH) {
            throw new BadRequestException(
              `Yeni lisans değeri çok uzun (en fazla ${KEY_FORMAT_MAX_INPUT_LENGTH} karakter).`,
            );
          }
          const re = new RegExp(row.key_format);
          if (!re.test(value)) {
            throw new BadRequestException('Yeni değer ürünün anahtar biçimine (key_format) uymuyor.');
          }
        }
        plaintext = value;
      }

      const newHash = this.crypto.payloadHash(plaintext);
      // Dedupe: aynı payload başka bir kayıtta varsa reddet (UNIQUE ihlali 500 olmadan 409).
      const dupe = await rawRows<{ id: string }>(tx, sql`
        SELECT id FROM license_items WHERE payload_hash = ${newHash} AND id <> ${id} LIMIT 1;
      `);
      if (dupe.length > 0) {
        throw new ConflictException('Bu lisans değeri sistemde zaten kayıtlı (mükerrer).');
      }

      const changed = newHash !== row.payload_hash;
      const payloadEnc = this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id));
      // Hesap ürününde son-5 hash'i YAZILMAZ — import yolundaki gerekçenin aynısı (kanonik
      // JSON'un kuyruğu aranabilir bir şey değildir). İki yazma yolu aynı kuralı uygular.
      const suffixHash = row.kind === 'account' ? null : this.crypto.payloadSuffixHash(plaintext);
      const [updated] = await rawRows<{ id: string }>(tx, sql`
        UPDATE license_items
        SET payload_enc = ${payloadEnc},
            payload_hash = ${newHash},
            payload_suffix_hash = ${suffixHash}
        WHERE id = ${id} AND status = 'available'
        RETURNING id;
      `);
      if (!updated) throw new ConflictException(DELIVERED_MSG);

      // Audit: sebep + aktör. Düz metin (eski/yeni değer) meta'ya ASLA yazılmaz (§8).
      await tx.insert(auditLog).values({
        action: 'replace',
        actor,
        targetType: 'license_item',
        targetId: id,
        meta: { op: 'edit_payload', reason, kind: row.kind, changed, source: 'license_inventory' },
      });

      return {
        id,
        productId: row.product_id,
        status: 'available' as const,
        kind: (row.kind === 'account' ? 'account' : 'key') as 'key' | 'account',
        value: row.kind === 'account' ? null : plaintext,
        fields,
        changed,
      };
    });
  }

  /**
   * TESLİM EDİLMİŞ HESABIN kimlik bilgilerini YERİNDE günceller (§11, denetim boşluğu).
   *
   * NEDEN AYRI BİR UÇ: hesap ürününde sağlayıcı tarafında parola değişebilir (ya da operatör
   * güvenlik gereği döndürür). Panelde bugüne dek bunun DOĞRU aracı yoktu:
   *   · `updateLicenseItemPayload` teslim edilmiş kalemi 409'lar (DOĞRU — müşterinin gördüğü
   *     değerle DB'yi sessizce ayırmamalı),
   *   · "Değiştir" (replace) ise BAŞKA bir hesap atar; eski hesap müşterinin elinde ÇALIŞMAYA
   *     DEVAM eder (kimlik bilgilerini zaten kopyalamıştır) ve müşterinin o hesapta biriktirdiği
   *     veri kaybolur. Yani anahtar ürününde doğru olan çözüm hesap ürününde YANLIŞ.
   * Bu uç aradaki boşluğu kapatır: AYNI kalem, AYNI atama, YENİ kimlik bilgileri.
   *
   * KISITLAR (bilinçli, hepsi güvenlik/denetim gereği):
   *   · yalnız `kind='account'` — anahtar ürününde "değişen anahtar" farklı bir lisanstır, replace kullanılır,
   *   · yalnız CANLI ataması olan kalem — teslim edilmemişte zaten normal düzenleme yolu çalışır,
   *   · sebep ZORUNLU (denetim izine yazılır),
   *   · maskeli değer YASAK (aynı `looksMasked` kapısı — owner-olmayanın maskeli formu kaydetmesi
   *     lisansı sessizce imha ederdi),
   *   · mükerrer kontrolü korunur (aynı kimlik bilgisi iki kalemde olamaz).
   *
   * Müşteriye BİLDİRİM: bu servis mail göndermez; etkilenen sipariş id'lerini DÖNDÜRÜR ve
   * çağıran (admin UI) operatöre "teslimat mailini yeniden gönder" yolunu sunar. Böylece
   * bildirim kararı — ve mailin ne zaman gideceği — operatörde kalır (§15 "insan onaylar").
   */
  async rotateAccountCredentials(
    id: string,
    input: { fields: Record<string, string>; reason: string },
    actor: string,
  ) {
    const reason = (input.reason ?? '').trim();
    if (reason.length < 3) {
      throw new BadRequestException('Sebep zorunludur (en az 3 karakter).');
    }
    // Maskeli değer kapısı — `updateLicenseItemPayload` ile AYNI kural (tek yerde tanımlı olmalı
    // ki iki yazma yolu ayrışmasın; ayrışma bu projede tekrar eden bir hata sınıfıdır).
    if (Object.values(input.fields ?? {}).some((v) => typeof v === 'string' && looksMasked(v))) {
      throw new BadRequestException(
        'Maskeli değer kaydedilemez. Görüntüleme yetkiniz olmadığı için alanlar maskeli geldi; ' +
          'tam değerleri girin veya owner yetkisi isteyin.',
      );
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'license_item:' + id}))`);

      const [row] = await rawRows<{
        id: string;
        product_id: string;
        kind: string;
        payload_schema: unknown;
      }>(tx, sql`
        SELECT li.id, li.product_id, p.kind::text AS kind, p.payload_schema
        FROM license_items li
        JOIN products p ON p.id = li.product_id
        WHERE li.id = ${id} LIMIT 1 FOR UPDATE OF li;
      `);
      if (!row) throw new NotFoundException('Lisans bulunamadı.');
      if (row.kind !== 'account') {
        throw new BadRequestException(
          'Bu işlem yalnız hesap ürünlerinde geçerlidir. Anahtar ürününde değişen bir anahtar ' +
            'AYRI bir lisanstır — sipariş detayından "Değiştir" akışını kullanın.',
        );
      }

      // CANLI atama şartı: bu uç teslim edilmiş kalemi hedefler. Teslim edilmemiş kalemde
      // olağan düzenleme yolu (updateLicenseItemPayload) zaten çalışır ve daha az yetki ister.
      const live = await rawRows<{ n: number; order_ids: string[] }>(tx, sql`
        SELECT count(*)::int AS n,
               coalesce(array_agg(DISTINCT a.order_id) FILTER (WHERE a.order_id IS NOT NULL), '{}') AS order_ids
        FROM assignments a
        WHERE a.license_item_id = ${id} AND a.status IN ('active', 'suspended');
      `);
      const liveCount = Number(live[0]?.n ?? 0);
      if (liveCount === 0) {
        throw new ConflictException(
          'Bu lisansın canlı teslimatı yok — normal "Değiştir" (düzenleme) akışını kullanın.',
        );
      }

      const parsed = AccountPayloadSchema.safeParse(row.payload_schema);
      if (!parsed.success) {
        throw new BadRequestException(
          'Ürünün hesap alan şeması (payload_schema) geçersiz — güncelleme yapılamaz.',
        );
      }
      let plaintext: string;
      try {
        plaintext = serializeAccountPayload(parsed.data, input.fields);
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : String(err));
      }

      const newHash = this.crypto.payloadHash(plaintext);
      const dupe = await rawRows<{ id: string }>(tx, sql`
        SELECT id FROM license_items WHERE payload_hash = ${newHash} AND id <> ${id} LIMIT 1;
      `);
      if (dupe.length > 0) {
        throw new ConflictException('Bu kimlik bilgileri sistemde başka bir kayıtta zaten var.');
      }

      // AAD (`license_item:<id>`) KORUNUR → ciphertext satır-taşıma hâlâ imkânsız.
      // Hesap ürününde son-5 hash'i yazılmaz (bkz. import yolundaki gerekçe).
      const payloadEnc = this.crypto.encrypt(plaintext, CryptoService.licenseItemAad(id));
      await tx.execute(sql`
        UPDATE license_items
        SET payload_enc = ${payloadEnc}, payload_hash = ${newHash}, payload_suffix_hash = NULL
        WHERE id = ${id};
      `);

      const orderIds = (live[0]?.order_ids ?? []).filter(Boolean);
      // Sipariş zaman çizelgesinde GÖRÜNÜR iz: operatör "bu hesabın parolası ne zaman
      // değişti" sorusunu panelden yanıtlayabilsin (sır NOTA GİRMEZ, yalnız sebep).
      for (const orderId of orderIds) {
        await tx.insert(fulfillmentEvents).values({
          orderId,
          type: 'account_credentials_rotated',
          message: `Hesap kimlik bilgileri güncellendi — ${reason}`,
        });
      }
      await tx.insert(auditLog).values({
        action: 'adjust',
        actor,
        targetType: 'license_item',
        targetId: id,
        meta: {
          op: 'rotate_credentials',
          reason,
          liveAssignments: liveCount,
          source: 'license_inventory',
        },
      });

      return {
        id,
        productId: row.product_id,
        liveAssignments: liveCount,
        /** Çağıran bu siparişlerin teslimat mailini yeniden gönderebilir (karar operatörde). */
        orderIds,
        fields: parseAccountPayload(parsed.data, plaintext).map((f) => ({
          key: f.key,
          label: f.label,
          value: f.value,
          secret: f.secret,
        })),
      };
    });
  }
}

/**
 * Sayfa boyutunu izinli değerlere (10/25/50/100) kırpar — en yakın olana.
 *
 * VARSAYILAN AÇIKÇA YAZILIR (`DEFAULT_LICENSE_PAGE_SIZE`), listenin ilk elemanı DEĞİL:
 * öyleyken listeye başa 10 eklemek "pageSize göndermeyen" HER çağrının sayfa boyunu
 * sessizce 25 → 10'a düşürmüştü (entegrasyon testi yakaladı: 11 satırlık sıra testi
 * 10 satır aldı). Sıralı bir sabit listesinin sırası, davranışsal varsayılanı
 * belirlememeli. Admin tarafında aynı tuzak `license-actions.ts`'te de kapalıdır.
 */
export const DEFAULT_LICENSE_PAGE_SIZE = 25;
function clampPageSize(n?: number): number {
  if (n == null || !Number.isFinite(n)) return DEFAULT_LICENSE_PAGE_SIZE;
  return LICENSE_PAGE_SIZES.reduce<number>(
    (best, cur) => (Math.abs(cur - n) < Math.abs(best - n) ? cur : best),
    DEFAULT_LICENSE_PAGE_SIZE,
  );
}

/** ILIKE joker karakterlerini (\, %, _) kaçırır — ESCAPE '\' ile birlikte kullanılır. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Teslim alma tarihi doğrulaması: [2000-01-01, şimdi + 24 saat].
 *
 * Gelecek tarih reddi KRİTİK: maliyet raporu (`costs.byMonth`) doğrudan `batches.received_at`
 * ile ay kovası yapar ve tarihi düzeltecek bir uç YOKTUR → ileri tarihli tek giriş raporda
 * kalıcı "hayalet ay" satırı bırakır. Alt sınır ise yanlış yazılmış yıl (ör. 0205) içindir.
 */
function parseReceivedAt(raw?: string): Date {
  if (!raw) return new Date();
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException('Teslim alma tarihi okunamadı (ISO tarih bekleniyor).');
  }
  const min = Date.UTC(2000, 0, 1);
  const max = Date.now() + 24 * 60 * 60 * 1000;
  if (d.getTime() < min || d.getTime() > max) {
    throw new BadRequestException(
      'Teslim alma tarihi 1 Ocak 2000 ile bugünden en çok 24 saat sonrası arasında olmalı. ' +
        'Maliyet raporu ayları bu tarihe göre gruplanır; ileri/çok geri tarihli giriş ' +
        'raporda kalıcı hayalet satır bırakır.',
    );
  }
  return d;
}

/**
 * Para birimi normalizasyonu. Maliyet raporu `GROUP BY currency` yapıyor — 'try' ile 'TRY'
 * aynı raporu ikiye bölerdi. Boş/verilmemişse şema varsayılanı ('TRY') kullanılır.
 */
function normalizeCurrency(raw?: string): string {
  return (raw ?? '').trim().toUpperCase() || 'TRY';
}

/**
 * Otomatik oluşturulan satın alma emri/parti notu. Önek `AUTO_RECEIPT_NOTE_PREFIX`'tir:
 * panel bu öneke bakıp 'Otomatik' rozeti gösterir ve 'Teslim Al' eylemini gizler.
 */
function autoReceiptNote(label: string, operatorNote: string | null): string {
  const base = `${AUTO_RECEIPT_NOTE_PREFIX} Stok girişinden otomatik oluşturuldu (parti: ${label}).`;
  return operatorNote ? `${base} ${operatorNote}` : base;
}

// NOT: mağaza admin sipariş linki YEREL KOPYA DEĞİL — tek kaynak `orders/store-admin-url.ts`
// (bu dosyadaki eski kopya ile admin-orders'taki kopyanın davranışları farklıydı; origin artık
// yalnız şablon/domain'den türetilir, webhook_url'den ASLA — iç hostname riski).
