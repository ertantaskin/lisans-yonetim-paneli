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
import { DeliveryTemplatesService } from './templates.service';

const CreateTemplateBody = z.object({
  subject: z.string().min(1),
  body: z.string().min(1),
  productId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
});
type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

const UpdateTemplateBody = z.object({
  subject: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
  productId: z.string().uuid().nullable().optional(),
  siteId: z.string().uuid().nullable().optional(),
});
type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

const PreviewBody = z.object({
  sampleVars: z.record(z.string(), z.string()).optional(),
});
type PreviewBody = z.infer<typeof PreviewBody>;

const TestBody = z.object({
  toEmail: z.string().email(),
});
type TestBody = z.infer<typeof TestBody>;

/** Admin: teslimat mail şablonları CRUD + önizleme + test-mail (§6/§13). */
@Controller('admin/templates')
@UseGuards(AdminGuard)
export class TemplatesController {
  constructor(private readonly templates: DeliveryTemplatesService) {}

  @Get()
  list() {
    return this.templates.list();
  }

  @Get(':id')
  get(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.templates.get(id);
  }

  @Post()
  create(@Body(new ZodBody(CreateTemplateBody)) body: CreateTemplateBody) {
    return this.templates.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(UpdateTemplateBody)) body: UpdateTemplateBody,
  ) {
    return this.templates.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.templates.remove(id);
  }

  /** Örnek değişkenlerle render — gönderim YOK (§6). */
  @Post(':id/preview')
  preview(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(PreviewBody)) body: PreviewBody,
  ) {
    return this.templates.preview(id, body.sampleVars);
  }

  /** Tek-seferlik test maili (örnek değişkenlerle) — gerçek müşteri verisi kullanılmaz. */
  @Post(':id/test')
  test(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodBody(TestBody)) body: TestBody,
  ) {
    return this.templates.sendTest(id, body.toEmail);
  }
}
