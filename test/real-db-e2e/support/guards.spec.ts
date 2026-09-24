import { E2EGuardError, readE2EOptions, withApplicationName } from './options';
import {
  assertPreflight,
  collectAgentFacts,
  collectCentralFacts,
  evaluatePreflight,
  recheckForeignSessions,
  type AgentFacts,
  type CentralFacts,
  type Queryable,
} from './preflight';

const goodEnv = {
  ALLOW_REAL_DB_E2E: 'true',
  E2E_PHONE: '59170001234',
  DATABASE_URL: 'postgres://u:p@central.example/db',
  AGENT_DATABASE_URL: 'postgres://u:p@agent.example/db',
};

describe('guardas de arranque (readE2EOptions)', () => {
  it('sin ALLOW_REAL_DB_E2E=true aborta', () => {
    expect(() => readE2EOptions({ ...goodEnv, ALLOW_REAL_DB_E2E: undefined })).toThrow(
      E2EGuardError,
    );
    expect(() => readE2EOptions({ ...goodEnv, ALLOW_REAL_DB_E2E: '1' })).toThrow(
      'ALLOW_REAL_DB_E2E=true',
    );
  });

  it('exige un teléfono E2E dedicado, solo dígitos', () => {
    expect(() => readE2EOptions({ ...goodEnv, E2E_PHONE: undefined })).toThrow('E2E_PHONE');
    expect(() => readE2EOptions({ ...goodEnv, E2E_PHONE: '+591 700' })).toThrow('E2E_PHONE');
    expect(() => readE2EOptions({ ...goodEnv, E2E_PHONE: '123' })).toThrow('E2E_PHONE');
  });

  it('exige las dos URLs y que sean distintas', () => {
    expect(() => readE2EOptions({ ...goodEnv, DATABASE_URL: '' })).toThrow('DATABASE_URL');
    expect(() => readE2EOptions({ ...goodEnv, AGENT_DATABASE_URL: goodEnv.DATABASE_URL })).toThrow(
      'misma',
    );
  });

  it('con todo en regla devuelve las opciones (y nunca menciona la URL en los errores)', () => {
    const options = readE2EOptions({
      ...goodEnv,
      E2E_RUN_ID: 'ab-12',
      E2E_IGNORED_APPLICATION_NAMES: 'a, b',
    });
    expect(options).toMatchObject({
      phone: '59170001234',
      runId: 'ab12',
      ignoredApplicationNames: ['a', 'b'],
    });
    try {
      readE2EOptions({ ...goodEnv, E2E_PHONE: 'x' });
    } catch (error) {
      expect((error as Error).message).not.toContain('example');
    }
  });

  it('withApplicationName agrega el parámetro conservando el resto de la URL', () => {
    const url = withApplicationName('postgres://u:p@h:5432/db?sslmode=require', 'e2e-x');
    expect(new URL(url).searchParams.get('application_name')).toBe('e2e-x');
    expect(new URL(url).searchParams.get('sslmode')).toBe('require');
  });
});

const cleanCentral: CentralFacts = {
  foreignSessions: [],
  openCashSessions: 0,
  phoneCustomers: 0,
  leftovers: { products: 0, categories: 0, cashSessions: 0 },
  settingsRows: 1,
};
const cleanAgent: AgentFacts = {
  foreignSessions: [],
  phoneConversations: 0,
  phoneMenuSessions: 0,
  phoneMenuDeliveries: 0,
  leftoverWebhookEvents: 0,
};

describe('evaluatePreflight', () => {
  it('sin problemas: nada que reportar', () => {
    expect(evaluatePreflight(cleanCentral, cleanAgent)).toEqual([]);
    expect(() => assertPreflight(cleanCentral, cleanAgent)).not.toThrow();
  });

  it('conexiones ajenas en cualquiera de las dos bases abortan (nombra la aplicación, no la IP)', () => {
    const problems = evaluatePreflight(
      { ...cleanCentral, foreignSessions: [{ app: 'railway-backend', n: 3 }] },
      { ...cleanAgent, foreignSessions: [{ app: '', n: 1 }] },
    );
    expect(problems.join('\n')).toContain('DB Central: hay conexiones ajenas');
    expect(problems.join('\n')).toContain('railway-backend x3');
    expect(problems.join('\n')).toContain('DB Agente: hay conexiones ajenas');
    expect(problems.join('\n')).toContain('(sin application_name) x1');
  });

  it('una caja REAL abierta aborta: el E2E nunca modifica una caja real', () => {
    expect(evaluatePreflight({ ...cleanCentral, openCashSessions: 1 }, cleanAgent)[0]).toContain(
      'caja REAL abierta',
    );
  });

  it.each([
    [{ ...cleanCentral, phoneCustomers: 1 }, cleanAgent, 'customers'],
    [cleanCentral, { ...cleanAgent, phoneConversations: 1 }, 'agent_conversations'],
    [cleanCentral, { ...cleanAgent, phoneMenuSessions: 1 }, 'menu_sessions'],
    [cleanCentral, { ...cleanAgent, phoneMenuDeliveries: 1 }, 'menu_send_deliveries'],
  ])('el teléfono E2E ya existente aborta (%#)', (central, agent, table) => {
    expect(evaluatePreflight(central, agent).join('\n')).toContain(table);
  });

  it('restos de un E2E anterior abortan y apuntan al cleanup', () => {
    const problems = evaluatePreflight(
      { ...cleanCentral, leftovers: { products: 1, categories: 0, cashSessions: 1 } },
      { ...cleanAgent, leftoverWebhookEvents: 2 },
    );
    expect(problems.join('\n')).toContain('e2e:cleanup');
    expect(problems).toHaveLength(2);
  });

  it('acumula TODOS los problemas y assertPreflight los lanza juntos', () => {
    expect(() =>
      assertPreflight({ ...cleanCentral, openCashSessions: 1, phoneCustomers: 1 }, cleanAgent),
    ).toThrow(/caja REAL[\s\S]*customers/);
  });
});

/** Cliente falso: responde por fragmento de SQL. */
function fakeClient(answers: Record<string, unknown[]>): Queryable & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async query(text: string) {
      queries.push(text);
      const key = Object.keys(answers).find((k) => text.includes(k));
      return { rows: (key ? answers[key] : [{ n: 0 }]) as Record<string, unknown>[] };
    },
  };
}

describe('collectFacts / recheck (solo SELECT)', () => {
  it('recolecta los hechos de cada base y solo ejecuta SELECT', async () => {
    const central = fakeClient({
      pg_stat_activity: [{ app: 'x', n: 2 }],
      "status = 'open'": [{ n: 1 }],
      'from customers': [{ n: 3 }],
      operational_settings: [{ n: 1 }],
    });
    const agent = fakeClient({ 'from agent_conversations': [{ n: 4 }] });
    const opts = { phone: '59170001234', ignoredApplicationNames: [] };

    const c = await collectCentralFacts(central, opts);
    const a = await collectAgentFacts(agent, opts);

    expect(c).toMatchObject({
      foreignSessions: [{ app: 'x', n: 2 }],
      openCashSessions: 1,
      phoneCustomers: 3,
      settingsRows: 1,
    });
    expect(a.phoneConversations).toBe(4);
    for (const q of [...central.queries, ...agent.queries])
      expect(q.trim().toLowerCase()).toMatch(/^select/);
  });

  it('recheckForeignSessions lanza si aparece actividad ajena', async () => {
    const busy = fakeClient({ pg_stat_activity: [{ app: 'worker', n: 1 }] });
    const idle = fakeClient({ pg_stat_activity: [] });
    await expect(recheckForeignSessions(idle, idle, [])).resolves.toBeUndefined();
    await expect(recheckForeignSessions(busy, idle, [])).rejects.toThrow('actividad ajena');
  });

  it('las aplicaciones ignoradas explícitamente viajan como parámetro y las e2e- se excluyen en el SQL', async () => {
    const seen: unknown[][] = [];
    const client: Queryable = {
      async query(text, params) {
        seen.push([text, params]);
        return { rows: [] };
      },
    };
    await recheckForeignSessions(client, client, ['postgres-meta']);
    expect(seen[0][1]).toEqual([['postgres-meta']]);
    expect(String(seen[0][0])).toContain("not like 'e2e-%'");
  });
});
