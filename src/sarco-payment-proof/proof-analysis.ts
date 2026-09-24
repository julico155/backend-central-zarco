/**
 * Veredicto del comprobante. Puerto directo de sarcoRestaurant
 * (src/lib/payment-proof/analysis.ts). Módulo PURO: dado el mismo hecho,
 * siempre da el mismo veredicto — el modelo NO decide, solo lee.
 *
 * Nada de lo que sale de aquí acepta ni rechaza un pago (eso sigue siendo
 * `PaymentAttemptsService.decide`, una decisión humana, fuera de esta fase).
 * Esto solo le pone delante a quien revisa lo que un vistazo con prisa se
 * salta.
 */
import {
  matchesAccount,
  matchesBank,
  matchesHolder,
  type ExpectedAccount,
  type FieldMatch,
} from './expected-account';

export const PROOF_VERDICTS = ['ok', 'suspicious', 'unreadable'] as const;
export type ProofVerdict = (typeof PROOF_VERDICTS)[number];

export const PROOF_ANALYSIS_REASONS = [
  'account_mismatch',
  'holder_mismatch',
  'bank_mismatch',
  'reference_reused',
  'stale_receipt',
  'not_a_receipt',
  'unreadable',
  /**
   * Solo se emite cuando el comprobante ERA legible y el monto leído no es
   * ninguno de los dos pagos válidos. Un monto ilegible es `unreadable`, no
   * esto: no se acusa a una foto borrosa de lo mismo que a un monto cambiado.
   */
  'amount_mismatch',
] as const;
export type ProofAnalysisReason = (typeof PROOF_ANALYSIS_REASONS)[number];

/** Contra cuál de los dos importes válidos cuadró lo leído — pregunta operativa, no de confianza. */
export const PROOF_AMOUNT_LABELS = ['pago_total', 'pago_productos', 'revisar_monto'] as const;
export type ProofAmountLabel = (typeof PROOF_AMOUNT_LABELS)[number];

export interface ExpectedAmounts {
  /** Solo la comida. En delivery es lo que el QR pide de verdad. */
  subtotal: number;
  /** Comida más envío. */
  total: number;
}

/**
 * Comparación EXACTA, sin tolerancia — preservado tal cual de
 * sarcoRestaurant (un margen es una rendija: un comprobante retocado en un
 * boliviano pasaría, y las dos cifras salen del carrito, no de una
 * estimación). `null` o no-finito = `revisar_monto`.
 */
export function labelForAmount(amount: number | null, expected: ExpectedAmounts): ProofAmountLabel {
  if (amount === null || !Number.isFinite(amount)) return 'revisar_monto';
  if (amount === expected.total) return 'pago_total';
  if (amount === expected.subtotal) return 'pago_productos';
  return 'revisar_monto';
}

/** Lo que la lectura afirma haber visto. Todo anulable: lo que no está o no se entiende llega `null`, y `null` nunca acusa. */
export interface ProofFacts {
  looksLikeReceipt: boolean;
  legible: boolean;
  bank: string | null;
  destinationBank: string | null;
  destinationAccount: string | null;
  destinationHolder: string | null;
  amount: number | null;
  currency: string | null;
  transactionRef: string | null;
  /** `YYYY-MM-DDTHH:mm`, hora local de Bolivia. `null` si no se lee. */
  paidAtLocal: string | null;
}

export interface ProofJudgeContext {
  expected: ExpectedAccount;
  receivedAtMs: number;
  /** ¿Ese número de transacción ya está registrado en otro comprobante? */
  referenceReused: boolean;
  /** Ausente/`null` = no hay pedido contra el que comparar; la etiqueta queda `null`, nunca "cuadra". */
  amounts?: ExpectedAmounts | null;
}

export interface ProofChecks {
  account: FieldMatch;
  holder: FieldMatch;
  bank: FieldMatch;
}

export interface ProofJudgement {
  verdict: ProofVerdict;
  reasons: ProofAnalysisReason[];
  checks: ProofChecks;
  amountLabel: ProofAmountLabel | null;
}

/** Bolivia entera va en UTC−4 todo el año, sin horario de verano — constante, no `Intl`. */
const BOLIVIA_UTC_OFFSET_MS = 4 * 60 * 60 * 1000;

/** Seis horas de margen: se busca el comprobante de anteayer reenviado, no un reloj mal puesto. */
export const STALE_RECEIPT_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/** `null` si `value` no tiene exactamente la forma `YYYY-MM-DDTHH:mm` — no se adivinan formatos. */
export function parseBolivianLocalTime(value: string | null): number | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const utc = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  if (Number.isNaN(utc)) return null;
  return utc + BOLIVIA_UTC_OFFSET_MS;
}

/**
 * Juzga un comprobante ya leído. Primero descarta lo que no se puede
 * juzgar —ilegible, o ni siquiera un comprobante— y solo después contrasta:
 * un recorte borroso no es un ladrón.
 */
export function judgeProof(facts: ProofFacts, ctx: ProofJudgeContext): ProofJudgement {
  const sinContrastar: ProofChecks = { account: 'unknown', holder: 'unknown', bank: 'unknown' };

  const amounts = ctx.amounts ?? null;
  const etiqueta = (amount: number | null): ProofAmountLabel | null =>
    amounts === null ? null : labelForAmount(amount, amounts);

  if (!facts.looksLikeReceipt) {
    return {
      verdict: 'suspicious',
      reasons: ['not_a_receipt'],
      checks: sinContrastar,
      amountLabel: etiqueta(null),
    };
  }
  if (!facts.legible) {
    // El veredicto NO sube a `suspicious`: no se acusa a una foto mala de lo
    // mismo que a un monto cambiado.
    return {
      verdict: 'unreadable',
      reasons: ['unreadable'],
      checks: sinContrastar,
      amountLabel: etiqueta(null),
    };
  }

  const checks: ProofChecks = {
    account: matchesAccount(facts.destinationAccount, ctx.expected.accountNumbers),
    holder: matchesHolder(facts.destinationHolder, ctx.expected.holderNames),
    bank: matchesBank(facts.destinationBank, ctx.expected.bankNames),
  };

  // La CUENTA manda sobre el NOMBRE: con la cuenta confirmada, un nombre que
  // no cuadra dice más del formato del comprobante que del pago (algunos
  // bancos imprimen el remitente más cerca del bloque "destino" que el
  // destinatario real).
  const cuentaConfirmada = checks.account === 'match';

  const reasons: ProofAnalysisReason[] = [];
  if (checks.account === 'mismatch') reasons.push('account_mismatch');
  if (!cuentaConfirmada && checks.holder === 'mismatch') reasons.push('holder_mismatch');
  if (checks.bank === 'mismatch') reasons.push('bank_mismatch');
  if (ctx.referenceReused) reasons.push('reference_reused');

  const amountLabel = etiqueta(facts.amount);
  if (amountLabel === 'revisar_monto') reasons.push('amount_mismatch');

  const pagadoMs = parseBolivianLocalTime(facts.paidAtLocal);
  if (pagadoMs !== null && Math.abs(ctx.receivedAtMs - pagadoMs) > STALE_RECEIPT_TOLERANCE_MS) {
    reasons.push('stale_receipt');
  }

  // Nada que contrastar (cuenta/nombre/banco no configurados o ilegibles):
  // decir "ok" sería un aprobado que nadie dio.
  const seContrastoAlgo =
    checks.account !== 'unknown' || checks.holder !== 'unknown' || checks.bank !== 'unknown';
  if (reasons.length === 0 && !seContrastoAlgo) {
    return { verdict: 'unreadable', reasons: ['unreadable'], checks, amountLabel };
  }

  return {
    verdict: reasons.length > 0 ? 'suspicious' : 'ok',
    reasons,
    checks,
    amountLabel,
  };
}
