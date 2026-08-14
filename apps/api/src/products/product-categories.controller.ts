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
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { ProductCategoriesService } from './product-categories.service';

const CategoryBody = z.object({
  name: z.string().min(1).max(80),
  /** Kart altında görünen rehber cümlesi — operatöre "buraya ne koyulur"u anlatır. */
  description: z.string().max(200).nullable().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});
type CategoryBody = z.infer<typeof CategoryBody>;

const UpdateCategoryBody = CategoryBody.partial().refine(
  (b) => b.name !== undefined || b.description !== undefined || b.sortOrder !== undefined,
  { message: 'En az bir alan gerekli (name/description/sortOrder)' },
);
type UpdateCategoryBody = z.infer<typeof UpdateCategoryBody>;

/**
 * Admin: ürün kategorileri (§17). Ad TEK kayıttır ve buradan yönetilir; ürün formunda
 * yalnız listeden seçilir (serbest metin yok → ikiz kategori yok).
 */
@Controller('admin/product-categories')
@UseGuards(AdminGuard)
export class ProductCategoriesController {
  constructor(private readonly categories: ProductCategoriesService) {}

  /** Kategori kartları: ad + ürün sayısı + atanabilir stok + düşük stok sayacı. */
  @Get()
  list() {
    return this.categories.list();
  }

  @Post()
  create(@Body(new ZodBody(CategoryBody)) body: CategoryBody) {
    return this.categories.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateCategoryBody)) body: UpdateCategoryBody,
  ) {
    return this.categories.update(id, body);
  }

  /** Silme ÜRÜN SİLMEZ: ürünler "Kategorisiz" olur (yanıtta kaç ürün etkilendiği döner). */
  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.categories.remove(id);
  }
}
