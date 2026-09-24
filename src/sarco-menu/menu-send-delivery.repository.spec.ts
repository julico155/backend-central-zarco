import { Kysely, PostgresDialect } from 'kysely';
import type { AgentDatabase } from '../database/agent-types';
import { MenuSendDeliveryRepository } from './menu-send-delivery.repository';

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

describe('MenuSendDeliveryRepository.finish — el ledger nunca depende del reloj del proceso', () => {
  it('completed_at y updated_at salen del reloj de la BASE (now()), no de un Date del proceso', async () => {
    const { db, statements } = recordingDb();

    await new MenuSendDeliveryRepository(db).finish({
      id: 'delivery-1',
      status: 'sent',
      providerMessageId: 'wamid.out.1',
    });

    const update = statements.find((s) => s.sql.startsWith('update "menu_send_deliveries"'));
    expect(update?.sql).toContain('"completed_at" = now()');
    expect(update?.sql).toContain('"updated_at" = now()');
    // Ningún parámetro es un instante: solo status, wamid, error_code (null) y el id.
    expect(update?.parameters).toEqual(['sent', 'wamid.out.1', null, 'delivery-1']);
    expect(update?.parameters.some((p) => p instanceof Date)).toBe(false);
  });

  it('un reloj de proceso ATRASADO no puede violar completed_at >= claimed_at (claimed_at es now() de la DB)', async () => {
    // Reloj de este proceso 10 minutos en el pasado: con la versión anterior, `completed_at`
    // viajaba como parámetro y el CHECK de la base rechazaba el cierre.
    jest.useFakeTimers({ now: new Date(Date.now() - 10 * 60 * 1000) });
    try {
      const { db, statements } = recordingDb();

      await new MenuSendDeliveryRepository(db).finish({
        id: 'delivery-1',
        status: 'blocked_recent',
      });

      const update = statements.find((s) => s.sql.startsWith('update "menu_send_deliveries"'));
      expect(update?.sql).toContain('"completed_at" = now()');
      expect(update?.parameters.some((p) => p instanceof Date)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('un fallo de envío conserva status y error_code, con la misma hora de la base', async () => {
    const { db, statements } = recordingDb();

    await new MenuSendDeliveryRepository(db).finish({
      id: 'delivery-2',
      status: 'failed',
      errorCode: 'send.http_error',
    });

    const update = statements.find((s) => s.sql.startsWith('update "menu_send_deliveries"'));
    expect(update?.parameters).toEqual(['failed', null, 'send.http_error', 'delivery-2']);
    expect(update?.sql).toContain('"completed_at" = now()');
  });
});
