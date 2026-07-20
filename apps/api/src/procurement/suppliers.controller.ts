import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AdminGuard } from '../auth/admin.guard';
import { ZodBody } from '../common/zod-validation.pipe';
import { SuppliersService } from './suppliers.service';

const CreateSupplierBody = z.object({
  name: z.string().min(1),
  contact: z.string().optional(),
  notes: z.string().optional(),
});
type CreateSupplierBody = z.infer<typeof CreateSupplierBody>;

const UpdateSupplierBody = z.object({
  name: z.string().min(1).optional(),
  contact: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  active: z.boolean().optional(),
});
type UpdateSupplierBody = z.infer<typeof UpdateSupplierBody>;

/** Admin: tedarikçi yönetimi (§12). ADMIN_TOKEN gerektirir. */
@Controller('admin/suppliers')
@UseGuards(AdminGuard)
export class SuppliersController {
  constructor(private readonly suppliers: SuppliersService) {}

  @Get()
  list() {
    return this.suppliers.list();
  }

  @Post()
  create(@Body(new ZodBody(CreateSupplierBody)) body: CreateSupplierBody) {
    return this.suppliers.create(body);
  }

  /** Pasifleştirme (active=false) dahil kısmi güncelleme. */
  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateSupplierBody)) body: UpdateSupplierBody,
  ) {
    return this.suppliers.update(id, body);
  }
}
