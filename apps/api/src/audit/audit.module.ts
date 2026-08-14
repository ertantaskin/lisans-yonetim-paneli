import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * Denetim izi modülü (§8) — SALT-OKUNUR `audit_log` listeleme.
 * AdminGuard için AuthModule'e bağımlı (customers/security modülleriyle aynı desen).
 * Yazma yolu YOK: audit_log append-only'dir, kayıt üreten yerler kendi modüllerindedir.
 */
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
