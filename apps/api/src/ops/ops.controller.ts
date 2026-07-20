import { BadRequestException, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { OpsService, type DeadLetterRow, type ReplayKind } from './ops.service';

/** Admin: ops/dead-letter — başarısız outbox + mail listesi ve replay (§16). */
@Controller('admin/ops')
@UseGuards(AdminGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  /** Başarısız geri-kanal olayları + mail logları (birleşik, DESC, limit 100). */
  @Get('dead-letter')
  async deadLetter(): Promise<{ items: DeadLetterRow[] }> {
    return { items: await this.ops.deadLetter() };
  }

  /** İlgili dead-letter kaydını yeniden kuyruğa alır (kind: outbox|email). */
  @Post('replay/:kind/:id')
  async replay(
    @Param('kind') kind: string,
    @Param('id') id: string,
  ): Promise<{ replayed: true; kind: ReplayKind; id: string }> {
    if (kind !== 'outbox' && kind !== 'email') {
      throw new BadRequestException("kind yalnız 'outbox' veya 'email' olabilir");
    }
    return this.ops.replay(kind, id);
  }
}
