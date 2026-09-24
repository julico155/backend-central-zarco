import { forwardRef, Module } from '@nestjs/common';
import { SarcoAgentModule } from '../sarco-agent/sarco-agent.module';
import { WebhookInboxCron } from './webhook-inbox.cron';
import { WebhookInboxDispatcher } from './webhook-inbox.dispatcher';
import { WebhookInboxService } from './webhook-inbox.service';

@Module({
  // forwardRef: ver kapso.module.ts para el ciclo de 3 módulos que cierra aquí.
  imports: [forwardRef(() => SarcoAgentModule)],
  providers: [WebhookInboxService, WebhookInboxDispatcher, WebhookInboxCron],
  exports: [WebhookInboxService, WebhookInboxDispatcher],
})
export class WebhookInboxModule {}
