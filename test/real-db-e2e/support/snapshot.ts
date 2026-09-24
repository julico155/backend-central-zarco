import type { Queryable } from './preflight';

export interface TableFingerprint {
  count: number;
  hash: string;
}

export type Snapshot = Record<string, TableFingerprint>;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/**
 * Huella de TODAS las tablas de `public`: cantidad de filas + md5 del texto de
 * cada fila (ordenado). Si después del E2E y de su cleanup la huella coincide
 * con la de antes, ninguna fila preexistente cambió ni desapareció y no quedó
 * ninguna fila nueva. Solo SELECT; no devuelve ninguna fila de negocio.
 */
export async function takeSnapshot(client: Queryable): Promise<Snapshot> {
  const { rows: tables } = await client.query(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by 1",
  );
  const snapshot: Snapshot = {};
  for (const row of tables) {
    const name = String(row.table_name);
    if (!IDENTIFIER.test(name)) throw new Error(`nombre de tabla inesperado: ${name}`);
    const { rows } = await client.query(
      `select count(*)::int as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from "${name}" t`,
    );
    snapshot[name] = { count: Number(rows[0].n), hash: String(rows[0].h) };
  }
  return snapshot;
}

/** Diferencias entre dos huellas, una línea por tabla; vacío = idénticas. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const diffs: string[] = [];
  for (const table of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = before[table];
    const b = after[table];
    if (!a) diffs.push(`${table}: tabla nueva (${b.count} filas)`);
    else if (!b) diffs.push(`${table}: tabla desaparecida`);
    else if (a.count !== b.count) diffs.push(`${table}: filas ${a.count} → ${b.count}`);
    else if (a.hash !== b.hash)
      diffs.push(`${table}: mismas ${a.count} filas pero el CONTENIDO cambió`);
  }
  return diffs.sort();
}
