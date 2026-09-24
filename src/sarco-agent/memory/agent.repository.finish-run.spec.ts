import { Kysely, PostgresDialect } from 'kysely';
import type { AgentDatabase } from '../../database/agent-types';
import { AgentRepository } from './agent.repository';

function recordingDb() {
  const statements: { sql: string; parameters: unknown[] }[] = [];
  const client = {
    query: async (sql: string, parameters: unknown[] = []) => {
      statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), parameters });
      return { command: 'UPDATE', rowCount: 1, rows: [] };
    },
    release: () => undefined,
  };
  const db = new Kysely<AgentDatabase>({
    dialect: new PostgresDialect({
      pool: { connect: async () => client, end: async () => undefined } as never,
    }),
  });
  return { db, statements };
}

describe('AgentRepository.finishRun — el cierre nunca queda por debajo de started_at', () => {
  it('completed_at = greatest(instante del núcleo, started_at): un reloj atrasado no viola el CHECK', async () => {
    const { db, statements } = recordingDb();
    // Instante del proceso en el pasado respecto de la base.
    const behind = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await new AgentRepository(db).finishRun({
      runId: 'run-1',
      status: 'completed',
      completedAt: behind,
      model: 'gpt-4o-mini',
      toolRounds: 1,
    });

    const update = statements.find((s) => s.sql.startsWith('update "agent_runs"'));
    expect(update?.sql).toContain('"completed_at" = greatest($');
    expect(update?.sql).toContain('::timestamptz, started_at)');
    // El instante viaja como parámetro dentro de greatest(...), nunca solo.
    expect(update?.parameters).toContain(behind);
  });

  it('conserva el resto de la transición: status, error_code, modelo y rondas', async () => {
    const { db, statements } = recordingDb();

    await new AgentRepository(db).finishRun({
      runId: 'run-2',
      status: 'failed',
      completedAt: new Date().toISOString(),
      errorCode: 'model.http_error',
      model: 'gpt-4o-mini',
      toolRounds: 2,
    });

    const update = statements.find((s) => s.sql.startsWith('update "agent_runs"'));
    expect(update?.parameters).toEqual(
      expect.arrayContaining(['failed', 'model.http_error', 'gpt-4o-mini', 2, 'run-2']),
    );
    expect(update?.sql).toContain('where "id" = $');
  });
});
