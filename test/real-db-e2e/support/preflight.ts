import { E2E_PREFIX, E2EGuardError, type E2EOptions } from './options';

/** Lo mínimo que necesita de `pg.Client` (y lo que un fake de prueba implementa). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface ForeignSession {
  app: string;
  n: number;
}

export interface CentralFacts {
  foreignSessions: ForeignSession[];
  openCashSessions: number;
  phoneCustomers: number;
  leftovers: { products: number; categories: number; cashSessions: number };
  settingsRows: number;
}

export interface AgentFacts {
  foreignSessions: ForeignSession[];
  phoneConversations: number;
  phoneMenuSessions: number;
  phoneMenuDeliveries: number;
  leftoverWebhookEvents: number;
}

// Roles internos de Supabase que mantienen conexiones permanentes y no consumen estas tablas.
const INTERNAL_ROLES = '^(supabase_|authenticator$|pgbouncer$|cloud_admin$|pgsodium)';

const FOREIGN_SESSIONS_SQL = `
  select coalesce(application_name, '') as app, count(*)::int as n
    from pg_stat_activity
   where datname = current_database()
     and pid <> pg_backend_pid()
     and backend_type = 'client backend'
     and coalesce(application_name, '') not like 'e2e-%'
     and not (coalesce(application_name, '') = any($1))
     and usename !~ '${INTERNAL_ROLES}'
   group by 1
   order by 1`;

const num = (rows: Record<string, unknown>[]): number => Number(rows[0]?.n ?? 0);

export async function foreignSessions(
  client: Queryable,
  ignoredApps: string[],
): Promise<ForeignSession[]> {
  const { rows } = await client.query(FOREIGN_SESSIONS_SQL, [ignoredApps]);
  return rows.map((r) => ({ app: String(r.app), n: Number(r.n) }));
}

export async function collectCentralFacts(
  client: Queryable,
  opts: Pick<E2EOptions, 'phone' | 'ignoredApplicationNames'>,
): Promise<CentralFacts> {
  const like = `${E2E_PREFIX}%`;
  return {
    foreignSessions: await foreignSessions(client, opts.ignoredApplicationNames),
    openCashSessions: num(
      (
        await client.query(
          "select count(*)::int as n from cash_register_sessions where status = 'open'",
        )
      ).rows,
    ),
    phoneCustomers: num(
      (
        await client.query('select count(*)::int as n from customers where phone = $1', [
          opts.phone,
        ])
      ).rows,
    ),
    leftovers: {
      products: num(
        (await client.query('select count(*)::int as n from products where code like $1', [like]))
          .rows,
      ),
      categories: num(
        (await client.query('select count(*)::int as n from categories where name like $1', [like]))
          .rows,
      ),
      cashSessions: num(
        (
          await client.query(
            'select count(*)::int as n from cash_register_sessions where opened_by like $1',
            [like],
          )
        ).rows,
      ),
    },
    settingsRows: num(
      (await client.query('select count(*)::int as n from operational_settings')).rows,
    ),
  };
}

export async function collectAgentFacts(
  client: Queryable,
  opts: Pick<E2EOptions, 'phone' | 'ignoredApplicationNames'>,
): Promise<AgentFacts> {
  return {
    foreignSessions: await foreignSessions(client, opts.ignoredApplicationNames),
    phoneConversations: num(
      (
        await client.query(
          'select count(*)::int as n from agent_conversations where customer_phone = $1',
          [opts.phone],
        )
      ).rows,
    ),
    phoneMenuSessions: num(
      (
        await client.query(
          'select count(*)::int as n from menu_sessions where customer_phone = $1',
          [opts.phone],
        )
      ).rows,
    ),
    phoneMenuDeliveries: num(
      (
        await client.query(
          'select count(*)::int as n from menu_send_deliveries where customer_phone = $1',
          [opts.phone],
        )
      ).rows,
    ),
    leftoverWebhookEvents: num(
      (
        await client.query('select count(*)::int as n from webhook_events where event_id like $1', [
          `${E2E_PREFIX}%`,
        ])
      ).rows,
    ),
  };
}

const describeSessions = (label: string, sessions: ForeignSession[]): string =>
  `${label}: hay conexiones ajenas activas (${sessions
    .map((s) => `${s.app || '(sin application_name)'} x${s.n}`)
    .join(
      ', ',
    )}). Detén el backend/worker que las usa; si son inocuas, decláralas con E2E_IGNORED_APPLICATION_NAMES.`;

/** Puro: decide si el E2E puede escribir. Devuelve TODOS los problemas, no solo el primero. */
export function evaluatePreflight(central: CentralFacts, agent: AgentFacts): string[] {
  const problems: string[] = [];

  if (central.foreignSessions.length > 0)
    problems.push(describeSessions('DB Central', central.foreignSessions));
  if (agent.foreignSessions.length > 0)
    problems.push(describeSessions('DB Agente', agent.foreignSessions));

  if (central.openCashSessions > 0) {
    problems.push(
      'DB Central: hay una caja REAL abierta. El E2E nunca modifica una caja real: ciérrala antes de correrlo.',
    );
  }
  if (central.phoneCustomers > 0)
    problems.push('DB Central: el teléfono E2E ya existe en customers.');
  if (agent.phoneConversations > 0)
    problems.push('DB Agente: el teléfono E2E ya existe en agent_conversations.');
  if (agent.phoneMenuSessions > 0)
    problems.push('DB Agente: el teléfono E2E ya existe en menu_sessions.');
  if (agent.phoneMenuDeliveries > 0)
    problems.push('DB Agente: el teléfono E2E ya existe en menu_send_deliveries.');

  const left = central.leftovers;
  if (left.products + left.categories + left.cashSessions > 0) {
    problems.push(
      `DB Central: quedan restos de un E2E anterior (products=${left.products}, categories=${left.categories}, cajas=${left.cashSessions}). Corre npm run e2e:cleanup.`,
    );
  }
  if (agent.leftoverWebhookEvents > 0) {
    problems.push(
      `DB Agente: quedan ${agent.leftoverWebhookEvents} webhook_events e2e- de una corrida anterior. Corre npm run e2e:cleanup.`,
    );
  }
  if (central.settingsRows !== 1) {
    problems.push(
      `DB Central: operational_settings debe tener exactamente 1 fila (tiene ${central.settingsRows}).`,
    );
  }
  return problems;
}

export function assertPreflight(central: CentralFacts, agent: AgentFacts): void {
  const problems = evaluatePreflight(central, agent);
  if (problems.length > 0) {
    throw new E2EGuardError(`preflight falló.\n - ${problems.join('\n - ')}`);
  }
}

/** Pre-flight completo, SOLO LECTURA: cada cliente ya debe estar en una transacción de solo lectura. */
export async function runPreflight(
  central: Queryable,
  agent: Queryable,
  opts: Pick<E2EOptions, 'phone' | 'ignoredApplicationNames'>,
): Promise<void> {
  assertPreflight(await collectCentralFacts(central, opts), await collectAgentFacts(agent, opts));
}

/** Segunda comprobación, justo antes del primer INSERT. */
export async function recheckForeignSessions(
  central: Queryable,
  agent: Queryable,
  ignoredApps: string[],
): Promise<void> {
  const [c, a] = [
    await foreignSessions(central, ignoredApps),
    await foreignSessions(agent, ignoredApps),
  ];
  const problems: string[] = [];
  if (c.length > 0) problems.push(describeSessions('DB Central', c));
  if (a.length > 0) problems.push(describeSessions('DB Agente', a));
  if (problems.length > 0)
    throw new E2EGuardError(
      `apareció actividad ajena antes de escribir.\n - ${problems.join('\n - ')}`,
    );
}
