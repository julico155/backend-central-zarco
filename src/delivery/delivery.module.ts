import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { OperationalSettingsModule } from '../operational-settings/operational-settings.module';
import { DeliveryController } from './delivery.controller';
import { DeliveryService } from './delivery.service';
import { DeliveryTariffService } from './delivery-tariff.service';
import { DISTANCE_SERVICE, HaversineDistanceService } from './distance/distance.service';

@Module({
  imports: [CommonModule, OperationalSettingsModule],
  controllers: [DeliveryController],
  providers: [
    DeliveryService,
    DeliveryTariffService,
    { provide: DISTANCE_SERVICE, useClass: HaversineDistanceService },
  ],
  exports: [DeliveryService, DeliveryTariffService],
})
export class DeliveryModule {}
