import type { Queryable } from './preflight';

export interface ClockSkew {
  /** Positivo: el reloj de la BASE va ADELANTE del de esta máquina (esta máquina va atrasada). */
  skewMs: number;
  /** Ida y vuelta de la consulta (la incertidumbre de la medición). */
  rttMs: number;
}

/**
 * Compara el reloj de esta máquina con `clock_timestamp()` de la base, usando el
 * punto medio de la consulta. Solo lectura. Sirve de diagnóstico: los CHECK de
 * la base que comparan un instante del proceso con un `now()` de la base (p. ej.
 * `completed_at >= claimed_at`) se rompen si esta máquina va atrasada.
 */
export async function measureClockSkew(client: Queryable): Promise<ClockSkew> {
  const before = Date.now();
  const { rows } = await client.query(
    'select (extract(epoch from clock_timestamp()) * 1000)::float8 as ms',
  );
  const after = Date.now();
  const dbMs = Number(rows[0].ms);
  return { skewMs: Math.round(dbMs - (before + after) / 2), rttMs: after - before };
}

export function describeClockSkew(label: string, skew: ClockSkew): string {
  const direction =
    skew.skewMs > 0
      ? 'esta máquina va ATRASADA respecto de la base'
      : skew.skewMs < 0
        ? 'esta máquina va ADELANTADA respecto de la base'
        : 'sin diferencia';
  return `E2E reloj (${label}): ${skew.skewMs} ms (±${skew.rttMs} ms de red) — ${direction}`;
}
