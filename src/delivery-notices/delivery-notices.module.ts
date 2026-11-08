import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { SmarkyModule } from '../delivery/smarky/smarky.module';
import { DeliveryNoticesService } from './delivery-notices.service';

@Module({
  imports: [CommonModule, NotificationsOutModule, SmarkyModule],
  providers: [DeliveryNoticesService],
  exports: [DeliveryNoticesService],
})
export class DeliveryNoticesModule {}
