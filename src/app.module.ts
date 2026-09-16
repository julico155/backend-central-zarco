import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import configuration from './config/configuration';
import { DatabaseModule } from './database/database.module';
import { CommonModule } from './common/common.module';
import { GatewayClientModule } from './gateway-client/gateway-client.module';
import { NotificationsOutModule } from './notifications-out/notifications-out.module';
import { CategoriesModule } from './categories/categories.module';
import { ProductsModule } from './products/products.module';
import { CustomersModule } from './customers/customers.module';
import { PromotionsModule } from './promotions/promotions.module';
import { OperationalSettingsModule } from './operational-settings/operational-settings.module';
import { OrdersModule } from './orders/orders.module';
import { DeliveryModule } from './delivery/delivery.module';
import { PaymentAttemptsModule } from './payment-attempts/payment-attempts.module';
import { PaymentProofsModule } from './payment-proofs/payment-proofs.module';
import { LateOrderRequestsModule } from './late-order-requests/late-order-requests.module';
import { AuthModule } from './auth/auth.module';
import { CashRegisterModule } from './cash-register/cash-register.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    DatabaseModule,
    CommonModule,
    GatewayClientModule,
    NotificationsOutModule,
    CategoriesModule,
    ProductsModule,
    CustomersModule,
    PromotionsModule,
    OperationalSettingsModule,
    OrdersModule,
    DeliveryModule,
    PaymentAttemptsModule,
    PaymentProofsModule,
    LateOrderRequestsModule,
    AuthModule,
    CashRegisterModule,
  ],
})
export class AppModule {}
