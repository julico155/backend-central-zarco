import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

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
}

function empty<T extends string>(tables: readonly T[]): Record<T, string[]> {
  return Object.fromEntries(tables.map((t) => [t, [] as string[]])) as Record<T, string[]>;
}

/**
 * Registro local de TODO id creado por el E2E. Se reescribe (tmp + rename) tras
 * cada alta, así que si Jest muere a mitad de camino el cleanup manual sabe
 * exactamente qué borrar. `add*` se llama ANTES de insertar cuando el id se
 * genera en el test, y tras cada paso para lo que crea la aplicación.
 */
export class Manifest {
  private constructor(
    private readonly path: string,
    readonly data: ManifestData,
  ) {}

  static create(path: string, runId: string, phone: string): Manifest {
    const manifest = new Manifest(path, {
      version: 1,
      runId,
      phone,
      startedAt: new Date().toISOString(),
      central: empty(CENTRAL_TABLES),
      agent: empty(AGENT_TABLES),
    });
    manifest.save();
    return manifest;
  }

  static load(path: string): Manifest {
    if (!existsSync(path)) throw new Error(`No existe el manifest ${path}`);
    const data = JSON.parse(readFileSync(path, 'utf8')) as ManifestData;
    if (data.version !== 1) throw new Error('Versión de manifest desconocida.');
    for (const t of CENTRAL_TABLES) data.central[t] ??= [];
    for (const t of AGENT_TABLES) data.agent[t] ??= [];
    return new Manifest(path, data);
  }

  setRealCashSession(session: { id: string; nextOrderNumberBefore: number }): void {
    this.data.realCashSession = session;
    this.save();
  }

  addCentral(table: CentralTable, ...ids: string[]): void {
    this.add(this.data.central[table], ids);
  }

  addAgent(table: AgentTable, ...ids: string[]): void {
    this.add(this.data.agent[table], ids);
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

  /** Marca el manifest como consumido (cleanup completo) sin perderlo. */
  archive(): string {
    const target = `${this.path}.done`;
    renameSync(this.path, target);
    return target;
  }

  private add(bucket: string[], ids: string[]): void {
    let changed = false;
    for (const id of ids) {
      if (!bucket.includes(id)) {
        bucket.push(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(tmp, this.path);
  }
}
