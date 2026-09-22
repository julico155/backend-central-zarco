import { HttpStatus } from '@nestjs/common';
import { DomainException } from '../common/exceptions/domain-exception';
import { ApiClientKind } from '../common/guards/service-auth.guard';
import { NotificationJobPayload } from '../notifications-out/notification-job.types';

/**
 * Modo sombra de POST /orders: crear el pedido central (o la solicitud fuera
 * de horario) de verdad pero SIN ningún efecto externo. Existe solo para
 * probar la integración contra datos reales sin escribirle a nadie.
 *
 * Es una capacidad privilegiada (silencia un aviso que el cliente espera), así
 * que está cerrada por defecto y se abre explícitamente por entorno, no por
 * código: `SHADOW_ORDER_API_CLIENTS=<api_client>,...`. Vacío = nadie puede
 * usarla, que es lo que tiene que pasar en producción.
 */
export class NotificationSuppressionNotAllowedError extends DomainException {
  constructor(apiClient: string) {
    super(
      'notification_suppression_not_allowed',
      HttpStatus.FORBIDDEN,
      `El api_client '${apiClient}' no está autorizado a usar suppressNotifications.`,
      { apiClient },
    );
  }
}

/**
 * El modo sombra solo está soportado dentro del horario normal.
 *
 * En la ventana `late_review`, POST /orders no crea un pedido: crea una
 * `late_order_request` que después alguien acepta o rechaza desde el
 * mostrador, y ESA decisión dispara su propio aviso (`late_request_decision`)
 * desde LateOrderRequestsService. Como el estado de supresión no se persiste
 * en ningún lado — es un dato de la request, no de la fila —, el pedido
 * sombra quedaría como una bomba de tiempo: silencioso al crearse y ruidoso
 * horas después, cuando nadie se acuerde de que era una prueba.
 *
 * Persistirlo pide una columna y una migración, que no entran en esta fase.
 * Mientras tanto la respuesta honesta es rechazar: mejor un 409 claro ahora
 * que un mensaje inesperado a un cliente real más tarde.
 */
export class ShadowLateReviewNotSupportedError extends DomainException {
  constructor() {
    super(
      'shadow_late_review_not_supported',
      HttpStatus.CONFLICT,
      'Los pedidos en modo sombra solo pueden crearse dentro del horario normal, no en la ventana de revisión fuera de horario.',
    );
  }
}

/**
 * Un JWT de staff queda marcado con el api_client 'pos', el mismo nombre que
 * puede tener un token de servicio: sin mirar `kind`, poner 'pos' en la
 * allowlist le daría la capacidad a cualquier cajero logueado. Por eso el
 * modo sombra exige autenticación de servicio (bearer estático) además de
 * estar en la lista.
 */
export function canSuppressNotifications(
  apiClient: string,
  apiClientKind: ApiClientKind,
  allowedApiClients: readonly string[],
): boolean {
  if (apiClientKind !== 'service') return false;
  return allowedApiClients.includes(apiClient);
}


/**
 * Lo único que POST /orders necesita de NotificationsOutService. Los tres
 * avisos que dispara este endpoint (`order_received`, `qr_confirmation`,
 * `late_request_alert`) salen por acá en vez de tocar el servicio real, para
 * que el modo sombra pueda cambiar el destino entero de una sola vez.
 */
export interface OrderNotifier {
  notifyNow(job: NotificationJobPayload): Promise<void>;
}

/**
 * Sumidero del modo sombra: descarta el aviso sin encolarlo.
 *
 * Tiene que interceptar ANTES de `NotificationsOutService.notifyNow`, no
 * dentro: ese método primero inserta en `notification_jobs` y recién después
 * despacha, así que evitar solo el envío dejaría la fila 'pending' y
 * NotificationRecoveryCron la levantaría un minuto más tarde y escribiría
 * igual. En sombra no se crea ningún notification_job, punto.
 *
 * Es un sumidero y no una lista de kinds prohibidos a propósito: un aviso
 * nuevo que se agregue mañana a este endpoint queda silenciado solo, sin que
 * haya que acordarse de sumarlo a ninguna lista.
 */
export function shadowNotifier(onSuppressed: (job: NotificationJobPayload) => void): OrderNotifier {
  return {
    notifyNow: async (job) => {
      onSuppressed(job);
    },
  };
}
