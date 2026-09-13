/**
 * Gate de horario de atención (invariante 7 del plan). Portado de
 * `src/lib/schedule/service-window.ts` en saas_smarky — mismo algoritmo,
 * mismas fronteras, solo que las horas ahora son configurables
 * (operational_settings) en vez de constantes.
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

/**
 * Las tres fronteras caen en punto: basta comparar horas enteras. El cierre
 * (>= closesHour) se comprueba ANTES que late_review. Un instante ilegible
 * (NaN) sale 'closed': ante la duda, no se toma un pedido que nadie va a
 * cocinar.
 */
export function classifyServiceWindow(instant: Date, hours: ServiceHours): ServiceWindow {
  const hour = hourInBolivia(instant);
  if (hour === null) return 'closed';
  if (hour >= hours.closesHour) return 'closed';
  if (hour >= hours.lateReviewHour) return 'late_review';
  if (hour >= hours.opensHour) return 'open';
  return 'closed';
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
