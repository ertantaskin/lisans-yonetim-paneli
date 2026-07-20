import { BadRequestException, PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Gövde/parametre doğrulama pipe'ı (§8 "zod şema doğrulama"). Kullanım:
 *   @Body(new ZodBody(CreateOrderRequest)) body: CreateOrderRequest
 */
export class ZodBody<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

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
