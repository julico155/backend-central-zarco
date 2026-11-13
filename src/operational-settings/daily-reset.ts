import { dateInBolivia, hourInBolivia } from '../common/time/service-window';

/**
 * Los modos "de ocasión especial" (Seguimos atendiendo, Cerrado, Cola, Efectivo apagado) se reinician solos una vez
 * al día, a `resetHour` (hora de Bolivia): así un olvido de anoche no afecta a la noche siguiente.
 *
 * Toca reiniciar cuando ya pasó `resetHour` hoy Y todavía no se reinició hoy. Comparar por fecha calendario (no por
 * "hace 24 horas") hace que sea idempotente aunque el cron corra cada minuto, y que un backend caído a las 7:00 lo
 * haga al primer minuto que vuelva. Un modo que se activa DESPUÉS del reinicio de hoy (ej. a las 22:00) dura hasta
 * el de mañana.
 */
export function dailyResetDue(
  now: Date,
  resetHour: number,
  lastResetOn: string | null,
): { due: boolean; today: string } {
  const today = dateInBolivia(now);
  const hour = hourInBolivia(now);
  if (hour === null) return { due: false, today };
  return { due: hour >= resetHour && lastResetOn !== today, today };
}
