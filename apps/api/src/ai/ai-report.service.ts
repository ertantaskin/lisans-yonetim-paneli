import { Injectable, Logger } from '@nestjs/common';
import { AiService } from './ai.service';
import { ReadonlySqlService, type SqlResult } from './readonly-sql.service';

/** NL→SQL raporu başarıyla çalıştı — üretilen SQL + sonuç. */
export interface AiReportSuccess {
  /** AI'nın ürettiği (çite soyulmuş) SELECT — HER ZAMAN gösterilir (§15). */
  sql: string;
  ok: true;
  result: SqlResult;
}

/** NL→SQL raporu çalıştırılamadı — SQL yine gösterilir, hata mesajıyla (§15). */
export interface AiReportFailure {
  sql: string;
  ok: false;
  /** Salt-okunur çalıştırıcının hata mesajı (yazma denemesi / sözdizimi / timeout). */
  error: string;
}

export type AiReportResult = AiReportSuccess | AiReportFailure;

/**
 * Özet şema — sistem prompt'una gömülür (gerçek snake_case kolon adlarıyla). AI yalnız
 * bu tabloları/kolonları bilerek doğru SELECT üretir. ŞİFRELİ/SIR kolonlar (payload_enc,
 * hmac_secret_enc, api_key_hash) sorguya dahil EDİLMEZ — anlamlı veri döndürmez ve §15
 * "lisans payload/sır modele gönderilmez" ilkesini korur.
 */
const SCHEMA_SUMMARY = `
orders(id, site_id, remote_order_id, customer_email, status['unmapped'|'pending'|'partial'|'fulfilled'|'revoked'], idempotency_key, created_at, updated_at)
order_lines(id, order_id, product_id, remote_line_id, qty, fulfilled_qty, status['pending'|'partial'|'fulfilled'], policy_override, priority, created_at)
assignments(id, order_id, line_id, license_item_id, units, valid_until, status['active'|'suspended'|'replaced'|'revoked'|'expired'], delivered_at, created_at)
assignment_history(id, assignment_id, old_license_item_id, new_license_item_id, reason, actor, created_at)
products(id, sku, name, kind['key'|'account'|'custom'|'code'], usage_mode['single'|'multi'], max_uses, validity_days, on_expiry['hide'|'keep'], stockless, release_at, fulfillment_policy, warranty_days, low_stock_threshold, created_at, updated_at)
license_items(id, product_id, batch_id, expires_at, max_uses, use_count, status['available'|'assigned'|'suspended'|'replaced'|'revoked'|'quarantined'|'depleted'|'expired'|'voided'], assigned_at, created_at) -- NOT: payload_enc/payload_hash ŞİFRELİ, SELECT ETME
sites(id, type['woocommerce'|'marketplace'|'reseller'], domain, sender_email, sender_domain_verified, webhook_url, sales_daily_quota, sandbox, status, created_at, updated_at) -- NOT: hmac_secret_enc/api_key_hash SIR, SELECT ETME
replacement_requests(id, site_id, order_id, line_id, assignment_id, customer_email, reason, status['open'|'info_requested'|'approved'|'rejected'], within_warranty, resolution_note, new_assignment_id, resolved_by, resolved_at, created_at, updated_at)
customers(id, email, tags[text[]], notes, created_at, updated_at)
security_events(id, type, severity['info'|'warning'|'critical'], site_id, subject, detail, meta[jsonb], created_at)
`.trim();

/** Sistem talimatı — AI yalnız TEK salt-okunur SELECT üretsin, açıklama yazmasın. */
const SYSTEM_PROMPT = `Sen bir PostgreSQL rapor asistanısın. Aşağıdaki şemaya göre kullanıcının Türkçe sorusunu yanıtlayacak SORGUYU üret.

Şema (snake_case gerçek kolon adları):
${SCHEMA_SUMMARY}

KURALLAR:
- Yalnız TEK bir salt-okunur PostgreSQL SELECT (veya WITH ... SELECT) sorgusu üret.
- Asla INSERT/UPDATE/DELETE/DDL veya herhangi bir yazma işlemi üretme.
- Açıklama, yorum, gerekçe YAZMA; SADECE SQL döndür (markdown çiti isteğe bağlı).
- En fazla 200 satır döndür (uygun bir LIMIT 200 ekle).
- Yalnız yukarıdaki tablo/kolonları kullan; ŞİFRELİ/SIR kolonları (payload_enc, hmac_secret_enc, api_key_hash) ASLA seçme.
- Tek ifade üret; birden çok ifadeyi noktalı virgülle zincirleme.`;

/**
 * AiReportService — doğal dilde rapor / NL→SQL (§15 "salt-okunur DB rolü, üretilen SQL
 * gösterilir"). Kullanıcı TÜRKÇE soru sorar; AI salt-okunur bir SELECT üretir;
 * ReadonlySqlService güvenle çalıştırır; SQL + sonuç döner.
 *
 * İlke (§15): AI ÖNERİR, insan denetler. Bu servis DB'ye YAZMAZ, mail göndermez — yalnız
 * salt-okunur sorgu üretir/çalıştırır. Üretilen SQL HER ZAMAN gösterilir (hata olsa bile).
 * AI kapalıysa ai.complete AiUnavailableException (503) fırlatır → UI yakalar.
 */
@Injectable()
export class AiReportService {
  private readonly logger = new Logger(AiReportService.name);

  constructor(
    private readonly ai: AiService,
    private readonly readonly: ReadonlySqlService,
  ) {}

  /**
   * Türkçe soruyu SELECT'e çevirir, salt-okunur çalıştırır. runSelect hata fırlatırsa
   * YAKALANIR ve SQL yine döndürülür ({ ok:false }) — §15 "üretilen SQL gösterilir".
   */
  async report(question: string): Promise<AiReportResult> {
    // AI kapalıysa burada 503 fırlar (çağıran/UI yakalar).
    const raw = await this.ai.complete({
      system: SYSTEM_PROMPT,
      user: question,
      maxTokens: 1024,
    });
    const sql = this.stripSqlFence(raw);

    try {
      const result = await this.readonly.runSelect(sql);
      return { sql, ok: true, result };
    } catch (err) {
      // Yazma denemesi / sözdizimi / timeout — SQL yine gösterilsin diye yutup döndürüyoruz.
      const error = (err as Error).message;
      this.logger.warn(`NL→SQL çalıştırılamadı: ${error}`);
      return { sql, ok: false, error };
    }
  }

  /**
   * Modelin ```sql ... ``` çitini / sarmalayan açıklamayı soyar. Çit varsa içeriği alınır;
   * yoksa ham metin trimlenir. Sondaki ; runSelect'te zaten hoş görülür.
   */
  private stripSqlFence(raw: string): string {
    const trimmed = raw.trim();
    const fence = trimmed.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    return (fence ? fence[1]! : trimmed).trim();
  }
}
