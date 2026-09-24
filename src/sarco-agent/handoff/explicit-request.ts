import { normalizeIntentText } from '../business/normalize-intent-text';

/**
 * "Quiero hablar con una persona" — detección determinística. Puerto directo
 * de sarcoRestaurant (src/lib/agent/handoff/explicit-request.ts).
 *
 * Exige un verbo de CONTACTO y un sustantivo de PERSONA juntos:
 *   · "una persona me dijo que tenían promo"  → persona sin contacto  → NO
 *   · "quiero hablar de mi pedido"            → contacto sin persona  → NO
 *   · "quiero hablar con una persona"         → las dos              → SÍ
 */

const CONTACTO =
  /\b(hablar|hablo|comunicar|comunicarme|contactar|pasame|paseme|pasarme|derivar|deriva|transferir|atiende|atienda|atiendan|atienden|atenderme)\b/;

const PERSONA =
  /\b(persona|humano|humana|alguien|encargad[oa]|due[ñn][oa]|jefe|jefa|gerente|operador|operadora|asesor|asesora|agente humano|un humano|el equipo|atencion al cliente|servicio al cliente)\b/;

const FRASES_DIRECTAS =
  /\b(atencion humana|agente humano|operador humano|con un humano|con una persona real)\b/;

/** `true` solo si el cliente pide hablar con una persona del equipo. */
export function isExplicitHumanRequest(text: string | null | undefined): boolean {
  if (typeof text !== 'string') return false;

  const norm = normalizeIntentText(text);
  if (norm === '') return false;

  if (FRASES_DIRECTAS.test(norm)) return true;
  return CONTACTO.test(norm) && PERSONA.test(norm);
}
