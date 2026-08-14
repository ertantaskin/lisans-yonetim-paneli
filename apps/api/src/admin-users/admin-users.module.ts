import { Module } from '@nestjs/common';
import { AdminAuthController, AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';
import { AdminTotpService } from './totp.service';

@Module({
  controllers: [AdminAuthController, AdminUsersController],
  // AdminTotpService, AdminUsersService'e @Optional() enjekte edilir (giriş akışındaki ikinci
  // faktör) ve controller'da doğrudan kullanılır. CryptoService/Redis @Global modüllerden gelir.
  providers: [AdminUsersService, AdminTotpService],
  exports: [AdminUsersService, AdminTotpService],
})
export class AdminUsersModule {}
