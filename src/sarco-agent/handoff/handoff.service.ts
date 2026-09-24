import { Logger } from '@nestjs/common';
import { pauseAgentForHandoff } from '../control/handoff-pause';
import {
  PAUSE_REASON_HANDOFF_REQUESTED,
  PAUSE_REASON_HANDOFF_SPOKEN,
  type AgentStore,
} from '../core/types';
import type { HandoffPort } from '../tools/request-human';
import { canHandOff } from './handoff-gate';
import { isExplicitHumanRequest } from './explicit-request';
import { hasProblemSignal } from './problem-signal';

/**
 * Derivar una conversación a una persona. Puerto directo de sarcoRestaurant
 * (src/lib/agent/handoff/service.ts), con UNA diferencia deliberada: el paso
 * de AVISAR al equipo (Telegram) todavía no está implementado en Backend
 * Central — la tarea de esta fase lo excluye explícitamente. La pausa SÍ es
 * real y funcional; el aviso queda como un log, documentado, para cuando
 * exista el canal de alertas.
 *
 * Son dos cosas, en este orden:
 *   0. COMPROBAR — ¿hay un motivo en el mensaje para derivar?
 *   1. PAUSAR    — antes que cualquier aviso, para que nadie hable encima.
 *
 * El cliente NO recibe ningún acuse: es un aviso al equipo, no un mensaje al
 * cliente (ver el módulo original para el porqué).
 */

const logger = new Logger('SarcoAgentHandoff');

/** Minutos que calla el agente tras derivar. */
export const HANDOFF_PAUSE_MINUTES = 120;

export function createHandoffPort(store: AgentStore): HandoffPort {
  return {
    async escalate({ customerPhone, sourceMessageId, inboundText }) {
      const explicitRequest = isExplicitHumanRequest(inboundText);
      const problemSignal = explicitRequest ? false : hasProblemSignal(inboundText);

      if (!canHandOff({ explicitRequest, problemSignal })) {
        logger.log('agent_handoff_no_reason');
        return { handed: false };
      }

      const pausa = await pauseAgentForHandoff(
        {
          customerPhone,
          reason: PAUSE_REASON_HANDOFF_REQUESTED,
          source: 'system',
          sourceMessageId,
          minutes: HANDOFF_PAUSE_MINUTES,
          trigger: 'agent_action',
        },
        store,
      );

      if (pausa.result !== 'ok') return { handed: false };

      if (pausa.pause === 'already_applied') return { handed: true };

      // TODO(2C+): aviso real al equipo (Telegram u otro canal). Por ahora
      // solo queda registrado que la derivación ocurrió.
      logger.log(`agent_handoff_escalated reason=${PAUSE_REASON_HANDOFF_REQUESTED}`);

      return { handed: true };
    },
  };
}

/** Minutos que calla el agente después de HABER DICHO que hace falta una persona. */
export const HANDOFF_SPOKEN_PAUSE_MINUTES = 30;

/**
 * El agente dijo que hace falta una persona. Se calla, y (cuando exista el
 * canal) se avisa. Corre DESPUÉS del envío: para cuando esto se ejecuta, la
 * frase ya está en el teléfono del cliente. NUNCA lanza.
 */
export function createSilenceAfterSpokenHandoff(
  store: AgentStore,
): (input: {
  customerPhone: string;
  sourceMessageId: string;
  inboundText: string;
}) => Promise<void> {
  return async (input) => {
    const pausa = await pauseAgentForHandoff(
      {
        customerPhone: input.customerPhone,
        reason: PAUSE_REASON_HANDOFF_SPOKEN,
        source: 'system',
        sourceMessageId: input.sourceMessageId,
        minutes: HANDOFF_SPOKEN_PAUSE_MINUTES,
        trigger: 'agent_action',
      },
      store,
    );

    if (pausa.result !== 'ok' || pausa.pause === 'already_applied') return;

    // TODO(2C+): aviso real al equipo (Telegram u otro canal).
    logger.log(`agent_handoff_escalated reason=${PAUSE_REASON_HANDOFF_SPOKEN}`);
  };
}
