import { Module } from '@nestjs/common';
import { GatewayClientModule } from '../gateway-client/gateway-client.module';
import { NotificationsOutService } from './notifications-out.service';

@Module({
  imports: [GatewayClientModule],
  providers: [NotificationsOutService],
  exports: [NotificationsOutService],
})
export class NotificationsOutModule {}
