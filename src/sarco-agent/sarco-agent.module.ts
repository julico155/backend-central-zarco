import { forwardRef, Module } from '@nestjs/common';
import { KapsoModule } from '../kapso/kapso.module';
import { ProductsModule } from '../products/products.module';
import { CategoriesModule } from '../categories/categories.module';
import { SarcoMenuModule } from '../sarco-menu/sarco-menu.module';
import { SarcoPaymentProofModule } from '../sarco-payment-proof/sarco-payment-proof.module';
import { NotificationsOutModule } from '../notifications-out/notifications-out.module';
import { OrdersModule } from '../orders/orders.module';
import { HandoffNoticeService } from './handoff/handoff-notice.service';
import { AgentRepository } from './memory/agent.repository';
import { KapsoAgentMediaResolver } from './kapso-media-resolver.adapter';
import { MenuCatalogAdapter } from './menu-catalog.adapter';
import { SarcoAgentService } from './sarco-agent.service';

/**
 * SarcoAgentModule — Fases 2B/2C/2D: agente conversacional (OpenAI +
 * persistencia) portado desde sarcoRestaurant. Recibe mensajes normalizados
 * del KapsoModule/WebhookInboxModule y responde por el mismo transporte de
 * Kapso. `send_menu` (2C) delega en `SarcoMenuModule.MenuDispatchService`.
 * Antes de tratar una imagen como turno conversacional (2D),
 * `handleInboundBatch` la ofrece primero a `PaymentProofCaptureService`: si
 * hay un pedido QR esperando pago, la imagen se captura como comprobante y
 * NUNCA llega a Vision del agente.
 */
@Module({
  imports: [
    forwardRef(() => KapsoModule),
    ProductsModule,
    CategoriesModule,
    SarcoMenuModule,
    SarcoPaymentProofModule,
    NotificationsOutModule,
    OrdersModule,
  ],
  providers: [
    AgentRepository,
    KapsoAgentMediaResolver,
    MenuCatalogAdapter,
    HandoffNoticeService,
    SarcoAgentService,
  ],
  exports: [SarcoAgentService, AgentRepository],
})
export class SarcoAgentModule {}
