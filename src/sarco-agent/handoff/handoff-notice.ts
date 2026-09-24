/**
 * Aviso de "aquí hace falta una persona" — módulo PURO. Puerto directo de
 * sarcoRestaurant (src/lib/alerts/handoff-notice.ts). Texto plano (sin
 * parse_mode): NO se escapa HTML. Lleva teléfono y último mensaje del cliente
 * porque va al grupo privado del equipo; nunca prompts, tokens ni ids internos.
 */

export const HANDOFF_CATEGORY_LABELS: Record<string, string> = {
  handoff_requested: 'El cliente necesita hablar con una persona',
  handoff_spoken: 'El agente le dijo que lo atendería una persona',
  handoff_stuck_customer: 'No consigue hacer su pedido',
  handoff_menu_loop: 'No consigue hacer su pedido',
  payment_reviewed: 'Se acaba de revisar su comprobante',
};

/** Motivo desconocido → texto genérico, nunca el código crudo. */
export function handoffCategoryLabel(reason: string): string {
  return HANDOFF_CATEGORY_LABELS[reason] ?? 'La conversación necesita a una persona';
}

export const HANDOFF_EXCERPT_MAX = 200;

export function handoffExcerpt(text: string | null): string | null {
  const limpio = (text ?? '').replace(/\s+/g, ' ').trim();
  if (limpio === '') return null;
  return limpio.length <= HANDOFF_EXCERPT_MAX
    ? limpio
    : `${limpio.slice(0, HANDOFF_EXCERPT_MAX).trimEnd()}…`;
}

export interface HandoffNoticeInput {
  customerPhone: string;
  reason: string;
  lastMessage: string | null;
}

export function buildHandoffNotice(input: HandoffNoticeInput): string {
  const lineas = [
    '🙋 Atención humana — Don Zarco',
    '',
    `Motivo: ${handoffCategoryLabel(input.reason)}`,
    `Teléfono: ${input.customerPhone}`,
    `Abrir chat: https://wa.me/${input.customerPhone}`,
  ];
  const extracto = handoffExcerpt(input.lastMessage);
  if (extracto !== null) {
    lineas.push('', 'Último mensaje:', `"${extracto}"`);
  }
  lineas.push('', 'El agente quedó en pausa. Responde desde WhatsApp Business App.');
  return lineas.join('\n');
}
