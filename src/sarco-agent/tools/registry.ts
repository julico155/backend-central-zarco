import type { AgentToolCall, AgentToolDefinition } from '../core/model';

/**
 * Registro y ejecución de herramientas. Puerto directo de sarcoRestaurant
 * (src/lib/agent/tools/registry.ts, Fase 6D.2F.5B).
 *
 * El modelo entiende la intención; las herramientas consultan y solicitan; el
 * BACKEND conserva la autoridad: el modelo elige QUÉ herramienta llamar, y
 * nada más.
 *
 * Todo fallo es FAIL-SAFE: una tool desconocida o unos argumentos inválidos
 * no tumban el turno, devuelven un resultado de error que el modelo puede
 * leer.
 */

/** Contexto del turno. Lo pone el core, NUNCA el modelo. */
export interface AgentToolContext {
  customerPhone: string;
  sourceMessageId: string;
  phoneNumberId: string | null;
  /** Texto REAL del entrante que abrió el turno. Viene del payload del proveedor, no del modelo. */
  inboundText: string;
}

export interface AgentToolOutcome {
  /** Lo que ve el modelo. Serializable a JSON. Nunca secretos. */
  result: unknown;
  /** ¿Produjo un efecto que el CLIENTE ve, ya confirmado por el backend? */
  userVisibleEffectConfirmed?: boolean;
  /** ¿Hay que callar al agente DESPUÉS de que salga el texto de este turno? */
  silenceAfterReply?: boolean;
}

export interface AgentTool {
  definition: AgentToolDefinition;
  /** ¿Esta herramienta PUEDE producir un efecto que el cliente ve? Declaración estática. */
  producesUserVisibleEffect?: boolean;
  /** ¿El efecto confirmado de esta herramienta ES la respuesta al cliente? */
  effectCompletesTurn?: boolean;
  /** Sin `execute`: decisión que no ejecuta nada. */
  execute?(context: AgentToolContext): Promise<AgentToolOutcome>;
}

export type AgentToolRegistry = readonly AgentTool[];

export function findAgentTool(name: string, registry: AgentToolRegistry): AgentTool | null {
  return registry.find((t) => t.definition.name === name) ?? null;
}

export interface ExecutedTool {
  callId: string;
  name: string;
  /** JSON serializado. Es lo único que el modelo llega a ver. */
  output: string;
  ok: boolean;
  userVisibleEffectConfirmed: boolean;
  silenceAfterReply: boolean;
}

/** Esquema de una tool SIN argumentos, en la forma que exige `strict: true`. */
export const NO_ARGUMENTS = {
  type: 'object',
  properties: {},
  required: [],
  additionalProperties: false,
} as const;

export function hasNoArguments(rawArguments: string): boolean {
  const trimmed = rawArguments.trim();
  if (trimmed === '' || trimmed === '{}') return true;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
  return Object.keys(parsed as Record<string, unknown>).length === 0;
}

export async function executeToolCall(
  call: AgentToolCall,
  registry: AgentToolRegistry,
  context: AgentToolContext,
): Promise<ExecutedTool> {
  const tool = registry.find((t) => t.definition.name === call.name);

  if (!tool) {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'unknown_tool' }),
      userVisibleEffectConfirmed: false,
      silenceAfterReply: false,
    };
  }

  if (!hasNoArguments(call.arguments)) {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'invalid_arguments' }),
      userVisibleEffectConfirmed: false,
      silenceAfterReply: false,
    };
  }

  if (typeof tool.execute !== 'function') {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'not_executable' }),
      userVisibleEffectConfirmed: false,
      silenceAfterReply: false,
    };
  }

  try {
    const outcome = await tool.execute(context);
    return {
      callId: call.callId,
      name: call.name,
      ok: true,
      output: JSON.stringify(outcome.result),
      userVisibleEffectConfirmed: outcome.userVisibleEffectConfirmed === true,
      silenceAfterReply: outcome.silenceAfterReply === true,
    };
  } catch {
    return {
      callId: call.callId,
      name: call.name,
      ok: false,
      output: JSON.stringify({ error: 'tool_failed' }),
      userVisibleEffectConfirmed: false,
      silenceAfterReply: false,
    };
  }
}
