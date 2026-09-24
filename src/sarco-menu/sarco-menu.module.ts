import { Module } from '@nestjs/common';
import { KapsoModule } from '../kapso/kapso.module';
import { ProductsModule } from '../products/products.module';
import { CategoriesModule } from '../categories/categories.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { CustomersModule } from '../customers/customers.module';
import { OrdersModule } from '../orders/orders.module';
import { MenuSessionRepository } from './menu-session.repository';
import { MenuSendDeliveryRepository } from './menu-send-delivery.repository';
import { MenuDispatchService } from './menu-dispatch.service';
import { MenuCatalogService } from './menu-catalog.service';
import { MenuOrderService } from './menu-order.service';
import { MenuController } from './menu.controller';

/**
 * SarcoMenuModule — Fase 2C: sesión segura del menú web, catálogo (leído de
 * Central, nunca de `menu_items` de sarcoRestaurant) y creación de pedidos
 * que termina en `OrdersService`. `MenuDispatchService` implementa el
 * `MenuDispatchPort` que `SarcoAgentModule` (Fase 2B) dejó como interfaz sin
 * implementar — ver `sarco-agent.module.ts`.
 */
@Module({
  imports: [
    KapsoModule,
    ProductsModule,
    CategoriesModule,
    PromotionsModule,
    CustomersModule,
    OrdersModule,
  ],
  controllers: [MenuController],
  providers: [
    MenuSessionRepository,
    MenuSendDeliveryRepository,
    MenuDispatchService,
    MenuCatalogService,
    MenuOrderService,
  ],
  exports: [MenuDispatchService, MenuCatalogService],
})
export class SarcoMenuModule {}
