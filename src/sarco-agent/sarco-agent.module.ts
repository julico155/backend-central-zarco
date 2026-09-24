import { forwardRef, Module } from '@nestjs/common';
import { KapsoModule } from '../kapso/kapso.module';
import { ProductsModule } from '../products/products.module';
import { CategoriesModule } from '../categories/categories.module';
import { SarcoMenuModule } from '../sarco-menu/sarco-menu.module';
import { AgentRepository } from './memory/agent.repository';
import { KapsoAgentMediaResolver } from './kapso-media-resolver.adapter';
import { MenuCatalogAdapter } from './menu-catalog.adapter';
import { SarcoAgentService } from './sarco-agent.service';

/**
 * SarcoAgentModule — Fase 2B/2C: agente conversacional (OpenAI +
 * persistencia) portado desde sarcoRestaurant. Recibe mensajes normalizados
 * del KapsoModule/WebhookInboxModule y responde por el mismo transporte de
 * Kapso. `send_menu` (2C) delega en `SarcoMenuModule.MenuDispatchService`,
 * que es quien de verdad crea/reutiliza la sesión y manda el CTA.
 */
@Module({
  imports: [forwardRef(() => KapsoModule), ProductsModule, CategoriesModule, SarcoMenuModule],
  providers: [AgentRepository, KapsoAgentMediaResolver, MenuCatalogAdapter, SarcoAgentService],
  exports: [SarcoAgentService, AgentRepository],
})
export class SarcoAgentModule {}
