import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { SarcoAgentService } from '../sarco-agent/sarco-agent.service';
import { KAPSO_SUPPORTED_EVENT, KAPSO_OUTBOUND_EVENT_NAMES } from '../kapso/kapso.types';
import { WebhookDispatchEvent, WebhookDispatchPort } from './webhook-inbox.types';

/**
 * Frontera entre el inbox durable y el agente conversacional (Fase 2B).
 *
 * Clasifica cada entrega ya normalizada y aceptada:
 *   - `whatsapp.message.received`  → SarcoAgentService.handleInboundBatch
 *     (persiste TODO el historial; solo dispara un turno del agente para los
 *     mensajes elegibles — texto o imagen con contenido).
 *   - los cuatro eventos salientes → SarcoAgentService.handleOutboundEvent
 *     (dispara el takeover humano cuando corresponde; el resto queda
 *     explícitamente diferido, nunca tragado en silencio).
 *   - cualquier otro evento (no debería llegar aquí: el controlador ya los
 *     ignora con 200 antes de aceptar) se registra y no hace nada.
 */
@Injectable()
export class WebhookInboxDispatcher implements WebhookDispatchPort {
  constructor(
    @Inject(forwardRef(() => SarcoAgentService))
    private readonly agent: SarcoAgentService,
  ) {}

  async dispatch(event: WebhookDispatchEvent): Promise<void> {
    if (event.eventName === KAPSO_SUPPORTED_EVENT) {
      await this.agent.handleInboundBatch(event.normalizedEvents);
      return;
    }

    if ((KAPSO_OUTBOUND_EVENT_NAMES as readonly string[]).includes(event.eventName)) {
      await this.agent.handleOutboundEvent(event.eventName, event.payload, event.normalizedEvents);
      return;
    }
  }
}
