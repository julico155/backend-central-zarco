import { OrderCandidate, resolveAssociation } from './association';

const BASE_TIME = new Date('2026-01-15T20:00:00.000Z');

function order(overrides: Partial<OrderCandidate> = {}): OrderCandidate {
  return {
    orderId: 'order-1',
    status: 'awaiting_location',
    hasAcceptedProof: false,
    confirmationExternalMessageId: 'wamid-confirm-1',
    confirmationSentAt: BASE_TIME,
    ...overrides,
  };
}

describe('resolveAssociation', () => {
  it('nivel 0: duplicado exacto por sha256 de un archivo con episodio existente', () => {
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: BASE_TIME,
      orders: [order()],
      priorSameFile: [{ proofId: 'proof-original', attemptId: 'attempt-1', orderId: 'order-1' }],
    });
    expect(result.match).toBe('duplicate');
    expect(result.orderId).toBe('order-1');
    expect(result.duplicateOfProofId).toBe('proof-original');
  });

  it('nivel 0: reply apunta a un pedido distinto del duplicado -> signal_conflict', () => {
    const result = resolveAssociation({
      contextMessageId: 'wamid-confirm-2',
      receivedAt: BASE_TIME,
      orders: [
        order({ orderId: 'order-1', confirmationExternalMessageId: 'wamid-confirm-1' }),
        order({ orderId: 'order-2', confirmationExternalMessageId: 'wamid-confirm-2' }),
      ],
      priorSameFile: [{ proofId: 'proof-original', attemptId: 'attempt-1', orderId: 'order-1' }],
    });
    expect(result.match).toBe('unresolved');
    expect(result.routingException).toBe('signal_conflict');
  });

  it('nivel 1: reply_to_qr por igualdad exacta de mensaje, no caduca', () => {
    const oldOrder = order({
      confirmationSentAt: new Date(BASE_TIME.getTime() - 30 * 60 * 60 * 1000), // 30h, fuera de toda ventana
    });
    const result = resolveAssociation({
      contextMessageId: 'wamid-confirm-1',
      receivedAt: BASE_TIME,
      orders: [oldOrder],
      priorSameFile: [],
    });
    expect(result.match).toBe('reply_to_qr');
    expect(result.orderId).toBe('order-1');
    expect(result.routingException).toBeNull();
  });

  it('reply_to_qr con pago ya aceptado degrada a payment_already_accepted, sin episodio', () => {
    const result = resolveAssociation({
      contextMessageId: 'wamid-confirm-1',
      receivedAt: BASE_TIME,
      orders: [order({ hasAcceptedProof: true })],
      priorSameFile: [],
    });
    expect(result.match).toBe('reply_to_qr');
    expect(result.routingException).toBe('payment_already_accepted');
  });

  it('reply_to_qr con pedido cerrado degrada a closed_order', () => {
    const result = resolveAssociation({
      contextMessageId: 'wamid-confirm-1',
      receivedAt: BASE_TIME,
      orders: [order({ status: 'cancelled' })],
      priorSameFile: [],
    });
    expect(result.routingException).toBe('closed_order');
  });

  it('nivel 2: un solo candidato estructural dentro de 4h -> single_open_qr_order', () => {
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: BASE_TIME,
      orders: [order({ confirmationExternalMessageId: 'otro-mensaje' })],
      priorSameFile: [],
    });
    expect(result.match).toBe('single_open_qr_order');
    expect(result.candidateCount).toBe(1);
  });

  it('nivel 2: dos candidatos -> current_qr_order, elige el de confirmación más reciente', () => {
    const older = order({
      orderId: 'order-old',
      confirmationExternalMessageId: 'm-old',
      confirmationSentAt: new Date(BASE_TIME.getTime() - 60 * 60 * 1000),
    });
    const newer = order({
      orderId: 'order-new',
      confirmationExternalMessageId: 'm-new',
      confirmationSentAt: new Date(BASE_TIME.getTime() - 10 * 60 * 1000),
    });
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: BASE_TIME,
      orders: [older, newer],
      priorSameFile: [],
    });
    expect(result.match).toBe('current_qr_order');
    expect(result.orderId).toBe('order-new');
    expect(result.candidateCount).toBe(2);
  });

  it('un QR entre 4h y 24h se descubre pero no se adjudica solo -> unresolved/expired_target', () => {
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: BASE_TIME,
      orders: [
        order({
          confirmationExternalMessageId: 'm-late',
          confirmationSentAt: new Date(BASE_TIME.getTime() - 10 * 60 * 60 * 1000), // 10h
        }),
      ],
      priorSameFile: [],
    });
    expect(result.match).toBe('unresolved');
    expect(result.routingException).toBe('expired_target');
  });

  it('sin ningún QR descubierto en 24h -> no_match, no se guarda nada', () => {
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: BASE_TIME,
      orders: [],
      priorSameFile: [],
    });
    expect(result.match).toBe('no_match');
  });

  it('sin receivedAt no se evalúa el nivel 2 (nunca se usa el reloj del proceso como sustituto)', () => {
    const result = resolveAssociation({
      contextMessageId: null,
      receivedAt: null,
      orders: [order({ confirmationExternalMessageId: 'otro-mensaje' })],
      priorSameFile: [],
    });
    expect(result.match).toBe('no_match');
  });
});
