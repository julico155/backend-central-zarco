import { NO_ARGUMENTS, type AgentTool } from './registry';

/**
 * La acción de NO actuar. Puerto directo de sarcoRestaurant
 * (src/lib/agent/tools/answer-directly.ts, Fase 6D.2F.5B.1).
 *
 * No tiene `execute`: no consulta, no envía, no toca la base. Seleccionarla
 * significa "este turno no necesita ninguna acción de negocio antes de
 * responder". El core pide el texto en una segunda llamada normal, sin
 * herramientas.
 */

export const ANSWER_DIRECTLY = 'answer_directly';

export function createAnswerDirectlyAction(): AgentTool {
  return {
    definition: {
      name: ANSWER_DIRECTLY,
      description:
        'Responde con tus propias palabras, sin consultar ni enviar nada. ' +
        'Úsala cuando la respuesta no necesita datos del menú ni mandarlo: ' +
        'saludos, agradecimientos, horarios, dónde están, quién eres, ' +
        'conversación normal, o cuando no tienes la información y hay que ' +
        'decirlo. También cuando preguntan cuánto sale el envío o el delivery: ' +
        'no das el monto, le pides que comparta su ubicación y el sistema se lo ' +
        'cotiza. NO la uses cuando preguntan por un pedido YA hecho —en qué va, ' +
        'si ya salió, cuánto falta para que llegue—: eso no lo puedes ver y es ' +
        'request_human. Ojo con la diferencia, que se parecen al leerlas: cuánto ' +
        'CUESTA el envío se contesta pidiendo la ubicación; cuánto TARDA en llegar ' +
        'se deriva. NO la uses para escaparte de mandar el menú: si el cliente ' +
        'quiere ver qué hay, qué opciones existen o qué contiene una categoría, ' +
        'eso es send_menu, y contestarlo hablando sería enumerarle el catálogo ' +
        'en el chat. Tampoco la uses para responder de memoria el precio de un ' +
        'PRODUCTO del menú ni si existe: eso es get_menu_items.',
      parameters: NO_ARGUMENTS,
    },
    // Sin `execute` a propósito: no hay nada que ejecutar.
  };
}
