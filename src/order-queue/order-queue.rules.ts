/** Cuánto tiene un cliente avisado ("ya puedes pedir") para hacer su pedido antes de perder el cupo. */
export const ADMISSION_TTL_MS = 20 * 60 * 1000;

/** Un cliente que sigue en espera después de tanto tiempo ya se fue: se libera su lugar en la fila sin avisarle. */
export const WAITING_TTL_MS = 3 * 60 * 60 * 1000;

/** No se le repite el "espera a que te avisemos" a un cliente que escribe seguido. */
export const REMINDER_COOLDOWN_MS = 5 * 60 * 1000;

/** Si el cliente acaba de hacer su pedido, un reintento por timeout no debe toparse con la fila. */
export const RECENTLY_USED_GRACE_MS = 2 * 60 * 1000;

/**
 * Cupos libres = capacidad − pedidos en cocina − cupos ya prometidos (clientes avisados que todavía no pidieron).
 * Contar lo prometido evita avisar a 5 clientes con 5 cupos y a otros 5 un minuto después con los mismos 5.
 */
export function freeSlots(capacity: number, kitchenLoad: number, reserved: number): number {
  return Math.max(0, capacity - kitchenLoad - reserved);
}

/**
 * A cuántos clientes de la fila se les avisa AHORA. No se avisa de a uno por cada pedido que sale: se espera a que
 * haya al menos `batch` cupos (5 por defecto) — salvo que en la fila haya menos gente que eso, en cuyo caso alcanza
 * con que quepan todos. Cuando se avisa, se avisa a tantos como cupos haya (y gente en espera).
 */
export function releaseCount(free: number, batch: number, waiting: number): number {
  if (waiting <= 0 || free <= 0) return 0;
  return free >= Math.min(batch, waiting) ? Math.min(free, waiting) : 0;
}

/** Un cliente nuevo entra directo (sin esperar) solo si hay cupo Y nadie está esperando antes que él. */
export function canAdmitDirectly(free: number, waiting: number): boolean {
  return free > 0 && waiting === 0;
}

export function shouldSendReminder(lastReminderAt: Date | null, now: Date): boolean {
  return lastReminderAt === null || now.getTime() - lastReminderAt.getTime() >= REMINDER_COOLDOWN_MS;
}

/** Texto de WhatsApp cuando se libera un cupo (el copy de "estamos saturados" lo arma el agente al responder). */
export function queueReadyText(): string {
  const minutes = ADMISSION_TTL_MS / 60_000;
  return (
    '¡Ya hay lugar para tu pedido! 🎉\n' +
    'Toca el botón *Ver menú* del mensaje anterior, o escríbenos *menú* y te lo enviamos de nuevo.\n' +
    `Tienes ${minutes} minutos para hacer tu pedido.`
  );
}
