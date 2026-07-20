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
 * Import: yapılandırılmış hesap girdisini KANONİK JSON string'e çevirir (şemaya göre
 * doğrulayarak). Anahtarlar sıralı → aynı hesap her zaman aynı ciphertext-öncesi düz
 * metni üretir, böylece payload_hash dedupe'u anlamlı çalışır (§12).
 *
 * @throws zorunlu alan boşsa veya girdi obje değilse
 */
export function serializeAccountPayload(
  schema: AccountPayloadSchema,
  input: unknown,
): string {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Hesap payload girdisi bir nesne olmalı (alan → değer)');
  }
  const obj = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const f of schema) {
    const raw = obj[f.key];
    const val = raw == null ? '' : String(raw);
    if (f.required && val.trim() === '') {
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
    return [{ key: 'payload', label: 'Lisans', value: serialized, secret: false }];
  }
  return schema
    .filter((f) => obj[f.key] != null && String(obj[f.key]) !== '')
    .map((f) => ({ key: f.key, label: f.label, value: String(obj[f.key]), secret: f.secret }));
}

const MASK_TAIL = 4;
const MASK_BODY = '••••••';

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
