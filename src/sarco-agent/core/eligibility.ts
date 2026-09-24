/**
 * Puerta de elegibilidad del agente. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/eligibility.ts, Fase 6D.2F.3), sin cambios de
 * comportamiento: allowlist cerrada por defecto, `AI_ACCESS_MODE=all` es la
 * única forma explícita de abrir el agente a cualquier cliente.
 */

export type AgentAccessMode = 'allowlist' | 'all';

export interface AgentEligibilityConfig {
  /** Interruptor general. Solo `true` enciende el agente. */
  enabled: boolean;
  accessMode: AgentAccessMode;
  /** Teléfonos admitidos, ya normalizados a dígitos. Lista VACÍA = nadie. */
  testPhones: readonly string[];
  /** ¿Hay clave de OpenAI configurada? Sin ella no se intenta llamar. */
  hasApiKey: boolean;
}

export type AgentEligibility = 'eligible' | 'disabled' | 'not_configured' | 'phone_not_allowed';

function normalizePhone(value: string): string {
  return value.replace(/\D+/g, '');
}

/** Lee la allowlist de teléfonos desde su forma de entorno: números separados por coma. */
export function parseTestPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const permitidos: string[] = [];
  for (const entrada of raw.split(',')) {
    const digitos = normalizePhone(entrada.trim());
    if (digitos !== '' && !permitidos.includes(digitos)) permitidos.push(digitos);
  }
  return permitidos;
}

/** SOLO la cadena exacta `'all'` abre el agente. Todo lo demás cae en `allowlist`. */
export function parseAccessMode(raw: string | null | undefined): AgentAccessMode {
  return raw === 'all' ? 'all' : 'allowlist';
}

/**
 * Decide si un mensaje entrante puede llegar al agente. Un `no` no crea
 * `agent_runs`. Es la PRIMERA barrera, no la única.
 */
export function evaluateAgentEligibility(
  customerPhone: string,
  config: AgentEligibilityConfig,
): AgentEligibility {
  if (!config.enabled) return 'disabled';
  if (!config.hasApiKey) return 'not_configured';
  if (customerPhone === '') return 'phone_not_allowed';

  if (config.accessMode === 'all') return 'eligible';

  if (config.testPhones.length === 0) return 'phone_not_allowed';
  return config.testPhones.includes(customerPhone) ? 'eligible' : 'phone_not_allowed';
}
