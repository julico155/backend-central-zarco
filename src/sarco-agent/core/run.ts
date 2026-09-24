import { Logger } from '@nestjs/common';
import { classifyKapsoSendFailure } from '../../kapso/kapso-send-outcome';
import {
  buildSelectionContext,
  buildWorkingContext,
  contextWindowStart,
  CONTEXT_MAX_MESSAGES,
} from './context';
import { evaluateAgentEligibility, type AgentEligibilityConfig } from './eligibility';
import { isPauseActive } from '../control/pause-gate';
import type {
  AgentModel,
  AgentModelContentPart,
  AgentModelInput,
  AgentModelMessage,
  AgentModelResult,
} from './model';
import { createTurnMediaBudget, type MediaResolverPort, type TurnMediaLimits } from './media';
import { executeToolCall, findAgentTool, hasNoArguments, type AgentTool } from '../tools/registry';
import type {
  AgentInboundMessage,
  AgentRunStore,
  AgentSendPort,
  AgentSendResult,
  AgentStore,
  AgentTurnResult,
} from './types';

/**
 * AGENT CORE — ejecución de un turno. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/run.ts, Fases 6D.2F.3 y 6D.2F.5B.1), sin cambios de
 * comportamiento salvo el logging (NestJS Logger en vez de `@/lib/log`) y el
 * tipo del mensaje entrante (`AgentInboundMessage` en vez de
 * `ProvenanceMessage`, ver `./types.ts`).
 *
 * Orden, y el porqué de cada paso:
 *
 *   1. ELEGIBILIDAD — flags y teléfono. Un `no` no toca la base ni crea run.
 *   2. DATOS MÍNIMOS — sin teléfono o sin WAMID no hay identidad ni idempotencia.
 *   3. CONVERSACIÓN — debe existir ya: la creó la persistencia del entrante.
 *   4. CLAIM DEL RUN — barrera de idempotencia ANTES de gastar un solo token.
 *   5. PAUSA — si un humano tiene el control, el run muere en `skipped_paused`.
 *   6. CONTEXTO — ventana corta, no el historial entero.
 *   7. SELECCIÓN DE ACCIÓN — el modelo elige UNA capacidad, sin escribir nada.
 *   8. EJECUCIÓN — la acción elegida, si tiene algo que ejecutar.
 *   9. REDACCIÓN — solo si después de actuar queda algo que decir.
 *  10. `sending` — se marca ANTES de enviar, para que un crash no parezca éxito.
 *  11. ENVÍO y persistencia del saliente de IA.
 *
 * Lo que este módulo NO hace y no debe hacer nunca: crear pedidos, calcular
 * precios, cotizar delivery, tocar GPS, generar QR, confirmar pagos, cambiar
 * estados de pedido ni enviar el menú. Sus únicas dependencias son un store,
 * un modelo y un `sendText`.
 */

const logger = new Logger('SarcoAgentRun');

export interface AgentTurnDeps {
  store: AgentStore;
  runs: AgentRunStore;
  model: AgentModel;
  send: AgentSendPort;
  config: AgentEligibilityConfig;
  /** Identidad del negocio. Viene del Business Adapter, no del core. */
  systemPrompt: string;
  maxOutputTokens?: number;
  /** Acciones entre las que el modelo elige UNA. Ausentes = el modelo solo escribe. */
  actions?: readonly AgentTool[];
  /** Resolutor de imágenes. Ausente = el turno no mira ninguna foto. */
  media?: MediaResolverPort;
  mediaLimits?: TurnMediaLimits;
  /**
   * Callar la conversación DESPUÉS de un envío ya confirmado. Ausente = nada
   * calla. NUNCA lanza, y su resultado se ignora.
   */
  silenceAfterReply?: (input: {
    customerPhone: string;
    sourceMessageId: string;
    inboundText: string;
  }) => Promise<void>;
  now?: () => string;
}

/**
 * El BURST: los entrantes del cliente que llegaron en ESTA entrega, en su
 * orden original. Ausente = burst de uno, el propio ancla.
 */
export type AgentTurnBurst = readonly AgentInboundMessage[];

/**
 * Resuelve las imágenes del burst en su ORDEN ORIGINAL, dentro del
 * presupuesto del turno. Todo lo que puede salir mal cuenta como fallo, nunca
 * como una descripción inventada ni como una excepción que tumbe el turno.
 */
async function resolveBurstImages(
  burst: AgentTurnBurst,
  deps: AgentTurnDeps,
  runId: string,
  nowMs: () => number,
): Promise<{ parts: AgentModelContentPart[]; failures: number }> {
  const parts: AgentModelContentPart[] = [];
  let requested = 0;
  let failures = 0;

  const budget = createTurnMediaBudget({ limits: deps.mediaLimits, now: nowMs });

  const fallo = (error: string, durationMs?: number): void => {
    failures += 1;
    logger.warn(
      `agent_image_resolved runId=${runId} ok=false error=${error}${
        durationMs === undefined ? '' : ` duration_ms=${durationMs}`
      }`,
    );
  };

  for (const [index, mensaje] of burst.entries()) {
    const adjunto = mensaje.image;
    if (!adjunto) continue;
    requested += 1;

    logger.log(
      `agent_image_received runId=${runId} mime_type=${adjunto.mimeType ?? 'null'} has_caption=${
        adjunto.caption !== null
      } batch_index=${index}`,
    );

    if (!deps.media) {
      fallo('not_configured');
      continue;
    }

    // Sin tamaño declarado (el normalizador de Kapso no lo trae): el presupuesto
    // se cierra con los bytes REALES en `account`, no aquí.
    const sitio = budget.admit(null);
    if (!sitio.ok) {
      fallo(sitio.error);
      continue;
    }

    const empezado = nowMs();
    const resuelto = await deps.media.resolveImage(adjunto, mensaje.providerPhoneNumberId, {
      timeoutMs: sitio.timeoutMs,
    });
    const duracion = nowMs() - empezado;

    if (!resuelto.ok) {
      fallo(resuelto.error, duracion);
      continue;
    }

    const contabilizado = budget.account(resuelto.byteSize);
    if (!contabilizado.ok) {
      fallo(contabilizado.error, duracion);
      continue;
    }

    logger.log(
      `agent_image_resolved runId=${runId} ok=true source=${resuelto.source} duration_ms=${duracion} byte_size=${resuelto.byteSize} mime_type=${resuelto.mimeType}`,
    );
    parts.push({ type: 'input_image', image_url: resuelto.dataUrl, detail: 'auto' });
  }

  if (requested > 0) {
    logger.log(
      `agent_multimodal_request runId=${runId} image_count_requested=${requested} image_count_resolved=${parts.length} image_count_unavailable=${failures} total_image_bytes=${budget.totalBytes()}`,
    );
  }

  return { parts, failures };
}

export const SELECTION_ROUND = 1;

export type SelectionFailure =
  | 'selection.no_action'
  | 'selection.multiple_actions'
  | 'selection.unknown_action'
  | 'selection.invalid_arguments';

export function classifySendFailure(
  result: Extract<AgentSendResult, { ok: false }>,
): 'failed' | 'send_unknown' {
  return classifyKapsoSendFailure(result.error, result.status);
}

/**
 * ¿Este mensaje puede FORMAR un turno del agente? SOLO TEXTO E IMAGEN. Esta
 * fase no transcribe audio ni lee documentos.
 */
export function isAgentEligibleContent(message: AgentInboundMessage): boolean {
  if (message.contentType === 'text') {
    return message.content !== null && message.content.trim() !== '';
  }
  if (message.contentType === 'image') {
    const tieneCaption = message.content !== null && message.content.trim() !== '';
    return tieneCaption || message.image != null;
  }
  return false;
}

export function inboundTextOf(message: AgentInboundMessage): string {
  return message.content ?? '';
}

export const MEDIA_FAILURE_NOTICE =
  'Evento del canal: el cliente envió una imagen que no se pudo procesar. ' +
  'No afirmes nada sobre su contenido visual.';

export async function runAgentTurn(
  message: AgentInboundMessage,
  deps: AgentTurnDeps,
  burst?: AgentTurnBurst,
): Promise<AgentTurnResult> {
  const now = deps.now ?? (() => new Date().toISOString());
  const nowMs = (): number => new Date(now()).getTime();

  // 1. Elegibilidad. Antes de la base: un mensaje no elegible no deja rastro.
  const eligibility = evaluateAgentEligibility(message.customerPhone, deps.config);
  if (eligibility !== 'eligible') {
    return { result: 'skipped', reason: eligibility };
  }

  // 2. Datos mínimos.
  if (message.customerPhone === '') {
    return { result: 'skipped', reason: 'missing_phone' };
  }
  if (message.providerMessageId === null) {
    return { result: 'skipped', reason: 'missing_message_id' };
  }
  const sourceMessageId = message.providerMessageId;

  // 2b. ¿Aporta este LOTE algo del cliente?
  if (!(burst ?? [message]).some(isAgentEligibleContent)) {
    return { result: 'skipped', reason: 'unsupported_content' };
  }

  // 3. La conversación ya existe: la creó la persistencia del entrante.
  const conversation = await deps.store.findPauseStateByPhone(message.customerPhone);
  if (conversation === null) {
    return { result: 'skipped', reason: 'no_conversation' };
  }

  // 4. Claim. Barrera de idempotencia, ANTES del modelo.
  const sourceAgentMessageId = await deps.runs.findMessageIdByProviderMessageId(sourceMessageId);

  const claim = await deps.runs.claimRun({
    agentConversationId: conversation.conversationId,
    sourceMessageId,
    sourceAgentMessageId,
    model: deps.model.model,
  });

  if (claim.result === 'exists') {
    return { result: 'duplicate', runId: claim.runId, status: claim.status };
  }
  const runId = claim.runId;

  // 5. Barrera de pausa.
  if (isPauseActive(conversation, now())) {
    await deps.runs.finishRun({
      runId,
      status: 'skipped_paused',
      completedAt: now(),
      skippedAtBarrier: 'pre_openai',
    });
    return { result: 'skipped', reason: 'paused', runId };
  }

  // 6. Ventanas de contexto.
  const history = await deps.runs.loadRecentMessages(
    conversation.conversationId,
    contextWindowStart(now()),
    CONTEXT_MAX_MESSAGES,
  );
  const inboundText = inboundTextOf(message);
  const { parts: imageParts, failures: imageFailures } = await resolveBurstImages(
    burst ?? [message],
    deps,
    runId,
    nowMs,
  );

  const inboundParts: AgentModelContentPart[] = [...imageParts];
  if (imageParts.length > 0 && inboundText !== '') {
    inboundParts.push({ type: 'input_text', text: inboundText });
  }
  const inboundMultimodal: AgentModelMessage | null =
    inboundParts.length > 0 ? { role: 'user', content: inboundParts } : null;

  const messages: AgentModelInput[] = [
    { role: 'system', content: deps.systemPrompt },
    ...buildWorkingContext(history, {
      dropTrailingUserText: inboundMultimodal !== null && inboundText !== '' ? inboundText : null,
    }),
    ...(inboundMultimodal ? [inboundMultimodal] : []),
  ];

  if (imageFailures > 0) {
    messages.push({ role: 'system', content: MEDIA_FAILURE_NOTICE });
  }

  const actions = deps.actions ?? [];
  let toolRounds = 0;
  let finalText = '';
  let resolvedModel = deps.model.model;
  let userVisibleEffectConfirmed = false;
  let silenceRequested = false;

  const finishSilently = async (): Promise<AgentTurnResult> => {
    await deps.runs.finishRun({
      runId,
      status: 'completed',
      completedAt: now(),
      model: resolvedModel,
      toolRounds,
    });
    return { result: 'completed_silent', runId };
  };

  const pausedNow = async (): Promise<boolean> => {
    const current = await deps.store.findPauseStateByPhone(message.customerPhone);
    return isPauseActive(current, now());
  };

  const finishForPause = async (): Promise<AgentTurnResult> => {
    if (userVisibleEffectConfirmed) return finishSilently();

    await deps.runs.finishRun({
      runId,
      status: 'skipped_paused',
      completedAt: now(),
      skippedAtBarrier: 'pre_send',
    });
    return { result: 'skipped', reason: 'paused', runId };
  };

  const finishForModelError = async (
    completion: Extract<AgentModelResult, { ok: false }>,
  ): Promise<AgentTurnResult> => {
    if (completion.error === 'empty_response' && userVisibleEffectConfirmed) {
      return finishSilently();
    }

    const errorCode =
      completion.error === 'http_error' && completion.status !== undefined
        ? `model.http_error.${completion.status}`
        : `model.${completion.error}`;
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode,
      toolRounds,
    });
    return { result: 'failed', runId, error: errorCode };
  };

  const finishForSelectionFailure = async (
    errorCode: SelectionFailure,
  ): Promise<AgentTurnResult> => {
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode,
      toolRounds,
    });
    logger.warn(`agent_action_selection_invalid runId=${runId} error=${errorCode}`);
    return { result: 'failed', runId, error: errorCode };
  };

  if (actions.length === 0) {
    const completion: AgentModelResult = await deps.model.complete(messages, {
      maxOutputTokens: deps.maxOutputTokens,
    });
    if (!completion.ok) return finishForModelError(completion);
    resolvedModel = completion.model;
    finalText = completion.text;
  } else {
    // ── 7. RONDA DE SELECCIÓN ────────────────────────────────────────────────
    const selection = await deps.model.complete(
      [
        { role: 'system', content: deps.systemPrompt },
        ...buildSelectionContext(history, {
          inboundText,
          inboundParts: inboundMultimodal?.content,
        }),
        ...(imageFailures > 0 ? [{ role: 'system' as const, content: MEDIA_FAILURE_NOTICE }] : []),
      ],
      {
        maxOutputTokens: deps.maxOutputTokens,
        tools: actions.map((a) => a.definition),
        toolChoice: 'required',
        parallelToolCalls: false,
      },
    );

    if (!selection.ok) return finishForModelError(selection);
    resolvedModel = selection.model;
    toolRounds = SELECTION_ROUND;

    const calls = selection.toolCalls ?? [];
    if (calls.length !== 1) {
      return finishForSelectionFailure(
        calls.length === 0 ? 'selection.no_action' : 'selection.multiple_actions',
      );
    }
    const call = calls[0];

    const action = findAgentTool(call.name, actions);
    if (action === null) return finishForSelectionFailure('selection.unknown_action');
    if (!hasNoArguments(call.arguments)) {
      return finishForSelectionFailure('selection.invalid_arguments');
    }

    logger.log(`agent_action_selected runId=${runId} action=${call.name} round=${SELECTION_ROUND}`);

    // ── 8. EJECUCIÓN ─────────────────────────────────────────────────────────
    if (typeof action.execute === 'function') {
      if (action.producesUserVisibleEffect === true && (await pausedNow())) {
        return finishForPause();
      }

      const executed = await executeToolCall(call, actions, {
        customerPhone: message.customerPhone,
        sourceMessageId,
        phoneNumberId: message.providerPhoneNumberId,
        inboundText,
      });
      userVisibleEffectConfirmed = executed.userVisibleEffectConfirmed;
      silenceRequested = executed.silenceAfterReply;
      logger.log(
        `agent_tool_call runId=${runId} tool=${executed.name} ok=${executed.ok} round=${SELECTION_ROUND}`,
      );

      if (action.effectCompletesTurn === true && executed.userVisibleEffectConfirmed) {
        return finishSilently();
      }

      messages.push(
        { type: 'function_call', call_id: call.callId, name: call.name, arguments: call.arguments },
        { type: 'function_call_output', call_id: executed.callId, output: executed.output },
      );
    }

    // ── 9. RONDA DE REDACCIÓN ────────────────────────────────────────────────
    const reply = await deps.model.complete(messages, {
      maxOutputTokens: deps.maxOutputTokens,
      toolChoice: 'none',
    });
    if (!reply.ok) return finishForModelError(reply);
    resolvedModel = reply.model;
    finalText = reply.text;
  }

  if (finalText.trim() === '') {
    if (userVisibleEffectConfirmed) {
      return finishSilently();
    }
    await deps.runs.finishRun({
      runId,
      status: 'failed',
      completedAt: now(),
      errorCode: 'model.empty_response',
      toolRounds,
    });
    return { result: 'failed', runId, error: 'model.empty_response' };
  }

  // BARRERA PRE-SEND (B).
  if (await pausedNow()) {
    return finishForPause();
  }

  // 10. `sending` antes del envío.
  await deps.runs.markRunSending(runId);

  // 11. Envío.
  const sent = await deps.send.sendText(
    message.customerPhone,
    finalText,
    message.providerPhoneNumberId,
  );

  if (!sent.ok) {
    const status = classifySendFailure(sent);
    const errorCode = `send.${sent.error}`;
    await deps.runs.finishRun({ runId, status, completedAt: now(), errorCode, toolRounds });
    return status === 'failed'
      ? { result: 'failed', runId, error: errorCode }
      : { result: 'send_unknown', runId, error: errorCode };
  }

  // EL SILENCIO VA AQUÍ, Y SOLO AQUÍ: después del WAMID, con el mensaje ya en
  // el teléfono del cliente.
  if (silenceRequested && deps.silenceAfterReply) {
    try {
      await deps.silenceAfterReply({
        customerPhone: message.customerPhone,
        sourceMessageId,
        inboundText,
      });
    } catch {
      logger.warn(`agent_silence_after_reply_failed runId=${runId}`);
    }
  }

  const messageTimestamp = now();
  try {
    await deps.store.insertMessage({
      agentConversationId: conversation.conversationId,
      providerMessageId: sent.wamid,
      providerConversationId: message.providerConversationId,
      direction: 'outbound',
      role: 'assistant',
      actor: 'ai',
      content: finalText,
      contentType: 'text',
      metadata: null,
      messageTimestamp,
    });
    await deps.runs.touchAiMessageAt(conversation.conversationId, messageTimestamp);
  } catch {
    await deps.runs.finishRun({
      runId,
      status: 'send_unknown',
      completedAt: now(),
      errorCode: 'persist.ai_message_failed',
      model: resolvedModel,
      toolRounds,
    });
    return { result: 'send_unknown', runId, error: 'persist.ai_message_failed' };
  }

  const responseMessageId = await deps.runs.findMessageIdByProviderMessageId(sent.wamid);

  await deps.runs.finishRun({
    runId,
    status: 'completed',
    completedAt: now(),
    responseMessageId,
    model: resolvedModel,
    toolRounds,
  });

  return { result: 'replied', runId };
}
