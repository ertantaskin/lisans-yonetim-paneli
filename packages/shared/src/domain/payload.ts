import { z } from 'zod';

/**
 * Hesap ürünü (kind=account) payload alan şeması (§11).
 *
 * products.payload_schema jsonb kolonunda saklanır. Hesap kimliğinin (ör. kullanıcı
 * adı + parola + 2FA yedek kodu) yapısını tanımlar. Bu şema; import doğrulaması,
 * teslimat alan render'ı ve alan-bazlı maskeleme için TEK doğruluk kaynağıdır.
 *
 * - key: makine adı (JSON anahtarı), sabit; harf/rakam/altçizgi
 * - label: müşteriye/admin'e gösterilen etiket
 * - secret: true ise admin görünümünde maskelenir (parola). Müşteri kendi teslimatında
 *   tam değeri görür (kendi lisansı); maske YALNIZ admin panel/meta box içindir.
 * - required: import'ta boş olamaz
 */
export const PayloadFieldDef = z.object({
  key: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/, 'key harf ile başlamalı; harf/rakam/altçizgi'),
  label: z.string().min(1).max(80),
  secret: z.boolean().default(false),
  required: z.boolean().default(true),
});
export type PayloadFieldDef = z.infer<typeof PayloadFieldDef>;

/** Hesap ürünü alan tanımları listesi (products.payload_schema). */
export const AccountPayloadSchema = z
  .array(PayloadFieldDef)
  .min(1)
  .max(20)
  .refine((fields) => new Set(fields.map((f) => f.key)).size === fields.length, {
    message: 'payloadSchema alan anahtarları benzersiz olmalı',
  });
export type AccountPayloadSchema = z.infer<typeof AccountPayloadSchema>;

/** Çözülmüş teslimat alanı (değer dâhil — müşteri/reveal bağlamı). */
export interface PayloadField {
  key: string;
  label: string;
  value: string;
  secret: boolean;
}

/**
 * Alan DEĞERİ normalizasyonu (GÜVENLİK KRİTİK — Excel/tarayıcı yapıştırma yolu).
 *
 * Elektronik tablodan veya web sayfasından kopyalanan değerler GÖRÜNMEZ karakter taşır:
 * sondaki boşluk, kırılmaz boşluk (NBSP), BOM, sıfır-genişlik birleştiriciler, otomatik
 * düzeltmenin ürettiği "akıllı" tırnaklar. İki ayrı hasar üretirler:
 *  1. Müşteriye YANLIŞ PAROLA teslim edilir (kopyalanan değer olduğu gibi giriş yapmaz).
 *  2. `payload_hash` farklılaşır → dedupe çalışmaz → aynı hesap İKİ müşteriye satılabilir (§12).
 *
 * Bu yüzden değer, `required` boşluk kontrolünden ÖNCE tek bir kanonik biçime indirgenir.
 * Saf fonksiyon: yan etkisi yok, aynı girdi → aynı çıktı (kanonik JSON/hash bunun üstüne kurulu).
 */
export function normalizeFieldValue(raw: unknown): string {
  if (raw == null) return '';
  return (
    String(raw)
      // Unicode birleştirme: aynı görünen iki dizi (ör. 'é' vs 'e' + birleşen aksan)
      // tek gösterime iner → hash stabil.
      .normalize('NFC')
      // Baştaki BOM (bazı dışa aktarımlar dosya/hücre başına ekler).
      .replace(/^\uFEFF+/, '')
      // Kırılmaz (NBSP) / figür / dar-kırılmaz boşluk → normal boşluk (gözle ayırt edilemez).
      .replace(/[\u00A0\u2007\u202F]/g, ' ')
      // Akıllı tırnaklar → düz tırnak (Office otomatik düzeltmesi parolayı bozar).
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      // Sıfır-genişlik karakterler: tamamen sil (görünmez, kopyala-yapıştırla bulaşır).
      .replace(/[\u200B\u200C\u200D]/g, '')
      .trim()
  );
}

/** Hata mesajında gösterilecek anahtar adını kısaltır (mesaj ASLA değer taşımaz). */
const MAX_KEY_IN_MESSAGE = 40;

/**
 * Import: yapılandırılmış hesap girdisini KANONİK JSON string'e çevirir (şemaya göre
 * doğrulayarak). Anahtarlar sıralı → aynı hesap her zaman aynı ciphertext-öncesi düz
 * metni üretir, böylece payload_hash dedupe'u anlamlı çalışır (§12).
 *
 * Değerler `normalizeFieldValue` ile temizlenir (görünmez karakter → yanlış parola + hash sapması).
 * Girdideki şemada OLMAYAN anahtarlar SESSİZCE ATILMAZ, hata verir: Excel başlığı 'Password'
 * iken şema 'password' ise eskiden parola alanı düşüyor ve PAROLASIZ hesap teslim ediliyordu.
 *
 * @throws girdi obje değilse · şemada olmayan anahtar varsa · zorunlu alan boşsa · hiç dolu alan yoksa
 */
export function serializeAccountPayload(
  schema: AccountPayloadSchema,
  input: unknown,
): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Hesap payload girdisi bir nesne olmalı (alan → değer)');
  }
  const obj = input as Record<string, unknown>;

  // Fazladan anahtar = büyük olasılıkla yazım/büyük-küçük harf uyuşmazlığı. Sessiz düşürmek
  // eksik payload teslim eder; bu yüzden ANAHTAR ADIYLA reddedilir (değer ASLA mesaja girmez).
  const known = new Set(schema.map((f) => f.key));
  const unknownKeys = Object.keys(obj).filter((k) => !known.has(k));
  if (unknownKeys.length > 0) {
    const shown = unknownKeys.slice(0, 5).map((k) => k.slice(0, MAX_KEY_IN_MESSAGE));
    const rest = unknownKeys.length - shown.length;
    throw new Error(
      `Şemada olmayan alan: ${shown.join(', ')}${rest > 0 ? ` (+${rest} daha)` : ''}`,
    );
  }

  const out: Record<string, string> = {};
  for (const f of schema) {
    const val = normalizeFieldValue(obj[f.key]);
    if (f.required && val === '') {
      throw new Error(`Zorunlu alan boş: ${f.key}`);
    }
    if (val !== '') out[f.key] = val;
  }
  // Hiç dolu alan yoksa (tüm alanlar opsiyonel + boş) reddet — aksi halde boş '{}'
  // saklanır ve müşteriye boş lisans teslim edilir.
  if (Object.keys(out).length === 0) {
    throw new Error('Hesap payload boş — en az bir dolu alan gerekli');
  }
  // Kanonik: anahtarları sırala → deterministik düz metin (dedupe için).
  const canon: Record<string, string> = {};
  for (const k of Object.keys(out).sort()) canon[k] = out[k]!;
  return JSON.stringify(canon);
}

/**
 * Teslimat/reveal: kanonik JSON string'i şema sırasına göre alan listesine çözer.
 * Bozuk/eski (JSON olmayan) düz metin gelirse tek alanlık geriye dönük görünüm döner.
 *
 * GÜVENLİK (denetim Y1) — fallback alanı `secret: TRUE` işaretlenir:
 * `maskAccountFields` YALNIZ `secret` alanları maskeler. Fallback eskiden `secret:false`
 * dönüyordu → maskeleme değere HİÇ DOKUNMUYORDU. Gerçek arıza yolu: operatör `kind='key'`
 * bir ürünü `account`'a çevirir (ürün formunda tip seçici serbest) → o üründeki TÜM eski
 * kayıtlar kanonik JSON olmadığı için bu dala düşer ve owner-OLMAYAN admin, mağaza
 * operatörü (WP meta box) ve arama sonuçları anahtarların TAMAMINI düz metin görürdü
 * (uyarı yok, reveal audit'i yok). Aynı anahtar `kind='key'` yolundan geçse `••••••V66T`
 * olurdu — yani maskeleme rejimi ürün tipine göre sessizce kayboluyordu.
 *
 * Fail-safe YÖN: içeriği ÇÖZEMEDİĞİMİZ bir payload'ı "gizli değil" saymak yanlış yöndür;
 * bilinmeyeni SIR kabul ederiz. Müşteri kendi teslimatını maskesiz görmeye devam eder
 * (maskeleme YALNIZ admin/mağaza yüzeylerinde uygulanır — bkz. PayloadFieldDef.secret).
 */
export function parseAccountPayload(
  schema: AccountPayloadSchema,
  serialized: string,
): PayloadField[] {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error();
    obj = parsed as Record<string, unknown>;
  } catch {
    return [{ key: 'payload', label: 'Lisans', value: serialized, secret: true }];
  }
  return schema
    .filter((f) => obj[f.key] != null && String(obj[f.key]) !== '')
    .map((f) => ({ key: f.key, label: f.label, value: String(obj[f.key]), secret: f.secret }));
}

const MASK_TAIL = 4;
const MASK_BODY = '••••••';

/**
 * Maske GÖVDESİ — sunucu tarafında "bu değer maskeden geldi" tespiti için dışa açıktır.
 *
 * NEDEN (denetim bulgusu Y3): owner OLMAYAN admin envanterde bir hesap kaydını düzenlemek
 * istediğinde form alanları MASKELİ değerlerle ön-doldurulur; yalnız kullanıcı adını düzeltip
 * kaydederse parola alanında `••••••` gider ve GERÇEK PAROLA yerine bu dize şifrelenir —
 * lisans sessizce yok edilir (eski ciphertext üzerine yazıldığı için kurtarma da yoktur).
 * `serializeAccountPayload` için `••••••` mükemmel geçerli bir doludur, o yüzden kapı
 * yazma yolunda açık olmalıdır.
 */
export const MASK_PREFIX = MASK_BODY;

/** Değer bir maskeden mi geliyor (gerçek sır değil)? */
export function looksMasked(value: string): boolean {
  return value.startsWith(MASK_BODY);
}

/**
 * KEY kimlik maskesi: sabit gövde + son 4 hane. key/code/custom'ın BÜTÜN payload'ında
 * kullanılır — son 4 hane iyi huylu bir tanımlayıcıdır (hangi key), sızıntı değil.
 * Uzunluk/segment yapısı sızmaz (§8).
 */
export function maskSecret(value: string): string {
  if (value.length <= MASK_TAIL) return MASK_BODY;
  return MASK_BODY + value.slice(-MASK_TAIL);
}

/**
 * Hesap alanlarını maskeler: secret alanlar KUYRUKSUZ tam maske (parola son 4 karakteri
 * hassastır — key'in aksine tanımlayıcı değil, gizli entropi; reveal audit'ini atlatmamalı).
 * secret olmayan alanlar (ör. kullanıcı adı) açık kalır.
 */
export function maskAccountFields(fields: PayloadField[]): PayloadField[] {
  return fields.map((f) => (f.secret ? { ...f, value: MASK_BODY } : f));
}
