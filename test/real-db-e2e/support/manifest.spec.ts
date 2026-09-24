import fs from 'node:fs';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Kysely, PostgresDialect } from 'kysely';
import type { AgentDatabase } from '../../../src/database/agent-types';
import type { Database } from '../../../src/database/types';
import { cleanupFromManifest } from './cleanup';
import { Manifest, ManifestExistsError, ManifestWriteError } from './manifest';

const PHONE = '59170001234';
const tmpDir = () => mkdtempSync(join(tmpdir(), 'e2e-manifest-'));
const tmpPath = () => join(tmpDir(), 'e2e-manifest.jsonl');

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: simulado`), { code });
}

describe('Manifest (diario de solo-agregado, compatible con Windows)', () => {
  const originalDelays = Manifest.retryDelaysMs;
  beforeEach(() => {
    Manifest.retryDelaysMs = [0, 0, 0];
  });
  afterEach(() => {
    Manifest.retryDelaysMs = originalDelays;
    jest.restoreAllMocks();
  });

  describe('primer save', () => {
    it('create() escribe la línea inicial y nada más', () => {
      const path = tmpPath();
      const m = Manifest.create(path, 'run1', PHONE);

      const lines = readFileSync(path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toMatchObject({ t: 'init', runId: 'run1', phone: PHONE });
      expect(m.total()).toBe(0);
    });

    it('el primer alta queda en disco ANTES de que exista en memoria', () => {
      const m = Manifest.create(tmpPath(), 'r', PHONE);
      m.addCentral('categories', 'cat-1');

      expect(m.ids('central', 'categories')).toEqual(['cat-1']);
      expect(Manifest.load(m.path).ids('central', 'categories')).toEqual(['cat-1']);
    });
  });

  describe('múltiples saves consecutivos', () => {
    it('200 altas seguidas: cada una es UNA línea, sin duplicar ni reordenar, y se recarga idéntico', () => {
      const m = Manifest.create(tmpPath(), 'r', PHONE);
      const ids = Array.from({ length: 200 }, (_, i) => `order-${i}`);
      for (const id of ids) m.addCentral('orders', id, id); // el duplicado en la misma llamada no se repite
      m.addAgent('menu_sessions', 's1');
      m.addCentral('orders', 'order-0'); // ya registrado: no agrega línea

      const lines = readFileSync(m.path, 'utf8').trim().split('\n');
      expect(lines).toHaveLength(1 + 200 + 1);
      const loaded = Manifest.load(m.path);
      expect(loaded.ids('central', 'orders')).toEqual(ids);
      expect(loaded.total()).toBe(201);
    });

    it('nunca deja un .tmp ni ningún otro archivo junto al manifest', () => {
      const dir = tmpDir();
      const path = join(dir, 'e2e-manifest.jsonl');
      const m = Manifest.create(path, 'r', PHONE);
      for (let i = 0; i < 20; i += 1) m.addCentral('order_items', `i-${i}`);
      m.setRealCashSession({ id: 'caja', nextOrderNumberBefore: 7 });
      m.archive();

      expect(readdirSync(dir)).toEqual(['e2e-manifest.jsonl']);
    });
  });

  describe('compatibilidad con Windows', () => {
    it('no usa rename en ningún camino (el origen del EPERM)', () => {
      const rename = jest.spyOn(fs, 'renameSync');
      const m = Manifest.create(tmpPath(), 'r', PHONE);
      m.addCentral('orders', 'o1');
      m.setRealCashSession({ id: 'caja', nextOrderNumberBefore: 1 });
      m.archive();
      Manifest.create(m.path, 'r2', PHONE); // reinicio de uno archivado

      expect(rename).not.toHaveBeenCalled();
    });

    it.each(['EPERM', 'EBUSY', 'EACCES'])(
      'un bloqueo transitorio (%s) se reintenta y el id queda registrado UNA sola vez',
      (code) => {
        const m = Manifest.create(tmpPath(), 'r', PHONE);
        const realOpen = fs.openSync;
        let failures = 2;
        jest.spyOn(fs, 'openSync').mockImplementation(((
          ...args: Parameters<typeof fs.openSync>
        ) => {
          if (failures > 0) {
            failures -= 1;
            throw errno(code);
          }
          return realOpen(...args);
        }) as typeof fs.openSync);

        m.addCentral('orders', 'o1');

        expect(failures).toBe(0);
        const lines = readFileSync(m.path, 'utf8').trim().split('\n');
        expect(lines.filter((l) => l.includes('"o1"'))).toHaveLength(1);
        expect(Manifest.load(m.path).ids('central', 'orders')).toEqual(['o1']);
      },
    );

    it('un bloqueo PERSISTENTE no se ignora: lanza ManifestWriteError y el id NO queda en memoria', () => {
      const m = Manifest.create(tmpPath(), 'r', PHONE);
      const open = jest.spyOn(fs, 'openSync').mockImplementation(() => {
        throw errno('EPERM');
      });

      expect(() => m.addCentral('products', 'p1')).toThrow(ManifestWriteError);
      expect(() => m.addCentral('products', 'p1')).toThrow(/EPERM/);
      expect(m.ids('central', 'products')).toEqual([]);
      expect(open).toHaveBeenCalledTimes(2 * (Manifest.retryDelaysMs.length + 1));

      open.mockRestore();
      expect(Manifest.load(m.path).ids('central', 'products')).toEqual([]);
      // Cuando el bloqueo cede, el mismo id se registra normalmente.
      m.addCentral('products', 'p1');
      expect(Manifest.load(m.path).ids('central', 'products')).toEqual(['p1']);
    });

    it('un error NO transitorio (p. ej. ENOENT) falla de inmediato, sin reintentos', () => {
      const m = Manifest.create(tmpPath(), 'r', PHONE);
      const open = jest.spyOn(fs, 'openSync').mockImplementation(() => {
        throw errno('ENOENT');
      });

      expect(() => m.addCentral('orders', 'o1')).toThrow(/ENOENT/);
      expect(open).toHaveBeenCalledTimes(1);
    });
  });

  describe('manifest existente', () => {
    it('create() se niega a pisar un manifest con datos sin consumir', () => {
      const path = tmpPath();
      Manifest.create(path, 'r1', PHONE).addCentral('orders', 'o1');

      expect(() => Manifest.create(path, 'r2', PHONE)).toThrow(ManifestExistsError);
      expect(Manifest.load(path).ids('central', 'orders')).toEqual(['o1']);
    });

    it('un manifest ya archivado se reinicia limpio para la siguiente corrida', () => {
      const path = tmpPath();
      const first = Manifest.create(path, 'r1', PHONE);
      first.addCentral('orders', 'o1');
      first.archive();

      const second = Manifest.create(path, 'r2', PHONE);

      expect(second.total()).toBe(0);
      expect(Manifest.load(path).data.runId).toBe('r2');
      expect(Manifest.load(path).data.archived).toBeUndefined();
      expect(Manifest.load(path).total()).toBe(0);
    });

    it('load() de un archivo inexistente falla con un mensaje claro', () => {
      expect(() => Manifest.load(join(tmpDir(), 'no-existe.jsonl'))).toThrow(
        'No existe el manifest',
      );
    });
  });

  describe('recuperación y lectura posterior', () => {
    it('reconstruye todo (ids, caja real, archivado) a partir del diario', () => {
      const path = tmpPath();
      const m = Manifest.create(path, 'run9', PHONE);
      m.setRealCashSession({ id: 'caja-real', nextOrderNumberBefore: 41 });
      m.addCentral('customers', 'c1');
      m.addAgent('agent_conversations', 'conv1');

      const loaded = Manifest.load(path);
      expect(loaded.data).toMatchObject({
        runId: 'run9',
        phone: PHONE,
        realCashSession: { id: 'caja-real', nextOrderNumberBefore: 41 },
      });
      expect(loaded.data.archived).toBeUndefined();
      expect(loaded.ids('central', 'cash_register_sessions')).toEqual([]);

      m.archive();
      expect(Manifest.load(path).data.archived).toBe(true);
    });

    it('una última línea truncada (Jest murió en pleno write) se ignora sin perder lo anterior', () => {
      const path = tmpPath();
      const m = Manifest.create(path, 'r', PHONE);
      m.addCentral('orders', 'o1');
      fs.appendFileSync(path, '{"t":"add","db":"central","table":"orders","ids":["o2');

      expect(Manifest.load(path).ids('central', 'orders')).toEqual(['o1']);
    });

    it('una línea corrupta EN MEDIO es un error (no se adivina)', () => {
      const path = tmpPath();
      const m = Manifest.create(path, 'r', PHONE);
      m.addCentral('orders', 'o1');
      fs.appendFileSync(path, 'basura\n');
      m.addCentral('orders', 'o2');

      expect(() => Manifest.load(path)).toThrow('línea 3 ilegible');
    });

    it('un archivo vacío o sin línea inicial no es un manifest', () => {
      const path = tmpPath();
      writeFileSync(path, '');
      expect(() => Manifest.load(path)).toThrow('vacío');
    });
  });

  describe('cleanup usando el manifest recuperado', () => {
    function recordingDbs(deleted = 1) {
      const statements: string[] = [];
      const client = {
        query: async (sql: string) => {
          const text = sql.replace(/\s+/g, ' ').trim();
          statements.push(text);
          return { command: 'DELETE', rowCount: /^delete/i.test(text) ? deleted : 0, rows: [] };
        },
        release: () => undefined,
      };
      const pool = { connect: async () => client, end: async () => undefined } as never;
      return {
        statements,
        central: new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }),
        agent: new Kysely<AgentDatabase>({ dialect: new PostgresDialect({ pool }) }),
      };
    }

    it('tras "morir" a mitad de camino, Manifest.load + cleanup borra exactamente lo registrado', async () => {
      const path = tmpPath();
      const dying = Manifest.create(path, 'r', PHONE);
      dying.addCentral('customers', 'cust-1');
      dying.addCentral('orders', 'order-1');
      dying.addCentral('categories', 'cat-1');
      dying.addAgent('agent_conversations', 'conv-1');
      // (el proceso muere aquí: no se llama a archive())

      const recovered = Manifest.load(path);
      const db = recordingDbs();
      const report = await cleanupFromManifest(db.central, db.agent, recovered);

      expect(Object.keys(report.deleted).sort()).toEqual([
        'agent.agent_conversations',
        'central.categories',
        'central.customers',
        'central.orders',
      ]);
      const deletes = db.statements.filter((s) => /^delete from/i.test(s));
      expect(deletes).toHaveLength(4);
      for (const d of deletes) expect(d).toMatch(/where "id" in \(/i);

      recovered.archive();
      expect(Manifest.load(path).data.archived).toBe(true);
    });

    it('un manifest ya archivado no vuelve a poblarse: el cleanup manual lo reconoce como consumido', () => {
      const path = tmpPath();
      const m = Manifest.create(path, 'r', PHONE);
      m.addCentral('orders', 'order-1');
      m.archive();

      expect(Manifest.load(path).data.archived).toBe(true);
    });
  });
});
