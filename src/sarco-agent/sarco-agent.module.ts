import { forwardRef, Module } from '@nestjs/common';
import { KapsoModule } from '../kapso/kapso.module';
import { ProductsModule } from '../products/products.module';
import { CategoriesModule } from '../categories/categories.module';
import { AgentRepository } from './memory/agent.repository';
import { KapsoAgentMediaResolver } from './kapso-media-resolver.adapter';
import { MenuCatalogAdapter } from './menu-catalog.adapter';
import { SarcoAgentService } from './sarco-agent.service';

/**
 * SarcoAgentModule — Fase 2B: agente conversacional (OpenAI + persistencia)
 * portado desde sarcoRestaurant. Recibe mensajes normalizados del
 * KapsoModule/WebhookInboxModule y responde por el mismo transporte de
 * Kapso, sin depender de `menu_sessions` (2C) ni de tráfico real todavía —
 * el dispatcher lo conecta, pero nada en este módulo activa el webhook por
 * sí solo.
 */
@Module({
  imports: [forwardRef(() => KapsoModule), ProductsModule, CategoriesModule],
  providers: [AgentRepository, KapsoAgentMediaResolver, MenuCatalogAdapter, SarcoAgentService],
  exports: [SarcoAgentService, AgentRepository],
})
export class SarcoAgentModule {}
