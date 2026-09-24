import type { AgentModelContentPart, AgentModelMessage } from './model';
import type {
  AgentMessageActor,
  AgentMessageContentType,
  AgentMessageRole,
} from '../../database/agent-types';

/**
 * Ventana de contexto del modelo. Puerto directo de sarcoRestaurant
 * (src/lib/agent/core/context.ts, Fase 6D.2F.3): la base guarda el historial
 * completo; el modelo recibe solo una ventana recortada.
 */

export const CONTEXT_WINDOW_HOURS = 24;
export const CONTEXT_MAX_MESSAGES = 24;

/** Lista blanca fail-closed: lo que no esté aquí no llega al modelo. */
export type AutomationAction =
  | 'send_menu'
  | 'human_handoff'
  | 'proof_reminder'
  | 'kitchen_note'
  | 'proof_wait'
  | 'cash_wait'
  | 'delivery_relay'
  | 'location_reminder'
  | 'cash_reprompt';

const AUTOMATION_ACTIONS: readonly AutomationAction[] = [
  'send_menu',
  'human_handoff',
  'proof_reminder',
  'kitchen_note',
  'proof_wait',
  'cash_wait',
  'delivery_relay',
  'location_reminder',
  'cash_reprompt',
];

export function toAutomationAction(raw: unknown): AutomationAction | null {
  return typeof raw === 'string' && (AUTOMATION_ACTIONS as readonly string[]).includes(raw)
    ? (raw as AutomationAction)
    : null;
}

/** Subconjunto deliberado de `agent_messages`: sin identificadores del proveedor ni metadata cruda. */
export interface ContextMessage {
  actor: AgentMessageActor;
  role: AgentMessageRole;
  content: string | null;
  contentType: AgentMessageContentType;
  messageTimestamp: string;
  automationAction?: AutomationAction | null;
}

export function actorToModelRole(actor: AgentMessageActor): AgentMessageRole {
  return actor === 'customer' ? 'user' : 'assistant';
}

/**
 * ¿Esta fila del CLIENTE puede viajar al modelo como palabras suyas? Filtro
 * por TIPO, no por contenido: un texto generado por el proveedor en un tipo
 * de mensaje no textual (p.ej. una reacción) no se convierte en palabras del
 * cliente.
 */
export function isCustomerConversationalText(
  message: ContextMessage,
): message is ContextMessage & { content: string } {
  const tipoAporta = message.contentType === 'text' || message.contentType === 'image';
  return tipoAporta && typeof message.content === 'string' && message.content.trim() !== '';
}

/** Lo que el modelo lee cuando el sistema hizo algo por su cuenta. `null` = la fila se omite. */
export function automationEventLine(action: AutomationAction | null | undefined): string | null {
  if (action === 'send_menu') {
    return 'Evento del canal: el sistema envió un menú interactivo al cliente.';
  }
  if (action === 'human_handoff') {
    return 'Evento del canal: el sistema derivó la conversación a una persona del equipo.';
  }
  if (action === 'proof_reminder') {
    return 'Evento del canal: el sistema le recordó al cliente que envíe el comprobante de su pedido.';
  }
  if (action === 'kitchen_note') {
    return 'Evento del canal: el sistema anotó en el pedido una preferencia que pidió el cliente.';
  }
  if (action === 'proof_wait') {
    return 'Evento del canal: el sistema le dijo al cliente que estamos revisando su comprobante y que espere.';
  }
  if (action === 'cash_wait') {
    return 'Evento del canal: el sistema le dijo al cliente que su pedido ya está en cocina y que espere.';
  }
  if (action === 'cash_reprompt') {
    return 'Evento del canal: el cliente escribió en vez de tocar CONFIRMAR o CANCELAR, y el sistema le volvió a mandar los dos botones.';
  }
  if (action === 'delivery_relay') {
    return 'Evento del canal: el cliente pidió un cambio con el pedido ya en cocina y el sistema le dijo que se lo diga al repartidor.';
  }
  if (action === 'location_reminder') {
    return 'Evento del canal: el pedido del cliente todavía no está cotizado y el sistema ya le habló de eso (le pidió su ubicación, o le dijo que estamos calculando el envío). NO le pidas el comprobante: sin cotizar no existe todavía ningún QR que pagar.';
  }
  return null;
}

export interface WorkingContextOptions {
  maxMessages?: number;
  /** Texto del entrante actual que se adjunta aparte, junto a su imagen. */
  dropTrailingUserText?: string | null;
}

/**
 * Convierte el historial reciente en mensajes para el modelo. Conserva el
 * orden cronológico, descarta lo que no tiene texto (nunca lo sustituye por
 * un marcador inventado) y se queda con los últimos `maxMessages`.
 */
export function buildWorkingContext(
  messages: readonly ContextMessage[],
  options: WorkingContextOptions = {},
): AgentModelMessage[] {
  const max = options.maxMessages ?? CONTEXT_MAX_MESSAGES;
  if (max <= 0) return [];

  const projected = messages
    .map((m): AgentModelMessage | null => {
      if (m.actor === 'automation') {
        const evento = automationEventLine(m.automationAction);
        return evento === null ? null : { role: 'system', content: evento };
      }
      if (m.actor === 'customer') {
        return isCustomerConversationalText(m) ? { role: 'user', content: m.content } : null;
      }
      return typeof m.content === 'string' && m.content.trim() !== ''
        ? { role: actorToModelRole(m.actor), content: m.content }
        : null;
    })
    .filter((m): m is AgentModelMessage => m !== null);

  const recortado = projected.slice(-max);

  const cola = recortado[recortado.length - 1];
  const duplicado =
    options.dropTrailingUserText != null &&
    cola !== undefined &&
    cola.role === 'user' &&
    cola.content === options.dropTrailingUserText;

  return duplicado ? recortado.slice(0, -1) : recortado;
}

// ── Contexto de SELECCIÓN DE ACCIÓN ─────────────────────────────────────────

export const SELECTION_CONTEXT_MAX_MESSAGES = 12;

export function assistantEventLine(actor: AgentMessageActor): string | null {
  if (actor === 'ai') return 'Evento del canal: el asistente respondió al cliente.';
  if (actor === 'human') return 'Evento del canal: una persona del equipo respondió al cliente.';
  return null;
}

function isAssistantVoice(actor: AgentMessageActor): boolean {
  return actor === 'ai' || actor === 'human';
}

export const SESSION_GAP_MINUTES = 45;

const GAP_HORAS_DESDE_MINUTOS = 120;
const GAP_DIAS_DESDE_HORAS = 48;

/** La línea que marca un silencio largo entre dos mensajes. `null` si no lo hubo. */
export function sessionGapLine(previous: string, current: string): string | null {
  const desde = new Date(previous).getTime();
  const hasta = new Date(current).getTime();
  if (Number.isNaN(desde) || Number.isNaN(hasta)) return null;

  const minutos = Math.floor((hasta - desde) / 60_000);
  if (minutos < SESSION_GAP_MINUTES) return null;

  const cuanto =
    minutos < GAP_HORAS_DESDE_MINUTOS
      ? `${minutos} minutos`
      : Math.floor(minutos / 60) < GAP_DIAS_DESDE_HORAS
        ? `${Math.floor(minutos / 60)} horas`
        : `${Math.floor(minutos / 1440)} días`;

  return `Evento del canal: pasaron ${cuanto} sin mensajes.`;
}

function lastAssistantIndex(messages: readonly ContextMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (isAssistantVoice(m.actor) && typeof m.content === 'string' && m.content.trim() !== '') {
      return i;
    }
  }
  return -1;
}

export interface SelectionContextOptions {
  /** Partes del entrante actual cuando lleva imagen. Sustituyen al texto final. */
  inboundParts?: string | readonly AgentModelContentPart[];
  /** Texto REAL del entrante que abre el turno. OBLIGATORIO. */
  inboundText: string;
  maxMessages?: number;
}

/**
 * Ventana para la RONDA DE SELECCIÓN — vista distinta del mismo historial.
 * Decidir qué capacidad hace falta no necesita la prosa de los salientes
 * anteriores (solo el ÚLTIMO conserva su texto), porque esa prosa es
 * precisamente lo único que se puede imitar.
 */
export function buildSelectionContext(
  messages: readonly ContextMessage[],
  options: SelectionContextOptions,
): AgentModelMessage[] {
  const max = options.maxMessages ?? SELECTION_CONTEXT_MAX_MESSAGES;
  const visible = max <= 0 ? [] : messages;
  const antecedente = lastAssistantIndex(visible);

  const proyectar = (m: ContextMessage, esAntecedente: boolean): AgentModelMessage | null => {
    if (m.actor === 'customer') {
      return isCustomerConversationalText(m) ? { role: 'user', content: m.content } : null;
    }
    if (esAntecedente) {
      return { role: 'assistant', content: m.content as string };
    }
    const evento =
      m.actor === 'automation'
        ? automationEventLine(m.automationAction)
        : assistantEventLine(m.actor);
    return evento === null ? null : { role: 'system', content: evento };
  };

  const proyectados: { readonly msg: AgentModelMessage; readonly at: string }[] = [];
  for (let i = 0; i < visible.length; i += 1) {
    const m = visible[i];
    const proyectado = proyectar(m, i === antecedente);
    if (proyectado !== null) proyectados.push({ msg: proyectado, at: m.messageTimestamp });
  }

  const recortado = proyectados.slice(-max);

  const projected: AgentModelMessage[] = [];
  for (let i = 0; i < recortado.length; i += 1) {
    const hueco = i === 0 ? null : sessionGapLine(recortado[i - 1].at, recortado[i].at);
    if (hueco !== null) projected.push({ role: 'system', content: hueco });
    projected.push(recortado[i].msg);
  }

  if (options.inboundParts !== undefined) {
    const cola = projected[projected.length - 1];
    if (cola?.role === 'user' && cola.content === options.inboundText) projected.pop();
    projected.push({ role: 'user', content: options.inboundParts });
    return projected;
  }

  if (options.inboundText === '') return projected;

  const ultimo = projected[projected.length - 1];
  if (ultimo?.role !== 'user' || ultimo.content !== options.inboundText) {
    projected.push({ role: 'user', content: options.inboundText });
  }

  return projected;
}

/** Instante a partir del cual se lee historial, en ISO. */
export function contextWindowStart(now: string, hours: number = CONTEXT_WINDOW_HOURS): string {
  return new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();
}
