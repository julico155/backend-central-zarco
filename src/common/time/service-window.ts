/**
 * Gate de horario de atención (invariante 7 del plan). Portado de
 * `src/lib/schedule/service-window.ts` en saas_smarky — mismo algoritmo,
 * mismas fronteras, solo que las horas ahora son configurables
 * (operational_settings) en vez de constantes.
 *
 * El turno real del local cruza la medianoche (ej. 19 a 4). Las
 * comparaciones se hacen con la hora normalizada RELATIVA a `opensHour`
 * (aritmética modular de 24hs), no con la hora absoluta del día — así
 * "19 a 4" se convierte internamente en "0 a 9" y las mismas comparaciones
 * `>=` de siempre vuelven a ser válidas sin importar que crucen la
 * medianoche.
 *
 * Bolivia es UTC-4 todo el año (no observa horario de verano desde 1932) —
 * el fallback aritmético solo se usa si el runtime no trae Intl con zonas.
 */
export const SERVICE_TIME_ZONE = 'America/La_Paz';
const BOLIVIA_UTC_OFFSET_MS = -4 * 60 * 60 * 1000;

export type ServiceWindow = 'open' | 'late_review' | 'closed';

export interface ServiceHours {
  opensHour: number;
  lateReviewHour: number;
  closesHour: number;
}

function hourInBolivia(instant: Date): number | null {
  const ms = instant.getTime();
  if (!Number.isFinite(ms)) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: SERVICE_TIME_ZONE,
      hour: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(instant);
    const raw = parts.find((p) => p.type === 'hour')?.value;
    if (raw === undefined) return hourByArithmetic(ms);
    const hour = Number.parseInt(raw, 10);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return hourByArithmetic(ms);
    return hour;
  } catch {
    return hourByArithmetic(ms);
  }
}

function hourByArithmetic(ms: number): number | null {
  const local = new Date(ms + BOLIVIA_UTC_OFFSET_MS);
  const hour = local.getUTCHours();
  return Number.isInteger(hour) ? hour : null;
}

/** Horas desde la apertura, en [0, 24) — hace que cruzar la medianoche sea aritmética normal. */
function hoursSinceOpen(hour: number, opensHour: number): number {
  return ((hour - opensHour) % 24 + 24) % 24;
}

/**
 * Las tres fronteras caen en punto: basta comparar horas enteras, ya
 * normalizadas relativas a `opensHour` (ver comentario de cabecera). El
 * cierre (>= closesHour) se comprueba ANTES que late_review. Un instante
 * ilegible (NaN) sale 'closed': ante la duda, no se toma un pedido que nadie
 * va a cocinar.
 */
export function classifyServiceWindow(instant: Date, hours: ServiceHours): ServiceWindow {
  const hour = hourInBolivia(instant);
  if (hour === null) return 'closed';
  const relHour = hoursSinceOpen(hour, hours.opensHour);
  const relLateReview = hoursSinceOpen(hours.lateReviewHour, hours.opensHour);
  const relCloses = hoursSinceOpen(hours.closesHour, hours.opensHour);
  if (relHour >= relCloses) return 'closed';
  if (relHour >= relLateReview) return 'late_review';
  return 'open';
}

export type CheckoutGate = { gate: 'proceed' } | { gate: 'late_review' } | { gate: 'closed' };

export function checkoutGateAt(instant: Date, hours: ServiceHours): CheckoutGate {
  const window = classifyServiceWindow(instant, hours);
  if (window === 'open') return { gate: 'proceed' };
  if (window === 'late_review') return { gate: 'late_review' };
  return { gate: 'closed' };
}

export const LATE_REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutos, igual que el proyecto viejo

export function lateRequestExpiryFor(instant: Date): Date {
  return new Date(instant.getTime() + LATE_REQUEST_TTL_MS);
}
