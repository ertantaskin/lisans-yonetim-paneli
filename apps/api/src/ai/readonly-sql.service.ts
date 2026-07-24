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

    // Sorguyu bir CTE'ye sarıp dışa LIMIT MAX_ROWS+1 uygula: belleğe en fazla MAX_ROWS+1
    // satır gelir (kırpma tespiti için +1). q "WITH ... SELECT" olsa bile iç-içe WITH geçerli;
    // sarma yalnız SELECT/WITH ile başlayan (yukarıda doğrulanmış) tek ifadeyi kabul eder.
    const capped = `WITH __capped AS (\n${q}\n) SELECT * FROM __capped LIMIT ${MAX_ROWS + 1}`;

    let rows: Record<string, unknown>[];
    let resultColumns: string[] = [];
    try {
      const raw = await this.sql.begin(async (tx) => {
        // SALT-OKUNUR + zaman sınırı: yazma imkânsız, uzun sorgu kesilir.
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe("SET LOCAL statement_timeout = '5s'");
        return tx.unsafe(capped);
      });
      // postgres.js RowList satır YOKken bile kolon meta verisi (.columns) taşır → dönen
      // gerçek kolon adlarını buradan alırız (metin eşleştirmeye bağlı kalmadan).
      const meta = (raw as { columns?: Array<{ name?: unknown }> }).columns;
      resultColumns = Array.isArray(meta)
        ? meta.map((c) => (typeof c?.name === 'string' ? c.name : '')).filter(Boolean)
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

    // Belleğe en fazla MAX_ROWS+1 satır geldi: +1 varsa gerçekten kırpıldı demektir.
    const truncated = rows.length > MAX_ROWS;
    const limited = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const rowCount = limited.length;
    const columns = limited.length > 0 ? Object.keys(limited[0]!) : [];
    return { columns, rows: limited, rowCount, truncated };
  }
}
