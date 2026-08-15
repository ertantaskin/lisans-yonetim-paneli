import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { GUIDE_BODY_MAX, GUIDE_TITLE_MAX } from '@lisans/shared';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { ProductGuidesService } from './product-guides.service';

const GuideBody = z.object({
  title: z.string().min(1).max(GUIDE_TITLE_MAX),
  /**
   * Tavan `@lisans/shared`'dan gelir — aynı sayı panelin karakter sayacında, servisin
   * ikinci kapısında ve bu doğrulamada TEK kaynaktan okunur. (Sabitin üç yere elle
   * kopyalanması, bu projede sınırların sessizce ayrışmasına yol açan tanıdık bir hata.)
   */
  body: z.string().min(1).max(GUIDE_BODY_MAX),
});
type GuideBody = z.infer<typeof GuideBody>;

const UpdateGuideBody = GuideBody.partial().refine(
  (b) => b.title !== undefined || b.body !== undefined,
  { message: 'En az bir alan gerekli (title/body)' },
);
type UpdateGuideBody = z.infer<typeof UpdateGuideBody>;

/**
 * Admin: kurulum / etkinleştirme rehberleri (§7).
 *
 * Rehber metni SIR DEĞİLDİR (müşteriye giden genel talimat; lisans anahtarı buraya
 * yazılmaz) → owner kapısı yoktur, `AdminGuard` yeterlidir. Buna karşılık metin müşterinin
 * tarayıcısında render edildiği için HTML'e çevrim güvenli alt kümeyle yapılır (shared).
 */
@Controller('admin/product-guides')
@UseGuards(AdminGuard)
export class ProductGuidesController {
  constructor(private readonly guides: ProductGuidesService) {}

  /** Rehber listesi + kaç ürüne bağlı olduğu. */
  @Get()
  list() {
    return this.guides.list();
  }

  /*
   * ÖNİZLEME UCU BİLEREK YOK: panel, metni müşterinin göreceği HTML'e çevirirken AYNI
   * paylaşılan kodu (packages/shared → renderGuideHtml) tarayıcıda çalıştırır. Sunucuya
   * her tuş vuruşunda gidip gelmenin ne gecikme ne güvenlik karşılığı var; ikinci bir uç
   * açmak ise bakılması gereken yetim bir yüzey bırakırdı.
   */

  @Post()
  create(@Body(new ZodBody(GuideBody)) body: GuideBody) {
    return this.guides.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateGuideBody)) body: UpdateGuideBody,
  ) {
    return this.guides.update(id, body);
  }

  /** Silme ÜRÜN SİLMEZ: ürünler rehbersiz kalır (yanıtta kaç ürün etkilendiği döner). */
  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.guides.remove(id);
  }
}
