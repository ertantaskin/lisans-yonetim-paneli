import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProductsController } from './products.controller';
import { ProductCategoriesController } from './product-categories.controller';
import { ProductGuidesController } from './product-guides.controller';
import { SiteMappingsController } from './site-mappings.controller';
import { ProductsService } from './products.service';
import { ProductCategoriesService } from './product-categories.service';
import { ProductGuidesService } from './product-guides.service';

@Module({
  imports: [AuthModule],
  controllers: [
    ProductsController,
    ProductCategoriesController,
    ProductGuidesController,
    SiteMappingsController,
  ],
  providers: [ProductsService, ProductCategoriesService, ProductGuidesService],
  exports: [ProductsService, ProductCategoriesService, ProductGuidesService],
})
export class ProductsModule {}
