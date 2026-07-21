import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { validateEnv } from './config/env.validation';
import { DbModule } from './db/db.module';
import { RedisModule } from './redis/redis.module';
import { HealthModule } from './health/health.module';
import { CryptoModule } from './crypto/crypto.module';
import { QueueModule } from './queue/queue.module';
import { SitesModule } from './sites/sites.module';
import { AdminUsersModule } from './admin-users/admin-users.module';
import { ProductsModule } from './products/products.module';
import { StockModule } from './stock/stock.module';
import { OrdersModule } from './orders/orders.module';
import { ReplacementsModule } from './replacements/replacements.module';
import { CustomersModule } from './customers/customers.module';
import { NotificationsModule } from './notifications/notifications.module';
import { ReportsModule } from './reports/reports.module';
import { ProcurementModule } from './procurement/procurement.module';
import { SupplyOpsModule } from './supply-ops/supply-ops.module';
import { SecurityModule } from './security/security.module';
import { SearchModule } from './search/search.module';
import { TemplatesModule } from './templates/templates.module';
import { OpsModule } from './ops/ops.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { PresenceModule } from './presence/presence.module';
import { SavedViewsModule } from './saved-views/saved-views.module';
import { UpdatesModule } from './updates/updates.module';
import { AiModule } from './ai/ai.module';
import { AiSupportModule } from './ai/ai-support.module';
import { AiSummaryModule } from './ai/ai-summary.module';
import { AiReportModule } from './ai/ai-report.module';
import { DailyDigestModule } from './ai/daily-digest.module';
import { CostsModule } from './reports/costs.module';
import { RiskScoreModule } from './security/risk-score.module';
import { ChannelModule } from './channel/channel-catalog.module';
import { RateLimitModule } from './common/rate-limit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnv,
    }),
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        transport:
          process.env.NODE_ENV === 'production'
            ? undefined
            : { target: 'pino-pretty', options: { singleLine: true } },
        // Trace-Id uçtan uca (§4/§16): genReqId'i main.ts'teki Fastify adapter belirler
        // (gelen x-trace-id → req.id). pino kendi genReqId'i olmadığında Fastify req.id'sini
        // kullanır → log iz-kimliği = yanıt x-trace-id başlığı = tek uçtan uca iz.
        // Payload/sır loglara sızmasın (§9 redaksiyon).
        redact: {
          paths: [
            'req.headers.authorization',
            'req.headers["x-api-key"]',
            'req.headers["x-signature"]',
            'req.body.payload',
          ],
          remove: true,
        },
      },
    }),
    DbModule,
    RedisModule,
    CryptoModule,
    QueueModule,
    HealthModule,
    SitesModule,
    AdminUsersModule,
    ProductsModule,
    StockModule,
    OrdersModule,
    ReplacementsModule,
    CustomersModule,
    NotificationsModule,
    ReportsModule,
    ProcurementModule,
    SupplyOpsModule,
    SecurityModule,
    SearchModule,
    TemplatesModule,
    OpsModule,
    DashboardModule,
    MaintenanceModule,
    OnboardingModule,
    PresenceModule,
    SavedViewsModule,
    UpdatesModule,
    AiModule,
    AiSupportModule,
    AiSummaryModule,
    AiReportModule,
    DailyDigestModule,
    CostsModule,
    RiskScoreModule,
    ChannelModule,
    RateLimitModule,
  ],
})
export class AppModule {}
