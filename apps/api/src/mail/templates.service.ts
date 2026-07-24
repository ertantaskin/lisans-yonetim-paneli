import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import { DB, type Database } from '../db/db.module';
import { deliveryTemplates } from '../db/schema';

const DEFAULT_SUBJECT = 'Siparişiniz hazır — {{order_no}}';
const DEFAULT_BODY = `Merhaba,

{{order_no}} numaralı siparişinizin teslimatı aşağıdadır:

{{items}}

Herhangi bir sorun olursa yanıtlayabilirsiniz.

İyi günler,
{{site_name}}`;

/** {{degisken}} token değişimi (§6). */
export function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? '');
}

@Injectable()
export class TemplatesService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Öncelik (en dar kapsam kazanır, §6): ürün+site → ürün geneli → site geneli
   * (ürünsüz override) → genel varsayılan (ürünsüz+sitesiz) → yerleşik varsayılan.
   * Her katmanda birden fazla kayıt varsa EN YENİ (createdAt desc) belirleyici kazanır
   * (list() sıralamasıyla + admin sezgisiyle uyumlu; DB'de unique kısıt yok).
   */
  async resolve(
    productId: string | null,
    siteId: string,
  ): Promise<{ subject: string; body: string }> {
    // Kapsam daraldıkça sırayla dene; ilk eşleşen kazanır.
    const tiers: SQL[] = [];
    if (productId) {
      // 1) ürün + bu site (en dar) · 2) ürün geneli (site yok)
      tiers.push(
        and(eq(deliveryTemplates.productId, productId), eq(deliveryTemplates.siteId, siteId))!,
        and(eq(deliveryTemplates.productId, productId), isNull(deliveryTemplates.siteId))!,
      );
    }
    // 3) ürünsüz + bu site (site geneli override) · 4) ürünsüz + sitesiz (genel varsayılan)
    tiers.push(
      and(isNull(deliveryTemplates.productId), eq(deliveryTemplates.siteId, siteId))!,
      and(isNull(deliveryTemplates.productId), isNull(deliveryTemplates.siteId))!,
    );

    for (const where of tiers) {
      const [tpl] = await this.db
        .select()
        .from(deliveryTemplates)
        .where(where)
        .orderBy(desc(deliveryTemplates.createdAt))
        .limit(1);
      if (tpl) return { subject: tpl.subject, body: tpl.body };
    }

    // 5) hiçbir şablon yoksa yerleşik varsayılan.
    return { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY };
  }
}
