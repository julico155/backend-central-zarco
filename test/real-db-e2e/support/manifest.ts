import fs from 'node:fs';

export const CENTRAL_TABLES = [
  'notification_jobs',
  'bank_qr_charges',
  'payment_attempts',
  'order_items',
  'order_promotions',
  'orders',
  'idempotency_keys',
  'customers',
  'products',
  'categories',
  'cash_register_sessions',
] as const;

export const AGENT_TABLES = [
  'webhook_events',
  'agent_conversations',
  'agent_messages',
  'agent_runs',
  'agent_control_events',
  'menu_sessions',
  'menu_send_deliveries',
] as const;

export type CentralTable = (typeof CENTRAL_TABLES)[number];
export type AgentTable = (typeof AGENT_TABLES)[number];

export interface ManifestData {
  version: 1;
  runId: string;
  phone: string;
  startedAt: string;
  central: Record<CentralTable, string[]>;
  agent: Record<AgentTable, string[]>;
  /**
   * Caja REAL que usó el E2E (ALLOW_OPEN_REAL_CASH_REGISTER=true). Solo informativo:
   * el cleanup NUNCA la borra, la cierra ni restaura su correlativo.
   */
  realCashSession?: { id: string; nextOrderNumberBefore: number };
  /** El cleanup ya consumió este manifest (no queda nada por borrar). */
  archived?: boolean;
}

type Entry =
  | { t: 'init'; version: 1; runId: string; phone: string; startedAt: string }
  | { t: 'add'; db: 'central' | 'agent'; table: string; ids: string[] }
  | { t: 'realCash'; id: string; nextOrderNumberBefore: number }
  | { t: 'archived'; at: string };

export class ManifestWriteError extends Error {
  constructor(
    readonly path: string,
    readonly code: string,
  ) {
    super(
      `No se pudo escribir el manifest ${path} (${code}) tras varios intentos: otro proceso mantiene el archivo bloqueado. Cierra lo que lo tenga abierto y reintenta.`,
    );
    this.name = 'ManifestWriteError';
  }
}

export class ManifestExistsError extends Error {
  constructor(path: string) {
    super(
      `Ya existe un manifest sin consumir en ${path}: quedó de una corrida anterior. Corre "npm run e2e:cleanup" (con --dry-run primero) antes de empezar otra.`,
    );
    this.name = 'ManifestExistsError';
  }
}

function empty<T extends string>(tables: readonly T[]): Record<T, string[]> {
  return Object.fromEntries(tables.map((t) => [t, [] as string[]])) as Record<T, string[]>;
}

/** Errores que en Windows suelen ser transitorios (antivirus, indexador, watcher del editor). */
const TRANSIENT = new Set(['EPERM', 'EBUSY', 'EACCES', 'EMFILE', 'ENFILE']);

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Registro local de TODO id creado por el E2E, como DIARIO de solo-agregado
 * (una línea JSON por evento). Cada alta abre el archivo en modo `a`, escribe UNA
 * línea, hace fsync y cierra.
 *
 * ── Por qué ya NO se reescribe el archivo (tmp + rename) ─────────────────────
 * `rename(tmp, destino)` sobre un destino que YA existe falla en Windows con
 * EPERM/EACCES si otro proceso lo tiene abierto sin FILE_SHARE_DELETE, aunque
 * sea por milisegundos (antivirus, indexador, watcher del editor justo después
 * del save anterior). Un diario de solo-agregado nunca reemplaza nada: no hay
 * rename, no hay `.tmp` que pueda quedar bloqueado o huérfano, y dos saves
 * seguidos no compiten entre sí.
 *
 * ── Recuperación ────────────────────────────────────────────────────────────
 * Cada línea se vuelca completa antes de usar el id (`add*` se llama ANTES del
 * INSERT). Si Jest muere, `Manifest.load` reconstruye el estado leyendo el
 * diario; una última línea truncada (muerte en pleno write) se ignora, una línea
 * corrupta en medio es un error. Un fallo persistente de escritura NO se ignora:
 * tras reintentos con espera lanza `ManifestWriteError` y el id NO queda en
 * memoria, así que el test se detiene ANTES de insertar nada.
 */
export class Manifest {
  /** Esperas entre reintentos ante errores transitorios (ms). Ajustable en tests. */
  static retryDelaysMs: number[] = [25, 50, 100, 250, 500];

  private constructor(
    readonly path: string,
    readonly data: ManifestData,
  ) {}

  static create(path: string, runId: string, phone: string): Manifest {
    if (fs.existsSync(path)) {
      // Nunca se pisa un manifest pendiente; uno ya archivado se reinicia en el lugar (sin rename).
      if (!Manifest.load(path).data.archived) throw new ManifestExistsError(path);
      fs.writeFileSync(path, '');
    }
    const manifest = new Manifest(path, {
      version: 1,
      runId,
      phone,
      startedAt: new Date().toISOString(),
      central: empty(CENTRAL_TABLES),
      agent: empty(AGENT_TABLES),
    });
    manifest.append({ t: 'init', version: 1, runId, phone, startedAt: manifest.data.startedAt });
    return manifest;
  }

  static load(path: string): Manifest {
    if (!fs.existsSync(path)) throw new Error(`No existe el manifest ${path}`);
    const lines = fs
      .readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    let data: ManifestData | null = null;

    lines.forEach((line, index) => {
      let entry: Entry;
      try {
        entry = JSON.parse(line) as Entry;
      } catch {
        if (index === lines.length - 1) return; // última línea truncada por una muerte en pleno write
        throw new Error(`Manifest corrupto: línea ${index + 1} ilegible.`);
      }
      if (entry.t === 'init') {
        data = {
          version: 1,
          runId: entry.runId,
          phone: entry.phone,
          startedAt: entry.startedAt,
          central: empty(CENTRAL_TABLES),
          agent: empty(AGENT_TABLES),
        };
        return;
      }
      if (!data) throw new Error('Manifest corrupto: falta la línea inicial.');
      if (entry.t === 'add') {
        const bucket = (data[entry.db] as Record<string, string[]>)[entry.table];
        if (!bucket) throw new Error(`Manifest corrupto: tabla desconocida ${entry.table}.`);
        for (const id of entry.ids) if (!bucket.includes(id)) bucket.push(id);
      } else if (entry.t === 'realCash') {
        data.realCashSession = { id: entry.id, nextOrderNumberBefore: entry.nextOrderNumberBefore };
      } else if (entry.t === 'archived') {
        data.archived = true;
      }
    });

    if (!data) throw new Error('Manifest vacío o sin línea inicial.');
    return new Manifest(path, data);
  }

  setRealCashSession(session: { id: string; nextOrderNumberBefore: number }): void {
    this.append({ t: 'realCash', ...session });
    this.data.realCashSession = session;
  }

  addCentral(table: CentralTable, ...ids: string[]): void {
    this.add('central', table, ids, this.data.central[table]);
  }

  addAgent(table: AgentTable, ...ids: string[]): void {
    this.add('agent', table, ids, this.data.agent[table]);
  }

  ids(db: 'central', table: CentralTable): string[];
  ids(db: 'agent', table: AgentTable): string[];
  ids(db: 'central' | 'agent', table: string): string[] {
    const bucket = (this.data[db] as Record<string, string[]>)[table];
    return [...(bucket ?? [])];
  }

  total(): number {
    return (
      Object.values(this.data.central).reduce((n, ids) => n + ids.length, 0) +
      Object.values(this.data.agent).reduce((n, ids) => n + ids.length, 0)
    );
  }

  /** Marca el manifest como consumido (cleanup completo). Se agrega una línea: no hay rename. */
  archive(): string {
    this.append({ t: 'archived', at: new Date().toISOString() });
    this.data.archived = true;
    return this.path;
  }

  private add(db: 'central' | 'agent', table: string, ids: string[], bucket: string[]): void {
    const fresh = [...new Set(ids)].filter((id) => !bucket.includes(id));
    if (fresh.length === 0) return;
    // Primero a disco, después a memoria: memoria nunca tiene un id que el diario no tenga.
    this.append({ t: 'add', db, table, ids: fresh });
    bucket.push(...fresh);
  }

  private append(entry: Entry): void {
    const line = `${JSON.stringify(entry)}\n`;
    const delays = Manifest.retryDelaysMs;
    for (let attempt = 0; ; attempt += 1) {
      try {
        const fd = fs.openSync(this.path, 'a');
        try {
          fs.writeSync(fd, line);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'DESCONOCIDO';
        if (!TRANSIENT.has(code)) throw error;
        if (attempt >= delays.length) throw new ManifestWriteError(this.path, code);
        sleep(delays[attempt]);
      }
    }
  }
}
