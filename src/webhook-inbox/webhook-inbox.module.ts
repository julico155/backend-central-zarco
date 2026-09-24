import { Module } from '@nestjs/common';
import { WebhookInboxCron } from './webhook-inbox.cron';
import { WebhookInboxDispatcher } from './webhook-inbox.dispatcher';
import { WebhookInboxService } from './webhook-inbox.service';

@Module({
  providers: [WebhookInboxService, WebhookInboxDispatcher, WebhookInboxCron],
  exports: [WebhookInboxService, WebhookInboxDispatcher],
})
export class WebhookInboxModule {}
