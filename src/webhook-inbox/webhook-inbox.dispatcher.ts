import { Injectable } from '@nestjs/common';
import { WebhookDispatchEvent, WebhookDispatchPort } from './webhook-inbox.types';

/**
 * Frontera deliberadamente vacía de esta fase. El inbox puede confirmar que un
 * evento fue procesado sin tocar pedidos, pagos, delivery ni el agente. La
 * siguiente fase reemplazará esta implementación por un dispatcher que use
 * servicios Nest internos, nunca HTTP hacia este mismo backend.
 */
@Injectable()
export class WebhookInboxDispatcher implements WebhookDispatchPort {
  async dispatch(_event: WebhookDispatchEvent): Promise<void> {
    return;
  }
}
