import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../config/configuration';
import { KapsoOutboundService } from '../kapso/kapso-outbound.service';
import type { NormalizedKapsoEvent } from '../kapso/kapso.types';
import { createOpenAiModel, OPENAI_DEFAULT_MODEL } from './openai/adapter';
import { AgentRepository } from './memory/agent.repository';
import { persistCustomerInbound } from './memory/persist-inbound';
import { resolveExpiredPause } from './control/pause-expiry';
import { handleHumanTakeover, humanTakeoverPauseMinutes } from './control/takeover';
import { resumeAgentConversation } from './control/resume';
import { runAgentTurn, isAgentEligibleContent, type AgentTurnBurst } from './core/run';
import { pickTurnModel, turnHasImage } from './core/model-choice';
import { parseAccessMode, parseTestPhones, type AgentEligibilityConfig } from './core/eligibility';
import type {
  AgentInboundMessage,
  AgentSendPort,
  AgentTurnResult,
  ResumeAgentResult,
} from './core/types';
import { classifyOutboundProvenance, toAgentInboundMessage } from './kapso-message';
import { KapsoAgentMediaResolver } from './kapso-media-resolver.adapter';
import { MenuCatalogAdapter } from './menu-catalog.adapter';
import { createGetMenuItemsTool } from './tools/menu-tools';
import { createAnswerDirectlyAction } from './tools/answer-directly';
import { createRequestHumanAction } from './tools/request-human';
import type { AgentTool } from './tools/registry';
import { createHandoffPort, createSilenceAfterSpokenHandoff } from './handoff/handoff.service';
import { DON_ZARCO_MAX_OUTPUT_TOKENS, systemPromptForMode } from './business/prompt';

const logger = new Logger('SarcoAgentService');

/**
 * Cableado real del Agent Core dentro de Backend Central (Fase 2B).
 * Equivalente de `createAgentChannel()` en sarcoRestaurant
 * (src/lib/agent/service.ts), pero como servicio Nest inyectable: reúne el
 * store (Kysely), el modelo (OpenAI), el envío (Kapso) y el catálogo de
 * acciones, y expone los dos puntos de entrada que necesita el dispatcher
 * del webhook — `handleInboundBatch` y `handleOutboundEvent`.
 *
 * Simplificaciones deliberadas de esta fase (documentadas, no silenciosas):
 *  - `systemPromptForMode` se llama siempre con `{cashAllowed: true}`: el
 *    modo promoción/saturación (`readCurrentPromoMode`/`readOrdersPaused` en
 *    sarcoRestaurant) no está portado todavía.
 *  - `send_menu` no está en el catálogo de acciones: depende de
 *    `menu_sessions` (2C). Solo `get_menu_items`, `answer_directly` y
 *    `request_human` están conectadas.
 *  - El aviso al equipo tras un handoff es un log, no Telegram (excluido
 *    explícitamente de esta fase).
 */
@Injectable()
export class SarcoAgentService {
  constructor(
    private readonly config: ConfigService<AppConfig, true>,
    private readonly repository: AgentRepository,
    private readonly kapsoOutbound: KapsoOutboundService,
    private readonly mediaResolver: KapsoAgentMediaResolver,
    private readonly menuCatalog: MenuCatalogAdapter,
  ) {}

  private readAgentEnv() {
    const agent = this.config.get('agent', { infer: true });
    return {
      enabled: agent.enabled === 'true',
      accessMode: parseAccessMode(agent.accessMode),
      testPhones: parseTestPhones(agent.testPhones),
      apiKey: agent.apiKey || null,
      model: agent.model || OPENAI_DEFAULT_MODEL,
      visionModel: agent.visionModel || null,
      humanTakeoverPauseMinutes: humanTakeoverPauseMinutes(agent.humanTakeoverPauseMinutes),
    };
  }

  private eligibilityConfig(): AgentEligibilityConfig {
    const env = this.readAgentEnv();
    return {
      enabled: env.enabled,
      accessMode: env.accessMode,
      testPhones: env.testPhones,
      hasApiKey: env.apiKey !== null && env.apiKey !== '',
    };
  }

  private sendPort(): AgentSendPort {
    return {
      sendText: async (customerPhone, text, phoneNumberId) => {
        const result = await this.kapsoOutbound.sendText(customerPhone, text, phoneNumberId);
        return result.ok
          ? { ok: true, wamid: result.wamid }
          : { ok: false, error: result.error, status: result.status };
      },
    };
  }

  private actions(): AgentTool[] {
    return [
      createGetMenuItemsTool(this.menuCatalog),
      createAnswerDirectlyAction(),
      // Última del catálogo, como en sarcoRestaurant: es lo que se elige
      // cuando ninguna de las otras sirve.
      createRequestHumanAction(createHandoffPort(this.repository)),
    ];
  }

  /**
   * Turno del agente para UN mensaje entrante, con el resto del lote como
   * burst multimodal. Equivalente de `runAgentTurn` dentro de
   * `AgentChannelPort.runAgentTurn` en sarcoRestaurant: normaliza la pausa
   * vencida antes del turno (best-effort) y arma el modelo POR TURNO según
   * si el lote trae imagen.
   */
  private async runTurn(
    message: AgentInboundMessage,
    burst: AgentTurnBurst,
  ): Promise<AgentTurnResult> {
    try {
      await resolveExpiredPause(message.customerPhone, this.repository);
    } catch {
      logger.warn('agent_pause_expiry_failed');
    }

    const env = this.readAgentEnv();

    return runAgentTurn(
      message,
      {
        store: this.repository,
        runs: this.repository,
        model: createOpenAiModel({
          apiKey: env.apiKey ?? '',
          model: pickTurnModel({
            hasImage: turnHasImage(burst),
            textModel: env.model,
            visionModel: env.visionModel,
          }),
        }),
        send: this.sendPort(),
        config: this.eligibilityConfig(),
        systemPrompt: systemPromptForMode({ cashAllowed: true }),
        maxOutputTokens: DON_ZARCO_MAX_OUTPUT_TOKENS,
        actions: this.actions(),
        media: this.mediaResolver,
        silenceAfterReply: createSilenceAfterSpokenHandoff(this.repository),
      },
      burst,
    );
  }

  /**
   * `whatsapp.message.received`, ya normalizado y posiblemente en lote. Se
   * persiste el historial COMPLETO (todos los tipos de contenido, elegibles
   * o no) y solo se dispara un turno del agente por cada mensaje elegible
   * (texto o imagen con contenido) — igual que sarcoRestaurant.
   *
   * Lo que NO se procesa todavía (ubicación, comprobante, interactive) queda
   * PERSISTIDO en el historial pero sin ninguna reacción de negocio: es la
   * frontera explícita que pide esta fase, no un traspaso silencioso.
   */
  async handleInboundBatch(events: readonly NormalizedKapsoEvent[]): Promise<void> {
    const burst = events.map(toAgentInboundMessage);

    for (const message of burst) {
      const persisted = await persistCustomerInbound(message, this.repository);
      if (persisted.result === 'rejected') {
        logger.warn(`agent_inbound_rejected reason=${persisted.reason}`);
        continue;
      }

      if (!isAgentEligibleContent(message)) {
        logger.log(`agent_inbound_deferred content_type=${message.contentType}`);
        continue;
      }

      const result = await this.runTurn(message, burst);
      logger.log(`agent_turn result=${result.result}`);
    }
  }

  /**
   * Uno de los cuatro eventos salientes de Kapso (sent/delivered/read/failed).
   * Solo `sent` con procedencia `business_app` dispara el takeover humano —
   * el resto (nuestros propios envíos vía cloud_api, y los estados de
   * ciclo de vida delivered/read/failed) queda para la reconciliación de
   * negocio de una fase futura, sin ejecutarse aquí.
   */
  async handleOutboundEvent(
    eventName: string,
    payload: unknown,
    events: readonly NormalizedKapsoEvent[],
  ): Promise<void> {
    if (eventName !== 'whatsapp.message.sent') {
      logger.log(`agent_outbound_deferred event=${eventName}`);
      return;
    }

    const provenance = classifyOutboundProvenance(payload);
    if (provenance !== 'human_business_app') {
      logger.log(`agent_outbound_deferred event=${eventName} provenance=${provenance}`);
      return;
    }

    const last = events[events.length - 1];
    if (!last) return;

    const message = toAgentInboundMessage(last);
    const env = this.readAgentEnv();
    const result = await handleHumanTakeover(
      message,
      this.repository,
      undefined,
      env.humanTakeoverPauseMinutes,
    );
    logger.log(`agent_human_takeover result=${result.result}`);
  }

  /** Resume manual de una conversación pausada, por API interna. */
  resumeConversationByPhone(customerPhone: string): Promise<ResumeAgentResult> {
    return resumeAgentConversation(customerPhone, this.repository);
  }
}
