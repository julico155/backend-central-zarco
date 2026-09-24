export interface WriteRecord {
  sql: string;
  parameters: readonly unknown[];
}

/** Tablas que la aplicación PUEDE escribir durante este flujo. Cualquier otra es una violación. */
export const CENTRAL_WRITE_ALLOWLIST = new Set([
  'notification_jobs',
  'bank_qr_charges',
  'payment_attempts',
  'order_items',
  'order_promotions',
  'orders',
  'idempotency_keys',
  'customers',
  'cash_register_sessions',
]);

export const AGENT_WRITE_ALLOWLIST = new Set([
  'webhook_events',
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_control_events',
  'menu_sessions',
  'menu_send_deliveries',
]);

const MUTATION = /^\s*(insert\s+into|update|delete\s+from)\s+"?([a-z_][a-z0-9_]*)"?/i;

export function isMutation(sql: string): boolean {
  return MUTATION.test(sql);
}

/** Registrador para `Kysely({ log })`: guarda solo las sentencias que escriben. */
export class WriteAudit {
  readonly writes: WriteRecord[] = [];

  log = (event: {
    level: string;
    query: { sql: string; parameters: readonly unknown[] };
  }): void => {
    if (event.level === 'query' && isMutation(event.query.sql)) {
      this.writes.push({ sql: event.query.sql, parameters: event.query.parameters });
    }
  };
}

/**
 * Comprueba lo que la aplicación escribió: (1) solo en tablas permitidas, y
 * (2) todo UPDATE/DELETE apunta a un id registrado del E2E, al teléfono E2E o a
 * un identificador `e2e-`. Devuelve una línea por violación (sin parámetros
 * sensibles: solo verbo y tabla).
 */
export function auditWrites(
  writes: readonly WriteRecord[],
  allowedTables: Set<string>,
  allowedRefs: ReadonlySet<string>,
  phone: string,
): string[] {
  const violations: string[] = [];
  for (const write of writes) {
    const match = MUTATION.exec(write.sql);
    if (!match) continue;
    const verb = match[1].toLowerCase().replace(/\s+/g, ' ');
    const table = match[2].toLowerCase();

    if (!allowedTables.has(table)) {
      violations.push(`${verb} ${table}: tabla fuera de la lista permitida`);
      continue;
    }
    if (verb === 'insert into') continue;

    const scoped = write.parameters.some(
      (p) => typeof p === 'string' && (allowedRefs.has(p) || p === phone || p.startsWith('e2e-')),
    );
    if (!scoped)
      violations.push(`${verb} ${table}: no está acotado a ningún id/teléfono/prefijo del E2E`);
  }
  return violations;
}
