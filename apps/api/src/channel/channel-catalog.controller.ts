import { Controller, Get, UseGuards } from '@nestjs/common';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import type { Site } from '../db/schema';
import { ChannelCatalogService, type ChannelCatalogItem } from './channel-catalog.service';

/**
 * Reseller/marketplace katalog ucu (§10). HMAC imzalı — global prefix 'v1' zaten
 * uygulandığından yol 'v1/catalog' olur. Salt-okunur; FİYAT/gelir DÖNMEZ.
 */
@Controller('catalog')
@UseGuards(HmacGuard)
export class ChannelCatalogController {
  constructor(private readonly catalog: ChannelCatalogService) {}

  /** Bu siteye aktif eşlenmiş ürünler + anlık stok (fiyatsız). */
  @Get()
  catalogForSite(@CurrentSite() site: Site): Promise<ChannelCatalogItem[]> {
    return this.catalog.catalogForSite(site.id);
  }
}
