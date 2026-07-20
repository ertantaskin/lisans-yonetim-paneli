import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { SitesService } from './sites.service';

const CreateSiteBody = z.object({
  domain: z.string().min(1),
  type: z.enum(['woocommerce', 'marketplace', 'reseller']).optional(),
  senderEmail: z.string().email().optional(),
});
type CreateSiteBody = z.infer<typeof CreateSiteBody>;

/** Admin: site (tenant) yönetimi. ADMIN_TOKEN gerektirir. */
@Controller('admin/sites')
@UseGuards(AdminGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Post()
  create(@Body(new ZodBody(CreateSiteBody)) body: CreateSiteBody) {
    // apiKey + hmacSecret YALNIZ burada bir kez döner — güvenli sakla.
    return this.sites.create(body);
  }

  @Get()
  list() {
    return this.sites.list();
  }
}
