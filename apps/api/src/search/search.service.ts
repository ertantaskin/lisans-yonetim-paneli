import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  AccountPayloadSchema,
  maskAccountFields,
  maskSecret,
  parseAccountPayload,
} from '@jetlisans/shared';
import { DB, type Database } from '../db/db.module';
import { rawRows } from '../db/raw-query';
import { CryptoService } from '../crypto/crypto.service';

/** Eşleşen sipariş özeti (payload/sır İÇERMEZ — yalnız meta). */
export interface SearchOrderHit {
  id: string;
  remoteOrderId: string;
  customerEmail: string;
  status: string;
}

/** Eşleşen key/lisans özeti — MASKELİ gösterim; düz payload ASLA dönmez (§13). */
export interface SearchKeyHit {
  licenseItemId: string;
  productSku: string;
  /** Atanmışsa bağlı sipariş; havuzda bekliyorsa null. */
  orderId: string | null;
  /** ••••••<son-4> biçimi maske (uzunluk/segment sızmaz); hesap ürününde alan-alan. */
  masked: string;
}

export interface SearchResult {
  orders: SearchOrderHit[];
  keys: SearchKeyHit[];
}

/**
 * Global arama servisi (§13, Ctrl+K). Salt-okunur; hiçbir yan etki/audit yapmaz.
 * İki eksende arar:
 *  - orders: remote_order_id + customer_email ILIKE (limit 10)
 *  - keys: q en az 3 RAKAM içeriyorsa payload_suffix_hash (son-5) eşleşmesi (limit 10)
 *
 * KRİTİK: payload düz metin DÖNMEZ. Key sonuçları yalnız MASKELİ gösterim + bağlı
 * sipariş meta'sı taşır. Suffix hash anahtarlıdır (master key) → son-5 hane sızmaz.
 * Maske için payload çözülür ama bu reveal DEĞİLDİR (audit'e düşmez; sipariş detayı
 * ekranındaki maskeli gösterimle aynı sınıf işlem — yalnız son-4 görünür).
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(DB) private readonly db: Database,
    private readonly crypto: CryptoService,
  ) {}

  async search(q: string): Promise<SearchResult> {
    const term = (q ?? '').trim();
    // Çok kısa sorguda (tek karakter) tüm tabloyu taramanın anlamı yok.
    if (term.length < 2) return { orders: [], keys: [] };

    const [orders, keys] = await Promise.all([this.searchOrders(term), this.searchKeys(term)]);
    return { orders, keys };
  }

  /** remote_order_id + customer_email ILIKE (limit 10). ILIKE joker'leri kaçırılır. */
  private async searchOrders(term: string): Promise<SearchOrderHit[]> {
    const pattern = `%${escapeLike(term)}%`;
    const list = await rawRows<{
      id: string;
      remote_order_id: string;
      customer_email: string;
      status: string;
    }>(this.db, sql`
      SELECT id, remote_order_id, customer_email, status
      FROM orders
      WHERE remote_order_id ILIKE ${pattern} ESCAPE '\\'
         OR customer_email ILIKE ${pattern} ESCAPE '\\'
      ORDER BY created_at DESC
      LIMIT 10;
    `);
    return list.map((r) => ({
      id: r.id,
      remoteOrderId: r.remote_order_id,
      customerEmail: r.customer_email,
      status: r.status,
    }));
  }

  /**
   * Son-5 hane araması: q en az 3 RAKAM içermiyorsa çalışmaz (yanlış eşleşme gürültüsü
   * önlenir). payload_suffix_hash mevcut anahtarlı hash fonksiyonuyla üretilir (yeniden
   * kullanım). Eşleşen kayıtlar çözülüp MASKELENİR — düz payload dönmez.
   */
  private async searchKeys(term: string): Promise<SearchKeyHit[]> {
    const digitCount = (term.match(/\d/g) ?? []).length;
    if (digitCount < 3) return [];

    const suffixHash = this.crypto.payloadSuffixHash(term);
    const list = await rawRows<{
      id: string;
      payload_enc: string;
      sku: string;
      kind: string;
      payload_schema: unknown;
      order_id: string | null;
    }>(this.db, sql`
      SELECT
        li.id AS id,
        li.payload_enc AS payload_enc,
        p.sku AS sku,
        p.kind AS kind,
        p.payload_schema AS payload_schema,
        (
          SELECT a.order_id
          FROM assignments a
          WHERE a.license_item_id = li.id
          ORDER BY a.created_at DESC
          LIMIT 1
        ) AS order_id
      FROM license_items li
      JOIN products p ON p.id = li.product_id
      WHERE li.payload_suffix_hash = ${suffixHash}
      LIMIT 10;
    `);

    return list.map((r) => ({
      licenseItemId: r.id,
      productSku: r.sku,
      orderId: r.order_id ?? null,
      masked: this.maskFor(r.id, r.payload_enc, r.kind, r.payload_schema),
    }));
  }

  /**
   * Payload'ı çözüp maskeler (sipariş detayındaki maskeleme ile aynı sınıf). Çözme
   * v2 kayıtlar için AAD (license_item:<id>) gerektirir. Herhangi bir hata gösterimi
   * bozmaz — güvenli sabit maske döner (sır sızmaz).
   */
  private maskFor(id: string, payloadEnc: string, kind: string, payloadSchema: unknown): string {
    try {
      const plain = this.crypto.decrypt(payloadEnc, CryptoService.licenseItemAad(id));
      if (kind === 'account') {
        const parsed = AccountPayloadSchema.safeParse(payloadSchema);
        if (parsed.success) {
          const masked = maskAccountFields(parseAccountPayload(parsed.data, plain));
          return masked.map((f) => `${f.label}: ${f.value}`).join(' · ');
        }
      }
      return maskSecret(plain);
    } catch {
      return '••••••';
    }
  }
}

/** ILIKE joker karakterlerini (\, %, _) kaçırır — ESCAPE '\' ile birlikte kullanılır. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
