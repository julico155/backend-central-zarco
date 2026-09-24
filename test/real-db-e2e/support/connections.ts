import { Kysely, PostgresDialect } from 'kysely';
import { Client, Pool } from 'pg';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import { withApplicationName } from './options';

/** Cliente pg dentro de `BEGIN READ ONLY`: Postgres rechaza cualquier escritura. Cerrar con `closeReadOnly`. */
export async function openReadOnly(url: string, applicationName: string): Promise<Client> {
  const client = new Client({ connectionString: withApplicationName(url, applicationName) });
  try {
    await client.connect();
  } catch (error) {
    // Nunca se propaga el mensaje original: podría incluir el host.
    const code = (error as { code?: string }).code ?? 'desconocido';
    throw new Error(`No se pudo conectar a la base de datos (código: ${code}).`);
  }
  await client.query('BEGIN READ ONLY');
  return client;
}

export async function closeReadOnly(client: Client): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } finally {
    await client.end();
  }
}

export function openCentral(url: string, applicationName: string): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: withApplicationName(url, applicationName), max: 2 }),
    }),
  });
}

export function openAgent(url: string, applicationName: string): Kysely<AgentDatabase> {
  return new Kysely<AgentDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({ connectionString: withApplicationName(url, applicationName), max: 2 }),
    }),
  });
}
