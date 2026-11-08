import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/configuration';
import { GatewayClientModule } from '../../gateway-client/gateway-client.module';
import { NotificationsOutModule } from '../../notifications-out/notifications-out.module';
import { SmarkyClient } from './smarky-client';
import { SMARKY_CLIENT, SmarkyDeliveryService } from './smarky-delivery.service';
import { CommonModule } from '../../common/common.module';
import { SmarkyTrackingController } from './smarky-tracking.controller';
import { SmarkyTrackingService } from './smarky-tracking.service';
import { SmarkyWebhookController } from './smarky-webhook.controller';
import { SmarkyWebhookService } from './smarky-webhook.service';

/** Proveedor de reparto `smarky` (DELIVERY_PROVIDER=smarky). Con `internal` queda inerte. */
@Module({
  imports: [CommonModule, GatewayClientModule, NotificationsOutModule],
  controllers: [SmarkyWebhookController, SmarkyTrackingController],
  providers: [
    {
      provide: SMARKY_CLIENT,
      useFactory: (config: ConfigService<AppConfig, true>): SmarkyClient | null => {
        const { provider, smarky } = config.get('delivery', { infer: true });
        if (provider !== 'smarky' || !smarky.baseUrl || !smarky.apiKey) return null;
        return new SmarkyClient({ baseUrl: smarky.baseUrl, apiKey: smarky.apiKey });
      },
      inject: [ConfigService],
    },
    SmarkyDeliveryService,
    SmarkyWebhookService,
    SmarkyTrackingService,
  ],
  exports: [SmarkyDeliveryService],
})
export class SmarkyModule {}
