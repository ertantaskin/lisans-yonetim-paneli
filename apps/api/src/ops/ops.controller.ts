import { BadRequestException, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../auth/admin.guard';
import { OpsService, type DeadLetterPage, type ReplayKind } from './ops.service';

/** Admin: ops/dead-letter — başarısız outbox + mail listesi ve replay (§16). */
@Controller('admin/ops')
@UseGuards(AdminGuard)
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  /**
   * Başarısız geri-kanal olayları + mail logları (birleşik, updated_at DESC, satır sınırlı).
   *
   * Yanıt servisin TEK listeleme metodunun sonucunu OLDUĞU GİBİ yayınlar:
   * `{ items, total, truncated, limit }`. `items` dışındaki alanlar kırpılma görünürlüğü
   * içindir — arıza anında yüzlerce başarısız webhook birikirse operatör "listede
   * görünmeyen kayıt replay edilemez" tuzağına düşmesin (§16). Alanları sarmalayıp
   * kırpmak (eski `{ items }` yanıtı) bu bilgiyi ekrana ulaşmadan yok ediyordu.
   */
  @Get('dead-letter')
  async deadLetter(): Promise<DeadLetterPage> {
    return this.ops.deadLetterPage();
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
