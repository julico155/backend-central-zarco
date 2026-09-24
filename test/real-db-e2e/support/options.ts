import { randomUUID } from 'node:crypto';

/** Prefijo de TODO identificador que crea el E2E (source_message_id, event_id, códigos, nombres). */
export const E2E_PREFIX = 'e2e-';

export class E2EGuardError extends Error {
  constructor(message: string) {
    super(`E2E abortado: ${message}`);
    this.name = 'E2EGuardError';
  }
}

export interface E2EOptions {
  /** Identifica esta corrida; entra en los event_id / wamid / nombres de fixtures. */
  runId: string;
  /** Teléfono E2E dedicado (solo dígitos). */
  phone: string;
  centralUrl: string;
  agentUrl: string;
  manifestPath: string;
  /** ALLOW_OPEN_REAL_CASH_REGISTER=true: usa la caja real abierta (solo avanza su correlativo). */
  allowOpenRealCashRegister: boolean;
  /** Application names ajenos que el operador decidió tolerar en pg_stat_activity (lista explícita). */
  ignoredApplicationNames: string[];
}

const PHONE_RE = /^[0-9]{8,15}$/;

/**
 * Guardas de arranque, ANTES de abrir cualquier conexión: el E2E contra las DB
 * reales exige consentimiento explícito y un teléfono dedicado.
 */
export function readE2EOptions(env: NodeJS.ProcessEnv = process.env): E2EOptions {
  if (env.ALLOW_REAL_DB_E2E !== 'true') {
    throw new E2EGuardError(
      'falta ALLOW_REAL_DB_E2E=true (consentimiento explícito de escribir en las DB reales).',
    );
  }
  const phone = (env.E2E_PHONE ?? '').trim();
  if (!PHONE_RE.test(phone)) {
    throw new E2EGuardError(
      'E2E_PHONE debe ser un teléfono dedicado de prueba, solo dígitos (8 a 15).',
    );
  }
  const centralUrl = env.DATABASE_URL ?? '';
  const agentUrl = env.AGENT_DATABASE_URL ?? '';
  if (!centralUrl || !agentUrl) {
    throw new E2EGuardError('DATABASE_URL y AGENT_DATABASE_URL deben estar definidas.');
  }
  if (centralUrl === agentUrl) {
    throw new E2EGuardError(
      'DATABASE_URL y AGENT_DATABASE_URL son la misma: deben ser dos bases distintas.',
    );
  }
  return {
    runId: (env.E2E_RUN_ID ?? randomUUID().slice(0, 8)).replace(/[^a-zA-Z0-9]/g, ''),
    phone,
    centralUrl,
    agentUrl,
    manifestPath: env.E2E_MANIFEST_PATH ?? 'e2e-manifest.jsonl',
    allowOpenRealCashRegister: env.ALLOW_OPEN_REAL_CASH_REGISTER === 'true',
    ignoredApplicationNames: (env.E2E_IGNORED_APPLICATION_NAMES ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** Agrega `application_name` a una URL de conexión sin imprimirla jamás. */
export function withApplicationName(url: string, applicationName: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('application_name', applicationName);
  return parsed.toString();
}
