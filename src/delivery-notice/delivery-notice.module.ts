import { Module } from '@nestjs/common';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { DeliveryNoticeService } from './delivery-notice.service';

@Module({
  imports: [NotificationsOutModule],
  providers: [DeliveryNoticeService],
  exports: [DeliveryNoticeService],
})
export class DeliveryNoticeModule {}
