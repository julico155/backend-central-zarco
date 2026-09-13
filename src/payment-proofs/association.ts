import { PaymentProofMatchMethod, PaymentProofRoutingException } from '../database/types';

/**
 * Portado de `resolveAssociation` (saas_smarky,
 * `src/lib/payment-proof/association.ts`). Módulo PURO: sin IA, sin
 * keywords, sin parecido de montos — cada decisión sale de una igualdad
 * exacta o un conjunto contado. Adaptado a `customer_id` en vez de
 * `customer_phone`, y a `notification_jobs` (kind='qr_confirmation') en vez
 * de columnas de confirmación en `orders`.
 *
 * `match: 'attached'` NUNCA lo produce este módulo — unirse a un episodio
 * abierto es una decisión de VIVEZA y solo puede tomarse con el candado
 * echado dentro de la transacción de routing (ver payment-proofs.service.ts).
 */

export const QR_DISCOVERY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const QR_AUTO_MATCH_WINDOW_MS = 4 * 60 * 60 * 1000;
export const QR_MATCH_FUTURE_SKEW_MS = 5 * 60 * 1000;
export const CLOSED_ORDER_STATUSES: readonly string[] = ['cancelled', 'delivered'];

export type AssociationMatch =
  | Extract<
      PaymentProofMatchMethod,
      'reply_to_qr' | 'single_open_qr_order' | 'current_qr_order' | 'duplicate' | 'unresolved'
    >
  | 'no_match';

export type PaymentAttemptOpenedAs = 'normal' | 'late';

export interface OrderCandidate {
  orderId: string;
  status: string;
  hasAcceptedProof: boolean;
  confirmationExternalMessageId: string | null;
  confirmationSentAt: Date | null;
}

export interface PriorSameFileProof {
  proofId: string;
  attemptId: string | null;
  orderId: string | null;
}

export interface AssociationInput {
  contextMessageId: string | null;
  receivedAt: Date | null;
  orders: OrderCandidate[];
  priorSameFile: PriorSameFileProof[];
}

export interface AssociationResult {
  match: AssociationMatch;
  orderId: string | null;
  candidateCount: number;
  routingException: PaymentProofRoutingException | null;
  duplicateOfProofId: string | null;
  openedAs: PaymentAttemptOpenedAs | null;
}

function isReplyToQr(order: OrderCandidate, input: AssociationInput): boolean {
  return (
    order.confirmationExternalMessageId !== null &&
    order.confirmationExternalMessageId === input.contextMessageId // igualdad EXACTA, nunca includes/prefijo
  );
}

function qrAgeMs(order: OrderCandidate, input: AssociationInput): number | null {
  if (order.confirmationSentAt === null || input.receivedAt === null) return null;
  const ms = input.receivedAt.getTime() - order.confirmationSentAt.getTime();
  return Number.isFinite(ms) ? ms : null;
}

function withinWindow(ageMs: number | null, windowMs: number): boolean {
  if (ageMs === null) return false;
  return ageMs >= -QR_MATCH_FUTURE_SKEW_MS && ageMs <= windowMs;
}

function isDiscovered(order: OrderCandidate, input: AssociationInput): boolean {
  return (
    order.confirmationSentAt !== null && withinWindow(qrAgeMs(order, input), QR_DISCOVERY_WINDOW_MS)
  );
}

function isAutoMatchCandidate(order: OrderCandidate, input: AssociationInput): boolean {
  if (!isDiscovered(order, input)) return false;
  if (order.hasAcceptedProof) return false;
  if (CLOSED_ORDER_STATUSES.includes(order.status)) return false;
  return withinWindow(qrAgeMs(order, input), QR_AUTO_MATCH_WINDOW_MS);
}

function discardReason(input: AssociationInput): PaymentProofRoutingException | null {
  const discovered = input.orders.filter((o) => isDiscovered(o, input));
  if (discovered.length === 0) return null;
  const alive = discovered.filter(
    (o) => !o.hasAcceptedProof && !CLOSED_ORDER_STATUSES.includes(o.status),
  );
  if (alive.length > 0) return 'expired_target'; // sigue esperando su pago: descalificado SOLO por el reloj
  if (discovered.some((o) => CLOSED_ORDER_STATUSES.includes(o.status))) return 'closed_order';
  return 'payment_already_accepted';
}

function openedAsFor(order: OrderCandidate, input: AssociationInput): PaymentAttemptOpenedAs {
  const age = qrAgeMs(order, input);
  if (age === null) return 'normal';
  return age > QR_AUTO_MATCH_WINDOW_MS ? 'late' : 'normal';
}

export function resolveAssociation(input: AssociationInput): AssociationResult {
  const discovered = input.orders.filter((o) => isDiscovered(o, input));

  const exactMatches =
    input.contextMessageId === null ? [] : input.orders.filter((o) => isReplyToQr(o, input));
  const replyTarget = exactMatches.length === 1 ? exactMatches[0] : null;

  // NIVEL 0 — duplicado exacto, va primero.
  const original = input.priorSameFile.find((p) => p.attemptId !== null && p.orderId !== null);
  if (original !== undefined && original.orderId !== null) {
    if (replyTarget !== null && replyTarget.orderId !== original.orderId) {
      return {
        match: 'unresolved',
        orderId: null,
        candidateCount: discovered.length,
        routingException: 'signal_conflict',
        duplicateOfProofId: null,
        openedAs: null,
      };
    }
    return {
      match: 'duplicate',
      orderId: original.orderId,
      candidateCount: discovered.length,
      routingException: null,
      duplicateOfProofId: original.proofId,
      openedAs: 'normal',
    };
  }

  // NIVEL 1 — el cliente dijo a qué pedido pertenece.
  if (replyTarget !== null) {
    const blocked: PaymentProofRoutingException | null = replyTarget.hasAcceptedProof
      ? 'payment_already_accepted'
      : CLOSED_ORDER_STATUSES.includes(replyTarget.status)
        ? 'closed_order'
        : null;
    return {
      match: 'reply_to_qr',
      orderId: replyTarget.orderId,
      candidateCount: 1,
      routingException: blocked,
      duplicateOfProofId: null,
      openedAs: openedAsFor(replyTarget, input),
    };
  }

  if (input.receivedAt === null) {
    return {
      match: 'no_match',
      orderId: null,
      candidateCount: 0,
      routingException: null,
      duplicateOfProofId: null,
      openedAs: null,
    };
  }

  // NIVEL 2 — candidatos estructurales, sin respuesta explícita.
  const candidates = input.orders.filter((o) => isAutoMatchCandidate(o, input));

  if (candidates.length === 1) {
    return {
      match: 'single_open_qr_order',
      orderId: candidates[0].orderId,
      candidateCount: 1,
      routingException: null,
      duplicateOfProofId: null,
      openedAs: 'normal',
    };
  }

  if (candidates.length >= 2) {
    const chosen = [...candidates].sort((a, b) => {
      const ta = a.confirmationSentAt?.getTime() ?? 0;
      const tb = b.confirmationSentAt?.getTime() ?? 0;
      if (tb !== ta) return tb - ta;
      return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0; // desempate determinista
    })[0];
    return {
      match: 'current_qr_order',
      orderId: chosen.orderId,
      candidateCount: candidates.length,
      routingException: null,
      duplicateOfProofId: null,
      openedAs: 'normal',
    };
  }

  const reason = discardReason(input);
  if (reason === null) {
    return {
      match: 'no_match',
      orderId: null,
      candidateCount: 0,
      routingException: null,
      duplicateOfProofId: null,
      openedAs: null,
    };
  }
  return {
    match: 'unresolved',
    orderId: null,
    candidateCount: discovered.length,
    routingException: reason,
    duplicateOfProofId: null,
    openedAs: null,
  };
}
