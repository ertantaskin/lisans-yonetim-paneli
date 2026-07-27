import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '../db/db.module';

/** NL→SQL raporunun çalıştırma sonucu (§15). */
export interface SqlResult {
  /** Kolon adları (ilk satırın anahtarları). */
  columns: string[];
  /** En fazla MAX_ROWS satır. */
  rows: Record<string, unknown>[];
  /** Döndürülen satır sayısı (DB düzeyinde MAX_ROWS'a kırpılmış hâli). */
  rowCount: number;
  /** MAX_ROWS aşıldı mı (kırpıldı mı). */
  truncated: boolean;
}

/** Yanıta dönen en fazla satır — büyük sonuç UI'yı/tokenı boğmasın. */
const MAX_ROWS = 200;

/**
 * Bilinen SIR kolonları — AI'nın ürettiği SQL bunların adına DEĞİNEMEZ (§15 savunma-derinliği).
 * Salt-okunur transaction yalnız YAZMAYI engeller; bu EK katman şifreli/hash'li sır kolonlarının
 * OKUNMASINI da (prompt enjeksiyonu / model sapması olasılığına karşı, prompt-DIŞI savunma) reddeder.
 * Kelime-sınırıyla eşleşir → 'payload_encoding' gibi masum adları yanlışlıkla yakalamaz.
 */
const SECRET_COLUMN_DENYLIST = [
  'payload_enc',
  'payload_hash',
  // license_items keyed son-5 hash (payload_suffix_hash) — düz-metin son-5 sızıntısına karşı.
  'payload_suffix_hash',
  'hmac_secret_enc',
  'hmac_secret_prev_enc',
  'api_key_hash',
  // 0017 ile eklenen rekey-grace aynası; 'api_key_hash' regex'i \b sınırı nedeniyle bunu
  // YAKALAMAZ (hash ile _prev arasında word-char '_' var) → ayrıca listelenir.
  'api_key_hash_prev',
  // site_connect_tokens: şifreli kimlik (api_key_enc — hmac_secret_enc'in kardeşi) ve
  // bağlan-kodunun anahtarsız sha256'sı (code_hash) — ikisi de dönebilir, reddet.
  'api_key_enc',
  'code_hash',
  'password_hash',
  'scrypt',
] as const;
const SECRET_COLUMN_RE = new RegExp(`\\b(?:${SECRET_COLUMN_DENYLIST.join('|')})\\b`, 'i');
/** Dönen kolon adı denetimi için hızlı küme (küçük harf; tam-ad eşleşmesi). */
const SECRET_COLUMN_SET = new Set<string>(SECRET_COLUMN_DENYLIST);

/**
 * Satır/kayıt SARMA fonksiyonları — TÜM satırı (sır kolonları dahil: password_hash/code_hash/
 * api_key_hash/hmac_secret_enc/payload_enc…) sır-OLMAYAN bir takma ad altında tek JSON/hstore
 * değerinde döndürerek HEM metin denylist'ini HEM dönen-kolon süzgecini atlar
 * (`SELECT to_jsonb(t.*) AS rapor FROM admin_users t`). Bu ifadeleri metin düzeyinde reddet.
 * Kelime-sınırlı → 'to_json_config' gibi masum adları yanlışlıkla yakalamaz.
 */
const ROW_WRAP_DENYLIST = [
  'to_jsonb',
  'to_json',
  'row_to_json',
  'jsonb_agg',
  'json_agg',
  'jsonb_build_object',
  'json_build_object',
  'jsonb_object',
  'json_object',
  'hstore',
  'array_to_json',
  // Denetim: eksik serialize vektörleri — TÜM satırı sır-OLMAYAN tek değere sarıp süzgeçleri atlar.
  'array_agg',
  'string_agg',
  'xmlagg',
  'to_record',
  'table_to_xml',
  'query_to_xml',
  'schema_to_xml',
  'database_to_xml',
  'cursor_to_xml',
  'xmlelement',
  'xmlforest',
] as const;
const ROW_WRAP_RE = new RegExp(`\\b(?:${ROW_WRAP_DENYLIST.join('|')})\\b`, 'i');

/**
 * AUTH/kimlik tabloları — rapor akışının ASLA okumaya ihtiyacı yoktur ama scrypt parola hash'i
 * (admin_users) ve bağlan-kodu hash'i/şifreli kimliği (site_connect_tokens) taşırlar. Sorgu bu
 * tablo adlarından herhangi birine değinirse REDDEDİLİR → `SELECT t FROM admin_users t` (çıplak
 * kayıt), `admin_users::text` gibi kolon-adı-yazmayan TÜM sızıntı vektörleri tek noktada kapanır
 * (denylist genişletmesi her yeni PG fonksiyonuyla delinirdi; tablo-kapısı sağlam). İş raporları
 * orders/assignments/products/license_items… üzerinde çalışır; bu tablolara ihtiyaç duymaz.
 */
const TABLE_DENYLIST = ['admin_users', 'site_connect_tokens'] as const;
const TABLE_DENYLIST_RE = new RegExp(`\\b(?:${TABLE_DENYLIST.join('|')})\\b`, 'i');

/**
 * Skaler-OLMAYAN builtin dönüş tip OID'leri — bir kolon bu tiplerden döndüyse TÜM satırı tek değere
 * sarmış olabilir (to_jsonb→jsonb, *_to_xml→xml, çıplak record). Enum'lar (typtype='e') builtin
 * DEĞİL (OID ≥ 16384) → burada YOK, yanlış-pozitif üretmez; composite (typtype='c') pg_type ile ayrı denetlenir.
 */
const NONSCALAR_TYPE_OIDS = new Set<number>([
  114, // json
  199, // json[]
  3802, // jsonb
  3807, // jsonb[]
  142, // xml
  143, // xml[]
  2249, // record (anonim composite)
  2287, // record[]
]);
/**
 * Wildcard sütun seçimi — nitelikli `alias.*` (örn. `t.*`, `admin_users.*`) VEYA çıplak `SELECT *`
 * tüm kolonları (sır dahil) seçer. `count(*)`/`sum(*)` gibi toplama yıldızını YAKALAMAZ:
 *   - nitelikli dal `\w+\s*\.\s*\*` nokta ister (count(* içinde nokta yok),
 *   - çıplak dal yıldızın SELECT'ten hemen sonra (opsiyonel DISTINCT) gelmesini ister.
 */
const WILDCARD_RE = /\b\w+\s*\.\s*\*|\bselect\s+(?:distinct\s+)?\*/i;

/**
 * ReadonlySqlService — doğal dilde rapor (§15 "salt-okunur DB rolü, üretilen SQL gösterilir")
 * için AI'nın ürettiği sorguyu GÜVENLE çalıştırır. Katmanlı güvence:
 *   1) Tek ifade (noktalı virgülle ifade zincirleme reddedilir).
 *   2) Yalnız SELECT/WITH ile başlar.
 *   3) SALT-OKUNUR transaction (SET TRANSACTION READ ONLY) → her INSERT/UPDATE/DELETE/DDL,
 *      hatta yazan volatile fonksiyon çağrısı transaction düzeyinde REDDEDİLİR. Asıl güvence budur.
 *   4) statement_timeout=5s → pg_sleep vb. ile DoS önlenir.
 *   5) Sorgu bir CTE'ye sarılıp DB düzeyinde LIMIT MAX_ROWS+1 uygulanır → devasa sonuç
 *      kümesi belleğe HİÇ çekilmez (heap OOM/DoS önlenir), yalnız kırpma tespiti için +1.
 * AdminGuard arkasındadır (yönetici zaten tam erişimli); payload_enc kolonları şifreli durur.
 */
@Injectable()
export class ReadonlySqlService {
  constructor(@Inject(PG_CLIENT) private readonly sql: Sql) {}

  /** AI'nın ürettiği tek SELECT/WITH sorgusunu salt-okunur işlemde çalıştırır. */
  async runSelect(query: string): Promise<SqlResult> {
    const q = query.trim().replace(/;\s*$/, ''); // sondaki ; hoş görülür, atılır
    if (q.length === 0) throw new HttpException('Boş sorgu.', HttpStatus.BAD_REQUEST);
    if (q.includes(';')) {
      throw new HttpException('Yalnız tek SQL ifadesi çalıştırılabilir.', HttpStatus.BAD_REQUEST);
    }
    if (!/^\s*(select|with)\b/i.test(q)) {
      throw new HttpException('Yalnız SELECT/WITH sorgusuna izin verilir.', HttpStatus.BAD_REQUEST);
    }
    // Sır-kolon denylist (savunma-derinliği): sorgu metni bilinen sır kolonlarına değinemez.
    if (SECRET_COLUMN_RE.test(q)) {
      throw new HttpException('Sorgu sır kolonlarına erişemez.', HttpStatus.BAD_REQUEST);
    }
    // Satır/JSON-sarma bypass'i (savunma-derinliği): to_jsonb(t.*)/row_to_json(s)/jsonb_agg(a) gibi
    // ifadeler TÜM satırı (sır kolonları dahil) sır-OLMAYAN bir takma ad altında tek JSON değerinde
    // döndürerek HEM metin denylist'ini HEM dönen-kolon süzgecini atlar. Aynı şekilde `alias.*` /
    // çıplak `SELECT *` tüm kolonları seçer. İkisini de metin düzeyinde reddet (count(*) etkilenmez).
    if (ROW_WRAP_RE.test(q) || WILDCARD_RE.test(q)) {
      throw new HttpException(
        'Satır/JSON-sarma ifadeleri güvenlik için reddedilir.',
        HttpStatus.BAD_REQUEST,
      );
    }
    // AUTH/kimlik tablosu kapısı: rapor bu tablolara (scrypt hash / bağlan-kodu) ASLA erişmemeli →
    // adları geçen sorgu reddedilir (çıplak-record/::text dahil TÜM sızıntı vektörlerini kapatır).
    if (TABLE_DENYLIST_RE.test(q)) {
      throw new HttpException(
        'Sorgu kimlik/auth tablolarına erişemez.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Sorguyu bir CTE'ye sarıp dışa LIMIT MAX_ROWS+1 uygula: belleğe en fazla MAX_ROWS+1
    // satır gelir (kırpma tespiti için +1). q "WITH ... SELECT" olsa bile iç-içe WITH geçerli;
    // sarma yalnız SELECT/WITH ile başlayan (yukarıda doğrulanmış) tek ifadeyi kabul eder.
    const capped = `WITH __capped AS (\n${q}\n) SELECT * FROM __capped LIMIT ${MAX_ROWS + 1}`;

    let rows: Record<string, unknown>[];
    let resultColumns: string[] = [];
    let typeOids: number[] = [];
    try {
      const raw = await this.sql.begin(async (tx) => {
        // SALT-OKUNUR + zaman sınırı: yazma imkânsız, uzun sorgu kesilir.
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe("SET LOCAL statement_timeout = '5s'");
        return tx.unsafe(capped);
      });
      // postgres.js RowList satır YOKken bile kolon meta verisi (.columns) taşır → dönen
      // gerçek kolon adlarını VE tip OID'lerini buradan alırız (metin eşleştirmeye bağlı kalmadan).
      const meta = (raw as { columns?: Array<{ name?: unknown; type?: unknown }> }).columns;
      resultColumns = Array.isArray(meta)
        ? meta.map((c) => (typeof c?.name === 'string' ? c.name : '')).filter(Boolean)
        : [];
      typeOids = Array.isArray(meta)
        ? meta.map((c) => Number(c?.type)).filter((n) => Number.isFinite(n))
        : [];
      rows = raw as unknown as Record<string, unknown>[];
    } catch (err) {
      // Yazma denemesi / sözdizimi / timeout → 400 (kullanıcıya SQL hatası gösterilir).
      throw new HttpException(`Sorgu çalıştırılamadı: ${(err as Error).message}`, HttpStatus.BAD_REQUEST);
    }

    // Dönen kolon adı denetimi (savunma-derinliği): metin denylist'i `SELECT *` ile atlanabilir
    // (sorgu metninde 'password_hash' geçmeden admin_users.* sır kolonu döner). DÖNEN kolon adlarını
    // denylist'e karşı süz → SELECT * bypass'ı 0 satırda bile kapanır. AdminGuard + at-rest şifreleme
    // düz-metin sızmayı zaten önler; bu, kontrolün taahhüdünü delinmeye karşı sağlamlaştırır.
    const leaked = resultColumns.find((c) => SECRET_COLUMN_SET.has(c.toLowerCase()));
    if (leaked) {
      throw new HttpException('Sorgu sır kolonlarına erişemez.', HttpStatus.BAD_REQUEST);
    }

    // Dönen TİP denetimi (denetim, sağlam katman): çıplak-record / JSON / XML dönen kolon TÜM satırı
    // (sır kolonları dahil) tek değere sarabilir. (1) skaler-olmayan builtin tipleri (json/jsonb/xml/
    // record) doğrudan reddet; (2) kullanıcı-tanımlı OID (≥16384) varsa pg_type ile composite (typtype
    // 'c') / pseudo ('p') olanı reddet — enum (typtype 'e') MEŞRU, geçer (status/kind kolonları çalışır).
    if (typeOids.some((oid) => NONSCALAR_TYPE_OIDS.has(oid))) {
      throw new HttpException(
        'Satır/kayıt tipli sonuç sütunu güvenlik için reddedilir.',
        HttpStatus.BAD_REQUEST,
      );
    }
    const userOids = [...new Set(typeOids.filter((oid) => oid >= 16384))];
    if (userOids.length > 0) {
      const kinds = (await this.sql`
        SELECT typtype FROM pg_type WHERE oid = ANY(${userOids}::oid[])
      `) as unknown as Array<{ typtype?: string }>;
      if (kinds.some((k) => k.typtype === 'c' || k.typtype === 'p')) {
        throw new HttpException(
          'Satır/kayıt tipli sonuç sütunu güvenlik için reddedilir.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    // Belleğe en fazla MAX_ROWS+1 satır geldi: +1 varsa gerçekten kırpıldı demektir.
    const truncated = rows.length > MAX_ROWS;
    const limited = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const rowCount = limited.length;
    const columns = limited.length > 0 ? Object.keys(limited[0]!) : [];
    return { columns, rows: limited, rowCount, truncated };
  }
}
