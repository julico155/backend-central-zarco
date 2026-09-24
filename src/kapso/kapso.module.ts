import { forwardRef, Module } from '@nestjs/common';
import { WebhookInboxModule } from '../webhook-inbox/webhook-inbox.module';
import { KapsoMediaResolverService } from './kapso-media-resolver.service';
import { KapsoOutboundService } from './kapso-outbound.service';
import { KapsoWebhookController } from './kapso-webhook.controller';

@Module({
  // forwardRef: WebhookInboxModule ahora depende de SarcoAgentModule (para el
  // dispatcher), que a su vez depende de este módulo (KapsoOutboundService,
  // KapsoMediaResolverService) — ciclo de 3 módulos, resuelto perezosamente.
  imports: [forwardRef(() => WebhookInboxModule)],
  controllers: [KapsoWebhookController],
  providers: [KapsoMediaResolverService, KapsoOutboundService],
  exports: [KapsoMediaResolverService, KapsoOutboundService],
})
export class KapsoModule {}
