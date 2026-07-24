import { Body, Controller, Get, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { CustomersService } from './customers.service';

const UpdateCustomerBody = z.object({
  tags: z.array(z.string()).optional(),
  notes: z.string().nullable().optional(),
});
type UpdateCustomerBody = z.infer<typeof UpdateCustomerBody>;

/** Admin: müşteri kayıtları (§13). ADMIN_TOKEN gerektirir. */
@Controller('admin/customers')
@UseGuards(AdminGuard)
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  list(@Query('search') search?: string, @Query('siteId') siteId?: string) {
    return this.customers.list({ search, siteId });
  }

  @Get(':email')
  detail(@Param('email') email: string) {
    return this.customers.detail(email);
  }

  @Patch(':email')
  update(
    @Param('email') email: string,
    @Body(new ZodBody(UpdateCustomerBody)) body: UpdateCustomerBody,
  ) {
    return this.customers.update(email, body);
  }
}
