import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductCategoriesController } from './product-categories.controller';
import { SiteMappingsController } from './site-mappings.controller';
import { ProductsService } from './products.service';
import { ProductCategoriesService } from './product-categories.service';

@Module({
  imports: [AuthModule],
  controllers: [ProductsController, ProductCategoriesController, SiteMappingsController],
  providers: [ProductsService, ProductCategoriesService],
  exports: [ProductsService, ProductCategoriesService],
})
export class ProductsModule {}
