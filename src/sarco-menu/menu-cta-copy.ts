import { businessHoursClock } from '../sarco-agent/business/facts';
import type { MenuSendDeliveryReason } from '../database/types';

/**
 * Copy del CTA "Ver menú". Puerto reducido de sarcoRestaurant
 * (src/lib/kapso/messages.ts): se portan las variantes por `reason`
 * (`MenuSendReason` de 2B). NO se porta el sistema de `MenuCtaContext`
 * (qué venía preguntando el cliente) — esta fase no lo necesita porque
 * `MenuDispatchPort.dispatch` (2B) no lo declara; si se necesita más
 * adelante, se agrega ahí primero.
 */

export const MENU_CTA_BUTTON_TEXT = 'Ver menú';

export function menuCtaBodyText(reason: MenuSendDeliveryReason): string {
  switch (reason) {
    case 'explicit_resend':
      return (
        'Te lo mando de nuevo 👇 Tocá el botón y ahí elegís lo que quieras, ' +
        'ves el total y confirmás tu pedido.'
      );
    case 'agent_suggestion':
      return (
        'Todo lo que tenemos está acá 👇 Tocá el botón, mirá los precios y armá ' +
        'tu pedido en un minuto.'
      );
    case 'explicit_request':
    case 'qa_trigger':
    default:
      return (
        `Hola, soy Don Zarco 👋 Atendemos todos los días de ${businessHoursClock()}. ` +
        'Toca el botón para ver el menú, elegir lo que quieras y mandar tu pedido desde ahí mismo.'
      );
  }
}
