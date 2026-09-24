import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { AgentDatabase } from '../../src/database/agent-types';
import { Database } from '../../src/database/types';

/**
 * Tests de integración: requieren un Postgres real con las migraciones
 * aplicadas (npm run migrate:up) y DATABASE_URL apuntando a él — nunca a
 * producción. Si no hay DATABASE_URL, los specs que usan este helper se
 * saltan (ver `describeIfDb`).
 */
export function createTestDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.DATABASE_URL }),
    }),
  });
}

export const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;

/**
 * Tests de integración de la DB AGENTE: requieren AGENT_DATABASE_URL apuntando
 * a un Postgres con las migraciones de `migrations-agent/` aplicadas (npm run
 * migrate:agent:up) — nunca a producción y nunca a la misma base que
 * DATABASE_URL. Sin la variable, los specs se saltan.
 */
export function createAgentTestDb(): Kysely<AgentDatabase> {
  return new Kysely<AgentDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: process.env.AGENT_DATABASE_URL }),
    }),
  });
}

export const describeIfAgentDb = process.env.AGENT_DATABASE_URL ? describe : describe.skip;
