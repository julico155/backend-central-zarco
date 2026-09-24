import { Module } from '@nestjs/common';
import { WebhookInboxModule } from '../webhook-inbox/webhook-inbox.module';
import { KapsoMediaResolverService } from './kapso-media-resolver.service';
import { KapsoWebhookController } from './kapso-webhook.controller';

@Module({
  imports: [WebhookInboxModule],
  controllers: [KapsoWebhookController],
  providers: [KapsoMediaResolverService],
  exports: [KapsoMediaResolverService],
})
export class KapsoModule {}
