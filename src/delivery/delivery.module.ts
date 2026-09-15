import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { CommonModule } from '../common/common.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryTariffService } from './delivery-tariff.service';
import { DISTANCE_SERVICE, DistanceService, HaversineDistanceService } from './distance/distance.service';
import { MapboxDistanceService } from './distance/mapbox-distance.service';

@Module({
  imports: [CommonModule, OperationalSettingsModule],
  controllers: [DeliveryController],
  providers: [
    DeliveryService,
    DeliveryTariffService,
    {
      provide: DISTANCE_SERVICE,
      useFactory: (config: ConfigService<AppConfig, true>): DistanceService => {
        const { accessToken } = config.get('mapbox', { infer: true });
        return accessToken ? new MapboxDistanceService(accessToken) : new HaversineDistanceService();
      },
      inject: [ConfigService],
    },
  ],
  exports: [DeliveryService, DeliveryTariffService],
})
export class DeliveryModule {}
