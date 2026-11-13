import { classifyServiceWindow } from '../common/time/service-window';

/** Campos de operational_settings que deciden si el local atiende y bajo qué reglas. */
export interface ServiceStatusRow {
  manually_closed: boolean;
  extended_service_enabled: boolean;
  schedule_opens_hour: number;
  schedule_closes_hour: number;
  closed_message: string;
  extended_message: string;
  cash_enabled: boolean;
  allow_promo_with_items: boolean;
  queue_enabled: boolean;
}

/**
 * - `open`          dentro del horario normal.
 * - `extended`      fuera del horario normal, pero el admin activó "Seguimos atendiendo".
 * - `manual_closed` el admin apretó "Cerrado" (gana sobre todo lo demás).
 * - `outside_hours` fuera del horario y sin "Seguimos atendiendo".
 */
export type ServiceReason = 'open' | 'extended' | 'manual_closed' | 'outside_hours';

/** Lo que el agente, el menú web y el POS necesitan saber, calculado UNA sola vez aquí para que nunca se contradigan. */
export interface ServiceStatus {
  open: boolean;
  reason: ServiceReason;
  /** "19:00 a 04:00" — lo que se le muestra al cliente como horario. */
  hoursLabel: string;
  /** Texto listo para mostrar al cliente cuando `open` es false (con el horario si corresponde). Vacío si está abierto. */
  closedText: string;
  /** Aviso opcional cuando se atiende fuera de horario ("Hoy seguimos atendiendo…"). Vacío en los demás casos. */
  noticeText: string;
  cashEnabled: boolean;
  allowPromoWithItems: boolean;
  queueEnabled: boolean;
}

const two = (hour: number) => String(hour).padStart(2, '0');

export function hoursLabel(opensHour: number, closesHour: number): string {
  return `${two(opensHour)}:00 a ${two(closesHour)}:00`;
}

export function computeServiceStatus(row: ServiceStatusRow, now: Date): ServiceStatus {
  const label = hoursLabel(row.schedule_opens_hour, row.schedule_closes_hour);
  const insideSchedule =
    classifyServiceWindow(now, { opensHour: row.schedule_opens_hour, closesHour: row.schedule_closes_hour }) === 'open';

  let reason: ServiceReason;
  if (row.manually_closed) reason = 'manual_closed';
  else if (insideSchedule) reason = 'open';
  else if (row.extended_service_enabled) reason = 'extended';
  else reason = 'outside_hours';

  const open = reason === 'open' || reason === 'extended';
  const closedText =
    reason === 'manual_closed'
      ? row.closed_message
      : reason === 'outside_hours'
        ? `${row.closed_message}\nHorario de atención: ${label}.`
        : '';

  return {
    open,
    reason,
    hoursLabel: label,
    closedText,
    noticeText: reason === 'extended' ? row.extended_message : '',
    cashEnabled: row.cash_enabled,
    allowPromoWithItems: row.allow_promo_with_items,
    queueEnabled: row.queue_enabled,
  };
}
