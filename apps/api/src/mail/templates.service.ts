import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
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

  /** Öncelik: site override > ürün şablonu > yerleşik varsayılan (§6). */
  async resolve(
    productId: string | null,
    siteId: string,
  ): Promise<{ subject: string; body: string }> {
    if (productId) {
      const [siteOverride] = await this.db
        .select()
        .from(deliveryTemplates)
        .where(
          and(eq(deliveryTemplates.productId, productId), eq(deliveryTemplates.siteId, siteId)),
        )
        .limit(1);
      if (siteOverride) return { subject: siteOverride.subject, body: siteOverride.body };

      const [productTpl] = await this.db
        .select()
        .from(deliveryTemplates)
        .where(and(eq(deliveryTemplates.productId, productId), isNull(deliveryTemplates.siteId)))
        .limit(1);
      if (productTpl) return { subject: productTpl.subject, body: productTpl.body };
    }
    return { subject: DEFAULT_SUBJECT, body: DEFAULT_BODY };
  }
}
