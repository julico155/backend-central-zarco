/**
 * Qué hace falta para que el modelo pueda derivar. Puerto directo de
 * sarcoRestaurant (src/lib/agent/handoff/handoff-gate.ts, 04-09-2026): no
 * cuenta mensajes, decide con el mensaje delante — o pide una persona con
 * todas las letras, o dice algo que solo una persona puede arreglar.
 */
export interface HandoffGateInput {
  /** ¿Pidió una persona con todas las letras? Ver `explicit-request.ts`. */
  explicitRequest: boolean;
  /** ¿El mensaje trae un problema que solo una persona resuelve? Ver `problem-signal.ts`. */
  problemSignal: boolean;
}

export function canHandOff(input: HandoffGateInput): boolean {
  return input.explicitRequest || input.problemSignal;
}
