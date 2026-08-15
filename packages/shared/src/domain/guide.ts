/**
 * Kurulum / etkinleştirme rehberi (§7) — ürüne bağlı, müşteriye giden TALİMAT metni.
 *
 * Lisans anahtarını teslim etmek yetmiyor: müşteri "Office 365'e nasıl giriş yaparım",
 * "Windows 11 anahtarını nereye girerim" sorularının cevabını da almalı. Bu metin ÜRÜNE
 * göre operatör tarafından panelden yazılır ve ÜÇ yüzeyde birden görünür:
 *
 *   1. mağaza sipariş sayfası (WP eklentisi, HTML),
 *   2. teslimat e-postası (DÜZ METİN),
 *   3. müşterinin indirdiği .txt dosyası (düz metin).
 *
 * NEDEN RENDER BURADA (paylaşılan pakette): aynı metnin üç yüzeyde farklı görünmesi bu
 * projede tekrar eden bir hata sınıfı (mail ürün adını gösterirken müşteri sayfasının
 * göstermemesi gibi). Panel HTML'i TEK YERDE üretir; WP onu yalnız basar (ve kendi
 * `wp_kses` allow-list'iyle ikinci kez süzer — savunma derinliği). PHP'de ikinci bir
 * ayrıştırıcı YAZILMAZ: iki uygulama er geç ayrışır.
 *
 * BİÇİM: markdown DEĞİL, onun küçük ve GÜVENLİ bir alt kümesi. Ham HTML kabul edilmez;
 * her şey önce kaçırılır (escape), sonra yalnız tanınan kalıplar etikete çevrilir.
 * Böylece rehber metni müşterinin tarayıcısında script çalıştıramaz — içeriği yazan
 * kişi panel yöneticisi olsa bile (owner olmayan admin de yazabilir; §8 rol ayrımı).
 */

/** Rehber başlığı üst sınırı — ürün formundaki açılır listede tek satıra sığmalı. */
export const GUIDE_TITLE_MAX = 120;

/**
 * Rehber gövdesi üst sınırı: **4.000 karakter**.
 *
 * SAYININ GEREKÇESİ (uydurma değil — e-posta istemcisinin kırpma eşiğinden geriye doğru):
 *  - Gmail bir e-postayı **102 KB**'ı aşınca KIRPAR ("View entire message" arkasına atar);
 *    kırpılan yer çoğu zaman mesajın SONUDUR — yani tam da rehberin bulunduğu yer.
 *  - Türkçe metinde ş/ğ/ı/İ UTF-8'de 2 bayt → 4.000 karakter en kötü ihtimalle ~7 KB.
 *  - Teslimat şablonu + anahtar listesi ~2-6 KB tutar.
 *  - quoted-printable kodlaması gövdeyi ~1,3 kat şişirir.
 *  → 3 rehberli bir siparişte en kötü toplam ~30 KB; Gmail eşiğinin çok altında.
 *
 * 4.000 karakter pratikte ~600 kelimelik, ekran görüntüsüz bir kurulum anlatısıdır
 * (bu dosyanın yazıldığı sıradaki gerçek Office 365 rehberi 1.100 karakterdir).
 */
export const GUIDE_BODY_MAX = 4000;

/**
 * Tek e-postaya konulacak EN FAZLA rehber sayısı (çok ürünlü siparişte).
 *
 * Aynı rehber birden çok kaleme bağlıysa TEK kez sayılır (dedupe) → bu sınıra ancak
 * gerçekten farklı 4+ ürün grubu olan siparişlerde ulaşılır. Sınır aşılırsa metin
 * SESSİZCE kırpılmaz: müşteriye kalanları sipariş sayfasında bulacağı söylenir.
 */
export const GUIDE_MAIL_MAX_GUIDES = 3;

/**
 * E-postaya konulacak rehber metinlerinin TOPLAM karakter tavanı (güvenlik ağı).
 *
 * `GUIDE_MAIL_MAX_GUIDES` adet sınırıdır; bu ise BOYUT sınırı. Üç rehberin üçü de
 * 4.000 karakter olursa 12.000 karakter (~21 KB) → hâlâ Gmail eşiğinin altında.
 */
export const GUIDE_MAIL_TOTAL_MAX = 12000;

/** Ürüne bağlı rehber — teslimat yüzeylerine bu şekilde taşınır. */
export interface ProductGuide {
  id: string;
  title: string;
  /** Operatörün yazdığı ham metin (mini-biçimleme kalıplarıyla birlikte). */
  body: string;
}

/** Teslimat yanıtında taşınan, ÖNCEDEN render edilmiş rehber. */
export interface RenderedGuide {
  id: string;
  title: string;
  /** Güvenli HTML (yalnız izin verilen etiketler; ham girdi kaçırılmıştır). */
  html: string;
  /** Düz metin karşılığı (e-posta / .txt). */
  text: string;
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c);
}

/**
 * Satır içi biçimleme — SIRA ÖNEMLİ: önce kaçır, sonra kalıpları etikete çevir.
 *
 * Ters sırada yapılsaydı (`**` önce, escape sonra) üretilen `<strong>` etiketi de
 * kaçırılır ve müşteri ekranda `&lt;strong&gt;` görürdü; daha kötüsü, metne ham HTML
 * yazan biri onu gerçekten çalıştırabilirdi.
 */
function renderInline(text: string): string {
  let out = escapeHtml(text);

  // **kalın** → <strong>. Tek satırda, en kısa eşleşme (açgözlü değil).
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  /*
   * Bağlantılar: YALNIZ açık şemalı http/https adresleri. "office.com" gibi şemasız
   * yazımlar TAHMİN EDİLMEZ — tahmin, cümle içindeki noktalı kısaltmaları da bağlantıya
   * çevirip metni bozuyor. Adres zaten escape edilmiş durumdadır; `&amp;` içeren bir
   * sorgu dizesi href içinde DOĞRU biçimdir (tarayıcı `&` olarak çözer).
   *
   * Sondaki noktalama (nokta, virgül, parantez) adresten AYRILIR: "…office.com adresinden"
   * yerine "…office.com." yazıldığında noktanın bağlantıya girmesi 404 üretir.
   */
  out = out.replace(/https?:\/\/[^\s<]+/g, (url) => {
    const trimmed = url.replace(/[.,;:!?)\]]+$/, '');
    const tail = url.slice(trimmed.length);
    // rel: nofollow (SEO) + noopener/noreferrer (target=_blank güvenlik gereği).
    return `<a href="${trimmed}" target="_blank" rel="noopener noreferrer nofollow">${trimmed}</a>${tail}`;
  });

  return out;
}

const ORDERED_RE = /^\s*(\d+)[.)]\s+(.*)$/;
const BULLET_RE = /^\s*[-*•]\s+(.*)$/;
const HEADING_RE = /^\s*#{1,3}\s+(.*)$/;

/** CRLF/CR → LF, satır sonu boşlukları temizlenir, 3+ boş satır 2'ye indirilir. */
function normalizeLines(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Rehber gövdesini GÜVENLİ HTML'e çevirir (mağaza sipariş sayfası + panel önizlemesi).
 *
 * Desteklenen kalıplar (markdown'ın küçük alt kümesi):
 *   `# / ## / ###`  → başlık        `1. ` / `1) `  → sıralı adım listesi
 *   `- ` / `* `     → madde listesi  `**kalın**`    → vurgu
 *   boş satır       → yeni blok      http(s)://…    → bağlantı
 *
 * Üretilen etiket kümesi BİLEREK dardır (h4/p/ol/ul/li/strong/a/br) — WP tarafındaki
 * `wp_kses` allow-list'i ile birebir aynı olmalıdır; buraya yeni bir etiket eklenirse
 * eklentideki liste de güncellenmeli, yoksa etiket sessizce silinir.
 */
export function renderGuideHtml(body: string): string {
  const normalized = normalizeLines(body);
  if (!normalized) return '';

  const blocks = normalized.split(/\n{2,}/);
  const out: string[] = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    const headingMatch = lines.length === 1 ? HEADING_RE.exec(lines[0]!) : null;
    if (headingMatch) {
      // h4: rehber, sayfada zaten bir <h2> altında yaşıyor — belge başlık hiyerarşisini
      // bozmamak için en üst rehber başlığı h4'tür (a11y: başlık seviyesi atlanmaz).
      out.push(`<h4>${renderInline(headingMatch[1]!)}</h4>`);
      continue;
    }

    if (lines.every((l) => ORDERED_RE.test(l))) {
      const parsed = lines.map((l) => ORDERED_RE.exec(l)!);
      const items = parsed.map((m) => `<li>${renderInline(m[2]!)}</li>`);
      /*
       * NUMARA OPERATÖRÜN YAZDIĞI GİBİ KALIR (`start`).
       *
       * Adımlar arasına BOŞ SATIR koymak çok doğal bir yazım biçimi ("1. …⏎⏎2. …") ama her
       * boş satır yeni bir blok açar → her adım kendi <ol>'u olur ve HTML numarayı 1'den
       * YENİDEN BAŞLATIR: müşteri ekranda "1. 1. 1." görürdü (düz metin sürümü doğruyken —
       * iki yüzey sessizce ayrışırdı). `start` ile yazılan numara korunur; 1'de öznitelik
       * basılmaz (gereksiz gürültü). DİKKAT: WP eklentisindeki `wp_kses` allow-list'i
       * `ol` için `start`'a izin VERMELİ, yoksa öznitelik sessizce silinir.
       */
      const first = Number(parsed[0]![1]);
      const startAttr = Number.isFinite(first) && first !== 1 ? ` start="${first}"` : '';
      out.push(`<ol${startAttr}>${items.join('')}</ol>`);
      continue;
    }

    if (lines.every((l) => BULLET_RE.test(l))) {
      const items = lines.map((l) => `<li>${renderInline(BULLET_RE.exec(l)![1]!)}</li>`);
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Düz paragraf: blok içindeki satır sonları KORUNUR (<br>). Operatör metni satır
    // satır yazdıysa ekranda da öyle görünmeli (adım anlatımlarının yarısı böyle yazılıyor).
    out.push(`<p>${lines.map((l) => renderInline(l.trim())).join('<br>')}</p>`);
  }

  return out.join('');
}

/**
 * Rehber gövdesinin DÜZ METİN karşılığı (e-posta + .txt).
 *
 * Biçimleme İŞARETLERİ temizlenir (`**`, `#`), YAPI korunur: numaralı adımlar ve maddeler
 * olduğu gibi kalır — düz metin e-postada zaten en okunur hâl budur. Bağlantılar açık
 * yazıldığı için ayrıca işlenmez.
 */
export function renderGuideText(body: string): string {
  const normalized = normalizeLines(body);
  if (!normalized) return '';
  return normalized
    .split('\n')
    .map((line) => {
      const heading = HEADING_RE.exec(line);
      const base = heading ? heading[1]! : line;
      return base.replace(/\*\*(.+?)\*\*/g, '$1');
    })
    .join('\n');
}

/** Ham gövdeyi render edilmiş (html + text) hâle getirir. */
export function renderGuide(guide: ProductGuide): RenderedGuide {
  return {
    id: guide.id,
    title: guide.title,
    html: renderGuideHtml(guide.body),
    text: renderGuideText(guide.body),
  };
}

/** `buildGuideMailBlock` sonucu — kırpma DÜRÜSTÇE raporlanır (sessiz kayıp yok). */
export interface GuideMailBlock {
  /** Şablona `{{guides}}` olarak beslenecek düz metin (rehber yoksa boş string). */
  text: string;
  /** E-postaya gerçekten konulan rehber sayısı. */
  included: number;
  /** Sığmadığı için konulamayan rehber sayısı (0 ise kırpma olmamıştır). */
  omitted: number;
}

/**
 * Teslimat e-postasının rehber bloğunu üretir (adet + boyut tavanlarıyla).
 *
 * KIRPMA GÖRÜNÜRDÜR: sınıra takılan rehberler sessizce düşürülmez, müşteriye kalanları
 * nerede bulacağı yazılır. (Bu panelde "sessiz kırpma" defalarca yanlış karara yol açtı:
 * operatör listeyi tam sanıp eksik veriyle iş yaptı.)
 *
 * @param guides Siparişteki ürünlerin rehberleri — çağıran TEKRARLARI AYIKLAMIŞ olmalıdır
 *               (aynı rehber birden çok kaleme bağlıysa bir kez gelir).
 */
export function buildGuideMailBlock(guides: ProductGuide[]): GuideMailBlock {
  if (guides.length === 0) return { text: '', included: 0, omitted: 0 };

  const parts: string[] = [];
  let total = 0;
  let included = 0;

  for (const guide of guides) {
    if (included >= GUIDE_MAIL_MAX_GUIDES) break;
    const text = renderGuideText(guide.body);
    if (!text) continue;
    // Boyut tavanı: ilk rehber tek başına tavanı aşsa bile EN AZ BİRİ konur (aksi halde
    // uzun tek rehberli üründe e-posta rehbersiz giderdi — sınırın amacı bu değil).
    if (included > 0 && total + text.length > GUIDE_MAIL_TOTAL_MAX) break;
    parts.push(`── ${guide.title} ──\n${text}`);
    total += text.length;
    included += 1;
  }

  const omitted = guides.length - included;
  if (omitted > 0) {
    parts.push(
      `(${omitted} ürünün kurulum rehberi bu e-postaya sığmadı — hepsini sipariş sayfanızdan görebilirsiniz.)`,
    );
  }

  return { text: parts.join('\n\n'), included, omitted };
}
