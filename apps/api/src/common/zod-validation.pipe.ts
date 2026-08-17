import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Gövde/parametre doğrulama pipe'ı (§8 "zod şema doğrulama"). Kullanım:
 *   @Body(new ZodBody(CreateOrderRequest)) body: CreateOrderRequest
 *
 * GİRDİ TİPİ `unknown`: şema `.transform()`/`.pipe()` içerebilsin diye. Eski imza
 * `ZodSchema<T>` (= girdi ve çıktı AYNI tip) idi → dönüştüren hiçbir şema pipe'a
 * verilemiyordu. Query string her zaman metin taşır (`?limit=5`, `?target=a,b`), yani
 * sayıya/diziye çeviren şemalar bu ucun doğal ihtiyacıdır; eski imza bunları yasaklayıp
 * doğrulamayı elle `if` yığınlarına itiyordu. Çalışma-anı davranışı DEĞİŞMEDİ
 * (safeParse + 400 aynı) — yalnız kabul edilen şema kümesi genişledi.
 */
export class ZodBody<T> implements PipeTransform {
  constructor(private readonly schema: ZodType<T, ZodTypeDef, unknown>) {}

  transform(value: unknown): T {
    // Boş gövde (POST body yok) → {} : yalnız opsiyonel alanlı şemalar geçebilsin.
    const input = value === undefined || value === null ? {} : value;
    const result = this.schema.safeParse(input);
    if (!result.success) {
      throw new BadRequestException({
        error: 'validation_error',
        issues: result.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return result.data;
  }
}
