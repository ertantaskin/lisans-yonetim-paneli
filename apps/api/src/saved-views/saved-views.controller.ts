import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AdminActor } from '../auth/admin-actor.decorator';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import type { SavedView } from '../db/schema/savedViews';
import { SavedViewsService } from './saved-views.service';

/** Yeni kayıtlı görünüm gövdesi (§14). query = kaydedilen URL query string. */
const CreateSavedViewSchema = z.object({
  page: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  query: z.string().max(2000),
});
type CreateSavedViewBody = z.infer<typeof CreateSavedViewSchema>;

/**
 * Admin: kayıtlı görünümler (§14). Actor bazlı — her admin yalnız kendi görünümlerini
 * listeler/oluşturur/siler (actor @AdminActor ile x-admin-actor başlığından okunur).
 */
@Controller('admin/saved-views')
@UseGuards(AdminGuard)
export class SavedViewsController {
  constructor(private readonly savedViews: SavedViewsService) {}

  /** Bu admin'in ?page= ile verilen sayfaya ait görünümleri. */
  @Get()
  async list(@AdminActor() actor: string, @Query('page') page?: string): Promise<SavedView[]> {
    return this.savedViews.list(actor, (page ?? '').trim());
  }

  /** Mevcut filtre/arama durumunu adlandırıp kaydeder. */
  @Post()
  async create(
    @AdminActor() actor: string,
    @Body(new ZodBody(CreateSavedViewSchema)) body: CreateSavedViewBody,
  ): Promise<SavedView> {
    return this.savedViews.create(actor, body.page, body.name, body.query);
  }

  /** Görünümü siler — yalnız isteği yapan actor'a aitse. */
  @Delete(':id')
  async remove(
    @AdminActor() actor: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ): Promise<{ deleted: boolean }> {
    return { deleted: await this.savedViews.remove(actor, id) };
  }
}
