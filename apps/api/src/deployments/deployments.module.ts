import { Module } from '@nestjs/common';
import { DeploymentsController } from './deployments.controller';
import { DeploymentsService } from './deployments.service';

/**
 * DeploymentsModule — panelden prod dağıtım yönetimi (§16). İstek kaydı + geçmiş + host
 * runner geri-bildirim uçları. Gerçek dağıtımı host'taki `scripts/deploy-runner.sh` yapar.
 */
@Module({
  controllers: [DeploymentsController],
  providers: [DeploymentsService],
})
export class DeploymentsModule {}
