import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { SiteMappingsController } from './site-mappings.controller';
import { ProductsService } from './products.service';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, SiteMappingsController],
  providers: [ProductsService],
  exports: [ProductsService],
})
export class ProductsModule {}
