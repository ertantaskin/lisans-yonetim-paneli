import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { SearchService, type SearchResult } from './search.service';

/** Admin: global arama (§13, Ctrl+K). ADMIN_TOKEN gerektirir; salt-okunur. */
@Controller('admin/search')
@UseGuards(AdminGuard)
export class SearchController {
  constructor(private readonly search: SearchService) {}

  /**
   * GET /v1/admin/search?q= → { orders, keys }. Sipariş meta'sı + MASKELİ key
   * gösterimi döner; düz payload ASLA. Boş/kısa q'da boş sonuç.
   */
  @Get()
  query(@Query('q') q?: string): Promise<SearchResult> {
    return this.search.search(q ?? '');
  }
}
