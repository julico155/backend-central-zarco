import {
  NO_ARGUMENTS,
  type AgentTool,
  type AgentToolContext,
  type AgentToolOutcome,
} from './registry';

/**
 * Las dos primeras herramientas de negocio. Puerto directo de
 * sarcoRestaurant (src/lib/agent/tools/menu-tools.ts, Fase 6D.2F.5B).
 *
 * SOLO `get_menu_items` está conectada en esta fase (2B), directo a
 * ProductsService/CategoriesService de Backend Central — no depende de
 * `menu_sessions`. `send_menu` sí depende del Shared Menu Dispatch
 * (`menu_sessions`, claim, ledger) de sarcoRestaurant, que esta fase
 * explícitamente NO porta: se deja el PUERTO (`MenuDispatchPort`,
 * `OpenOrderPort`) y la orquestación pura (`createSendMenuTool`) listos, pero
 * sin implementación — 2C debe escribir el dispatcher real e inyectarlo al
 * catálogo de acciones en `../sarco-agent.module.ts`.
 */

// ── get_menu_items ──────────────────────────────────────────────────────────

/** Lo que el modelo llega a ver de un producto. Deliberadamente más pobre que la fila real. */
export interface MenuItemForModel {
  name: string;
  price: number;
  category: string;
  description?: string;
}

export interface MenuCatalogPort {
  /** Productos ACTIVOS y DISPONIBLES, en el orden en que se muestran. */
  listForModel(): Promise<MenuItemForModel[]>;
}

export const GET_MENU_ITEMS = 'get_menu_items';

export function createGetMenuItemsTool(catalog: MenuCatalogPort): AgentTool {
  return {
    definition: {
      name: GET_MENU_ITEMS,
      description:
        'Consulta el menú real de Don Zarco: nombre, precio y categoría de cada ' +
        'producto disponible. Úsala SOLO para una pregunta PUNTUAL sobre uno o ' +
        'dos productos concretos QUE EL CLIENTE HAYA NOMBRADO: cuánto cuesta ' +
        'algo, si existe tal producto. Los productos los acota el cliente, no ' +
        'tú: no conviertas una pregunta amplia en puntual eligiendo un par por ' +
        'tu cuenta. ' +
        'NO la uses para responder qué hay, qué opciones existen ni qué ' +
        'contiene una categoría entera (hamburguesas, bebidas, extras): eso se ' +
        'responde con send_menu. Nunca respondas de memoria.',
      parameters: NO_ARGUMENTS,
    },
    async execute() {
      const items = await catalog.listForModel();
      return {
        result: {
          currency: 'Bs',
          items,
          note:
            'No hay datos de ingredientes, alérgenos ni atributos dietéticos. ' +
            'No deduzcas de qué está hecho un producto por su nombre ni por su ' +
            'descripción. La descripción es copy de vitrina, el mismo texto que ' +
            'el cliente ya ve en la web: puedes repetirlo tal cual, pero de él ' +
            'no se concluye que algo sea vegetariano, vegano, sin carne, sin ' +
            'gluten, libre de alérgenos ni seguro para una alergia.',
        },
        // Sin `userVisibleEffectConfirmed`: leer una tabla no le enseña nada al cliente.
      };
    },
  };
}

// ── send_menu (puerto, sin implementar en esta fase — ver cabecera) ────────

export const SEND_MENU = 'send_menu';

export type MenuSendReason = 'explicit_request' | 'agent_suggestion';

export interface DispatchMenuResult {
  result: 'sent' | 'duplicate' | 'echo' | 'failed' | 'send_unknown' | 'skipped_location_in_batch';
}

export interface MenuDispatchPort {
  dispatch(input: {
    customerPhone: string;
    sourceMessageId: string;
    phoneNumberId: string | null;
    reason: MenuSendReason;
    replacesOrderId?: string | null;
    buttonText?: string;
    bodyText?: string;
  }): Promise<DispatchMenuResult>;
}

/** El pedido vivo del cliente, para no mandarle a armar OTRO (2C: rearme de pedido). */
export interface OpenOrderPort {
  findReplaceable(customerPhone: string): Promise<{
    orderId: string;
    orderNumber: string;
    totalAmount: number;
    isCash: boolean;
  } | null>;
}

export interface SendMenuToolResult {
  sent: boolean;
  status: DispatchMenuResult['result'];
}

/**
 * Envía el menú delegando en el dispatcher inyectado. Orquestación PURA,
 * portada tal cual — lo que falta es la implementación de `MenuDispatchPort`
 * (2C), no esta función.
 */
export function createSendMenuTool(
  dispatcher: MenuDispatchPort,
  openOrders?: OpenOrderPort,
  isExplicitMenuRequest: (text: string) => boolean = () => false,
): AgentTool {
  return {
    definition: {
      name: SEND_MENU,
      description:
        'Envía al cliente el menú interactivo de Don Zarco por WhatsApp. Úsala ' +
        'SIEMPRE que la respuesta tendría que enumerar VARIOS productos, una ' +
        'CATEGORÍA entera o lo que hay disponible: "qué tienen?", "qué ' +
        'hamburguesas hay?", "qué bebidas tienen?", "qué extras hay?", "qué ' +
        'opciones hay?". También cuando el cliente quiera elegir para pedir. ' +
        'Mandar el menú es mejor que reescribir el catálogo en el chat.',
      parameters: NO_ARGUMENTS,
    },
    producesUserVisibleEffect: true,
    effectCompletesTurn: true,
    async execute(context: AgentToolContext): Promise<AgentToolOutcome> {
      const reason: MenuSendReason = isExplicitMenuRequest(context.inboundText)
        ? 'explicit_request'
        : 'agent_suggestion';

      const rearmable = await (async () => {
        if (!openOrders) return null;
        try {
          return await openOrders.findReplaceable(context.customerPhone);
        } catch {
          return null;
        }
      })();

      const result = await dispatcher.dispatch({
        customerPhone: context.customerPhone,
        sourceMessageId: context.sourceMessageId,
        phoneNumberId: context.phoneNumberId,
        reason: rearmable === null ? reason : 'explicit_request',
        ...(rearmable === null
          ? {}
          : {
              replacesOrderId: rearmable.orderId,
            }),
      });

      const sent =
        result.result === 'sent' || result.result === 'duplicate' || result.result === 'echo';

      const toolResult: SendMenuToolResult = { sent, status: result.result };

      return { result: toolResult, userVisibleEffectConfirmed: sent };
    },
  };
}
