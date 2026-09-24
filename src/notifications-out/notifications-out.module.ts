import { Module } from '@nestjs/common';
import { KapsoOutboundService } from '../kapso/kapso-outbound.service';
import { TelegramModule } from '../telegram/telegram.module';
import { NotificationsOutService } from './notifications-out.service';
import { NotificationRecoveryCron } from './notification-recovery.cron';

@Module({
  // KapsoOutboundService es un cliente HTTP sin estado: se provee acá en vez de
  // importar KapsoModule para no cerrar el ciclo Kapso → WebhookInbox → SarcoAgent → Notifications.
  imports: [TelegramModule],
  providers: [NotificationsOutService, NotificationRecoveryCron, KapsoOutboundService],
  exports: [NotificationsOutService],
})
export class NotificationsOutModule {}
