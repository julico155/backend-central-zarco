/**
 * Puerto del MODELO. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/model.ts, Fase 6D.2F.3): el core no conoce OpenAI,
 * habla con esta interfaz. El adaptador real vive en `../openai/adapter.ts`.
 *
 * Sin streaming: WhatsApp recibe un único mensaje ya terminado.
 */

export type AgentModelRole = 'system' | 'user' | 'assistant';

/**
 * Partes de un mensaje MULTIMODAL. Nombres tal como los usa la Responses API
 * (`input_text`, `input_image`): el adaptador los envía tal cual.
 */
export type AgentModelContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'auto' | 'low' | 'high' };

export interface AgentModelMessage {
  role: AgentModelRole;
  content: string | readonly AgentModelContentPart[];
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentToolCall {
  callId: string;
  name: string;
  arguments: string;
}

export type AgentModelInput =
  | AgentModelMessage
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

/**
 * Errores del modelo, ya saneados. NUNCA llevan el cuerpo de la respuesta, ni
 * la clave, ni el prompt: van a `agent_runs.error_code`, cuyo CHECK solo
 * admite `[A-Za-z0-9._:-]{1,64}`.
 */
export type AgentModelError =
  | 'not_configured'
  | 'timeout'
  | 'network_error'
  | 'http_error'
  | 'invalid_response'
  | 'empty_response'
  | 'incomplete_response'
  | 'refused'
  | 'provider_failed';

export type AgentModelResult =
  | { ok: true; text: string; model: string; toolCalls?: readonly AgentToolCall[] }
  | { ok: false; error: AgentModelError; status?: number };

export type AgentToolChoice = 'auto' | 'required' | 'none';

export interface AgentModelOptions {
  maxOutputTokens?: number;
  timeoutMs?: number;
  tools?: readonly AgentToolDefinition[];
  toolChoice?: AgentToolChoice;
  parallelToolCalls?: boolean;
}

export interface AgentModel {
  readonly model: string;
  complete(
    messages: readonly AgentModelInput[],
    options?: AgentModelOptions,
  ): Promise<AgentModelResult>;
}
