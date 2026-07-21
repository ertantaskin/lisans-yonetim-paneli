import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Sql } from 'postgres';
import { PG_CLIENT } from '../db/db.module';

/** NL→SQL raporunun çalıştırma sonucu (§15). */
export interface SqlResult {
  /** Kolon adları (ilk satırın anahtarları). */
  columns: string[];
  /** En fazla MAX_ROWS satır. */
  rows: Record<string, unknown>[];
  /** Toplam üretilen satır sayısı (kırpma öncesi). */
  rowCount: number;
  /** MAX_ROWS aşıldı mı (kırpıldı mı). */
  truncated: boolean;
}

/** Yanıta dönen en fazla satır — büyük sonuç UI'yı/tokenı boğmasın. */
const MAX_ROWS = 200;

/**
 * ReadonlySqlService — doğal dilde rapor (§15 "salt-okunur DB rolü, üretilen SQL gösterilir")
 * için AI'nın ürettiği sorguyu GÜVENLE çalıştırır. Katmanlı güvence:
 *   1) Tek ifade (noktalı virgülle ifade zincirleme reddedilir).
 *   2) Yalnız SELECT/WITH ile başlar.
 *   3) SALT-OKUNUR transaction (SET TRANSACTION READ ONLY) → her INSERT/UPDATE/DELETE/DDL,
 *      hatta yazan volatile fonksiyon çağrısı transaction düzeyinde REDDEDİLİR. Asıl güvence budur.
 *   4) statement_timeout=5s → pg_sleep vb. ile DoS önlenir.
 *   5) Sonuç MAX_ROWS'a kırpılır.
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

    let rows: Record<string, unknown>[];
    try {
      rows = (await this.sql.begin(async (tx) => {
        // SALT-OKUNUR + zaman sınırı: yazma imkânsız, uzun sorgu kesilir.
        await tx.unsafe('SET TRANSACTION READ ONLY');
        await tx.unsafe("SET LOCAL statement_timeout = '5s'");
        return tx.unsafe(q);
      })) as unknown as Record<string, unknown>[];
    } catch (err) {
      // Yazma denemesi / sözdizimi / timeout → 400 (kullanıcıya SQL hatası gösterilir).
      throw new HttpException(`Sorgu çalıştırılamadı: ${(err as Error).message}`, HttpStatus.BAD_REQUEST);
    }

    const rowCount = rows.length;
    const truncated = rowCount > MAX_ROWS;
    const limited = truncated ? rows.slice(0, MAX_ROWS) : rows;
    const columns = limited.length > 0 ? Object.keys(limited[0]!) : [];
    return { columns, rows: limited, rowCount, truncated };
  }
}
