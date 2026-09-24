import type {
  AgentModel,
  AgentModelInput,
  AgentModelOptions,
  AgentModelResult,
  AgentToolCall,
} from '../core/model';

/**
 * Adaptador de OpenAI (Responses API). Puerto directo de sarcoRestaurant
 * (src/lib/agent/openai/adapter.ts, Fase 6D.2F.3.1), con una única
 * diferencia deliberada: la validación de la respuesta se hace con guards
 * manuales en vez de zod, porque Backend Central no tiene esa dependencia y
 * el resto del repo ya valida `unknown` así (ver `kapso-normalizer.ts`). El
 * comportamiento es el mismo: campos desconocidos se ignoran, una forma que
 * no calza produce `invalid_response`.
 *
 * `fetch` inyectable, timeout explícito con AbortController. No se usa el SDK
 * oficial: la superficie que se necesita es UN POST.
 *
 * `output_text` es una comodidad del SDK, no un campo de primer nivel fiable
 * en el JSON crudo. Con fetch directo hay que recorrer la estructura real:
 *
 *   output[]                      ← puede traer `reasoning`, `web_search_call`…
 *     └─ item.type === 'message'
 *          └─ content[]           ← puede traer `refusal` junto a texto
 *               └─ item.type === 'output_text'
 *                    └─ .text
 *
 * Por eso NO se indexa `output[0]` ni `content[0]`: con modelos de
 * razonamiento el primer elemento suele NO ser el mensaje.
 *
 * Nunca se registra ni se devuelve la clave, el prompt ni el cuerpo de la
 * respuesta: el error sale como código corto porque acaba en
 * `agent_runs.error_code`, cuyo CHECK solo admite `[A-Za-z0-9._:-]{1,64}`.
 */

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
export const OPENAI_DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 20_000;

export const OPENAI_DEFAULT_MAX_OUTPUT_TOKENS = 300;
export const OPENAI_DEFAULT_REASONING_EFFORT = 'none';
export const OPENAI_DEFAULT_VERBOSITY = 'low';

/**
 * ¿Este modelo admite `reasoning.effort` y `text.verbosity`? Solo la familia
 * `gpt-5.x`: mandarlos a un modelo que no los conoce es un 400.
 */
export function supportsResponseTuning(model: string): boolean {
  return /^gpt-5\.\d/.test(model);
}

interface RawResponseContentItem {
  type: string;
  text?: string;
  refusal?: string;
}

interface RawResponseOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: RawResponseContentItem[];
}

interface RawResponse {
  model?: string;
  status?: string;
  output?: RawResponseOutputItem[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Valida la FORMA mínima que este adaptador consume; todo lo demás se ignora. */
function parseRawResponse(json: unknown): RawResponse | null {
  if (!isRecord(json)) return null;

  const output = json.output;
  if (output !== undefined) {
    if (!Array.isArray(output)) return null;
    for (const item of output) {
      if (!isRecord(item) || typeof item.type !== 'string') return null;
      if (item.content !== undefined) {
        if (!Array.isArray(item.content)) return null;
        for (const part of item.content) {
          if (!isRecord(part) || typeof part.type !== 'string') return null;
        }
      }
    }
  }

  return {
    model: optionalString(json.model),
    status: optionalString(json.status),
    output: Array.isArray(output)
      ? output.map((item) => {
          const record = item as Record<string, unknown>;
          return {
            type: record.type as string,
            call_id: optionalString(record.call_id),
            name: optionalString(record.name),
            arguments: optionalString(record.arguments),
            content: Array.isArray(record.content)
              ? (record.content as Record<string, unknown>[]).map((part) => ({
                  type: part.type as string,
                  text: optionalString(part.text),
                  refusal: optionalString(part.refusal),
                }))
              : undefined,
          };
        })
      : undefined,
  };
}

/**
 * Recorre la estructura completa: nunca asume posiciones. `output[]` mezcla
 * items de tipos distintos y el orden no está garantizado. Se clasifica POR
 * TIPO y se ignora en silencio lo desconocido.
 */
function extractOutput(parsed: RawResponse): {
  text: string;
  refused: boolean;
  toolCalls: AgentToolCall[];
} {
  const chunks: string[] = [];
  const toolCalls: AgentToolCall[] = [];
  let refused = false;

  for (const item of parsed.output ?? []) {
    if (item.type === 'function_call') {
      if (typeof item.call_id === 'string' && typeof item.name === 'string') {
        toolCalls.push({
          callId: item.call_id,
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : '{}',
        });
      }
      continue;
    }

    if (item.type !== 'message') continue;

    for (const part of item.content ?? []) {
      if (part.type === 'output_text' && typeof part.text === 'string') {
        chunks.push(part.text);
      } else if (part.type === 'refusal') {
        refused = true;
      }
    }
  }

  return { text: chunks.join('').trim(), refused, toolCalls };
}

export interface OpenAiAdapterConfig {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
  /** `reasoning.effort`. Sin valor usa el de por defecto; `null` lo desactiva. */
  reasoningEffort?: string | null;
  /** `text.verbosity`. Mismas reglas. */
  verbosity?: string | null;
  /** Inyectable en pruebas; por defecto el fetch global. */
  fetchImpl?: typeof fetch;
}

export function createOpenAiModel(cfg: OpenAiAdapterConfig): AgentModel {
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const model = cfg.model ?? OPENAI_DEFAULT_MODEL;
  const defaultTimeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const tunable = supportsResponseTuning(model);
  const reasoningEffort =
    cfg.reasoningEffort === undefined ? OPENAI_DEFAULT_REASONING_EFFORT : cfg.reasoningEffort;
  const verbosity = cfg.verbosity === undefined ? OPENAI_DEFAULT_VERBOSITY : cfg.verbosity;

  return {
    model,

    async complete(
      messages: readonly AgentModelInput[],
      options: AgentModelOptions = {},
    ): Promise<AgentModelResult> {
      if (!cfg.apiKey || messages.length === 0) {
        return { ok: false, error: 'not_configured' };
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? defaultTimeoutMs);

      const body: Record<string, unknown> = {
        model,
        input: messages,
        max_output_tokens: options.maxOutputTokens ?? OPENAI_DEFAULT_MAX_OUTPUT_TOKENS,
        stream: false,
        store: false,
      };
      if (tunable && reasoningEffort) body.reasoning = { effort: reasoningEffort };
      if (tunable && verbosity) body.text = { verbosity };

      if (options.tools && options.tools.length > 0) {
        body.tools = options.tools.map((tool) => ({
          type: 'function',
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
          strict: true,
        }));
        if (options.toolChoice !== undefined) body.tool_choice = options.toolChoice;
        if (options.parallelToolCalls !== undefined) {
          body.parallel_tool_calls = options.parallelToolCalls;
        }
      }

      try {
        const res = await fetchImpl(OPENAI_RESPONSES_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!res.ok) return { ok: false, error: 'http_error', status: res.status };

        let json: unknown;
        try {
          json = await res.json();
        } catch {
          return { ok: false, error: 'invalid_response' };
        }

        const parsed = parseRawResponse(json);
        if (parsed === null) return { ok: false, error: 'invalid_response' };

        if (parsed.status === 'failed') {
          return { ok: false, error: 'provider_failed' };
        }

        const { text, refused, toolCalls } = extractOutput(parsed);

        if (parsed.status === 'incomplete') {
          return { ok: false, error: 'incomplete_response' };
        }

        if (toolCalls.length > 0) {
          return { ok: true, text, model: parsed.model ?? model, toolCalls };
        }

        if (text === '' && refused) return { ok: false, error: 'refused' };
        if (text === '') return { ok: false, error: 'empty_response' };

        return { ok: true, text, model: parsed.model ?? model };
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          return { ok: false, error: 'timeout' };
        }
        return { ok: false, error: 'network_error' };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
