import type { AgentModel, AgentModelInput } from '../sarco-agent/core/model';
import type { ProofFacts } from './proof-analysis';

/**
 * Lectura del comprobante con visión. Puerto directo de sarcoRestaurant
 * (src/lib/payment-proof/analysis-vision.ts). Módulo PURO — el modelo se
 * inyecta (`AgentModel`, el mismo puerto del núcleo del agente).
 *
 * Convierte una imagen en HECHOS: banco, cuenta receptora, titular, monto,
 * fecha, referencia. Nada más — el juicio es de `proof-analysis.ts`.
 *
 * El prompt NO menciona la cuenta ni el monto esperado a propósito: un
 * modelo al que se le enseña la respuesta correcta tiende a verla donde no
 * está. La comparación la hace después un `===` sin imaginación.
 *
 * Validación manual (no zod, que este backend no tiene como dependencia —
 * mismo criterio que `sarco-agent/openai/adapter.ts`), no menos estricta:
 * una respuesta que no encaja se descarta ENTERA, nunca a medias.
 */

/**
 * 1500, no menos: `gpt-5-mini` es un modelo de razonamiento que gasta
 * tokens ANTES de escribir una letra, y esos tokens salen del mismo techo.
 * Con un techo más bajo la respuesta vuelve incompleta y sin una sola letra
 * de JSON — sarcoRestaurant lo midió en producción (ver el original).
 */
export const PROOF_VISION_MAX_OUTPUT_TOKENS = 1500;
/** Corre dentro del webhook: si tarda más, se abandona la lectura — perder el análisis es molesto, perder el comprobante no. */
export const PROOF_VISION_TIMEOUT_MS = 15_000;

export const PROOF_READER_PROMPT = `Eres un lector de comprobantes de pago bolivianos (transferencias y pagos por QR).

Mira la imagen y devuelve ÚNICAMENTE un objeto JSON, sin texto alrededor y sin bloques de código, con exactamente estas claves:

{
  "looksLikeReceipt": boolean,
  "legible": boolean,
  "bank": string | null,
  "destinationBank": string | null,
  "destinationAccount": string | null,
  "destinationHolder": string | null,
  "amount": number | null,
  "currency": string | null,
  "transactionRef": string | null,
  "paidAtLocal": string | null
}

Reglas:
- "looksLikeReceipt": true solo si la imagen es un comprobante, recibo o captura de una transferencia o pago. Una foto de comida, una conversación, un QR sin pagar o una captura de otra cosa es false.
- "legible": false si la imagen está tan borrosa, cortada u oscura que no puedes leer los datos del pago.
- "bank" es el banco o la app que EMITE el comprobante (el membrete de arriba).
- "destinationBank" es el banco que RECIBE el dinero ("banco destino", "del banco" junto a la cuenta de destino). Suele ser distinto del membrete. Si no aparece, null.
- "destinationAccount" y "destinationHolder" son de quien RECIBE el dinero (destino, beneficiario, "cuenta destino", "a la cuenta", "se acreditó a la cuenta", "para"), NUNCA de quien lo envía ("originante", "remitente", "cuenta de origen", "se debitó de", "enviado por", "realizado por"). Si la imagen solo muestra al remitente, deja ambos en null.
- En un pago con QR, quien cobra puede aparecer como "solicitante" o "beneficiario", y quien paga como "remitente": el solicitante del QR es el DESTINO.
- Si la imagen no separa origen y destino y solo hay un nombre junto al monto (por ejemplo en Yape), ese es el destino; la cuenta y el banco que figuren en los datos de la transacción son también los del destino.
- Copia la cuenta TAL COMO SE VE, incluidos asteriscos o guiones del enmascarado.
- "amount": solo el número, sin símbolo ni separador de miles. Usa punto decimal.
- "currency": "BOB" para bolivianos (Bs), "USD" para dólares.
- "transactionRef": el número de transacción, operación, comprobante o autorización.
- "paidAtLocal": fecha y hora del pago en formato "AAAA-MM-DDTHH:mm", hora local de Bolivia. Si falta la hora o el año, devuelve null.
- Si un dato no aparece en la imagen o no lo lees con seguridad, devuelve null en ese campo. NO adivines, NO completes y NO uses ejemplos.`;

/** El mensaje que se le manda al modelo: la instrucción y la imagen. */
export function buildProofReadInput(dataUrl: string): AgentModelInput[] {
  return [
    { role: 'system', content: PROOF_READER_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'Lee este comprobante.' },
        // `high`: el número de cuenta y el monto son texto pequeño.
        { type: 'input_image', image_url: dataUrl, detail: 'high' },
      ],
    },
  ];
}

function optionalText(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : '';
  return s.length > 0 ? s : null;
}

/** Un modelo puede devolver `"48,00"` o `"Bs 48.00"` pese a lo que pida el prompt; se acepta lo inequívoco y se descarta el resto. */
function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const limpio = value.replace(/[^\d,.-]/g, '').replace(',', '.');
  const n = Number(limpio);
  return limpio.length > 0 && Number.isFinite(n) ? n : null;
}

/** Recorta al primer `{` y al último `}`: un modelo puede envolver el JSON en ```json o precederlo de una frase. */
function recortarJson(text: string): string | null {
  const inicio = text.indexOf('{');
  const fin = text.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) return null;
  return text.slice(inicio, fin + 1);
}

/** Convierte la respuesta cruda en hechos. `null` si la forma no es utilizable — se descarta entera, nunca a medias. */
export function parseProofFacts(text: string): ProofFacts | null {
  const json = recortarJson(text ?? '');
  if (json === null) return null;
  let crudo: unknown;
  try {
    crudo = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof crudo !== 'object' || crudo === null || Array.isArray(crudo)) return null;
  const r = crudo as Record<string, unknown>;
  if (typeof r.looksLikeReceipt !== 'boolean' || typeof r.legible !== 'boolean') return null;

  return {
    looksLikeReceipt: r.looksLikeReceipt,
    legible: r.legible,
    bank: optionalText(r.bank),
    destinationBank: optionalText(r.destinationBank),
    destinationAccount: optionalText(r.destinationAccount),
    destinationHolder: optionalText(r.destinationHolder),
    amount: optionalNumber(r.amount),
    currency: optionalText(r.currency),
    transactionRef: optionalText(r.transactionRef),
    paidAtLocal: optionalText(r.paidAtLocal),
  };
}

export type ProofReadResult =
  | { ok: true; facts: ProofFacts; model: string }
  /**
   * `code` lleva lo que dijo el proveedor (`http_error.429`, `timeout`,
   * `not_configured`) — nunca se tira: sin él, cuatro problemas distintos
   * (clave inválida, modelo inexistente, cuota agotada, red caída) se ven
   * todos iguales en el log.
   */
  | { ok: false; error: 'model_error' | 'invalid_response'; code?: string };

/** Lee un comprobante. Nunca lanza: un fallo del modelo no puede propagarse al webhook. */
export async function readProofFacts(model: AgentModel, dataUrl: string): Promise<ProofReadResult> {
  let res;
  try {
    res = await model.complete(buildProofReadInput(dataUrl), {
      maxOutputTokens: PROOF_VISION_MAX_OUTPUT_TOKENS,
      timeoutMs: PROOF_VISION_TIMEOUT_MS,
    });
  } catch {
    return { ok: false, error: 'model_error', code: 'threw' };
  }
  if (!res.ok) {
    const code = res.status === undefined ? res.error : `${res.error}.${res.status}`;
    return { ok: false, error: 'model_error', code };
  }
  const facts = parseProofFacts(res.text);
  if (facts === null) return { ok: false, error: 'invalid_response' };
  return { ok: true, facts, model: res.model };
}
