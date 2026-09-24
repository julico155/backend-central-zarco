import {
  NO_ARGUMENTS,
  type AgentTool,
  type AgentToolContext,
  type AgentToolOutcome,
} from './registry';

/**
 * `request_human` — el agente reconoce que aquí ya no ayuda. Puerto directo
 * de sarcoRestaurant (src/lib/agent/tools/request-human.ts).
 *
 * Calla al agente y avisa al equipo (best-effort). El cliente NO recibe nada
 * — ver `../handoff/handoff.service.ts` para el porqué.
 */

export const REQUEST_HUMAN = 'request_human';

export interface HandoffPort {
  escalate(input: {
    customerPhone: string;
    sourceMessageId: string;
    /** Lo que escribió el cliente; viaja al aviso del equipo, no al modelo. */
    inboundText: string;
  }): Promise<{
    /** ¿La conversación quedó derivada — pausada y con el equipo avisado? */
    handed: boolean;
  }>;
}

export interface RequestHumanToolResult {
  handed: boolean;
}

export function createRequestHumanAction(port: HandoffPort): AgentTool {
  return {
    definition: {
      name: REQUEST_HUMAN,
      description:
        'Deriva la conversación a una persona del equipo y deja de responder ' +
        'tú. Úsala cuando el cliente trae una queja o un reclamo, cuando algo ' +
        'salió mal con su pedido, cuando pide hablar con una persona, o cuando ' +
        'se nota molesto. NO la uses para algo que puedes resolver: un precio ' +
        'es get_menu_items, ver qué hay es send_menu, y una duda normal es ' +
        'answer_directly. Tampoco por un "gracias" ni por un mensaje seco que ' +
        'se arregla contestando bien. Y NUNCA por escribir seguido: un saludo, ' +
        'varios mensajes cortos uno detrás de otro ("hola", "zarco", "como ' +
        'estas", "quiero ordenar") o un cliente que pide a menudo son una ' +
        'conversación normal empezando, no un problema. Que alguien quiera ' +
        'pedir o te dicte su pedido tampoco se deriva: eso es send_menu, ' +
        'aunque lo repita. Y una pregunta que no sabes contestar NO se deriva: ' +
        'se dice que no lo sabes, con answer_directly. En particular, cuánto ' +
        'sale el envío o el delivery nunca es motivo para derivar — se contesta ' +
        'pidiéndole la ubicación, que el sistema la cotiza solo. SÍ se deriva, en ' +
        'cambio, todo lo que pregunte por un pedido YA hecho: en qué va, si ya ' +
        'salió, cuánto falta para que llegue. Eso no lo puedes ver por ningún lado ' +
        'y solo una persona puede mirarlo. Ante la duda ' +
        'entre derivar y contestar, CONTESTA: derivar te deja mudo dos horas, ' +
        'y una respuesta imperfecta se arregla con el mensaje siguiente.',
      parameters: NO_ARGUMENTS,
    },
    producesUserVisibleEffect: true,
    effectCompletesTurn: true,
    async execute(context: AgentToolContext): Promise<AgentToolOutcome> {
      const { handed } = await port.escalate({
        customerPhone: context.customerPhone,
        sourceMessageId: context.sourceMessageId,
        inboundText: context.inboundText,
      });

      const toolResult: RequestHumanToolResult = { handed };

      return {
        result: toolResult,
        userVisibleEffectConfirmed: handed,
        silenceAfterReply: !handed,
      };
    },
  };
}
