import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { HmacGuard } from '../auth/hmac.guard';
import { CurrentSite } from '../auth/current-site.decorator';
import { ZodBody } from '../common/zod-validation.pipe';
import type { Site } from '../db/schema';
import { ReplacementsService } from './replacements.service';

const CreateReplacementBody = z.object({
  remoteOrderId: z.string().min(1),
  reason: z.string().min(3),
  assignmentId: z.string().uuid().optional(),
});
type CreateReplacementBody = z.infer<typeof CreateReplacementBody>;

/** Site-facing değişim/garanti talebi ucu (§13). HMAC imzalı. */
@Controller('replacements')
@UseGuards(HmacGuard)
export class ReplacementsController {
  constructor(private readonly replacements: ReplacementsService) {}

  @Post()
  create(
    @CurrentSite() site: Site,
    @Body(new ZodBody(CreateReplacementBody)) body: CreateReplacementBody,
  ) {
    return this.replacements.create(site, body);
  }
}
