import { PaymentProofAnalysisService } from './payment-proof-analysis.service';

function fakeDb(order: { subtotal_amount: string; total_amount: string } | null) {
  return {
    selectFrom: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          executeTakeFirst: jest.fn().mockResolvedValue(order),
        }),
      }),
    }),
  };
}

function fakeConfig(
  overrides: { paymentProof?: Record<string, string>; agent?: Record<string, string> } = {},
) {
  const values: Record<string, unknown> = {
    paymentProof: {
      analysisEnabled: 'true',
      analysisModel: '',
      expectedBank: 'BNB',
      expectedBankAliases: '',
      expectedAccountNumbers: '78486705',
      expectedHolder: 'DON ZARCO',
      expectedHolderAliases: '',
      ...overrides.paymentProof,
    },
    agent: { apiKey: 'sk-test', ...overrides.agent },
  };
  return { get: (key: string) => values[key] } as never;
}

function fakeProofs(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    findByTransactionRef: jest.fn().mockResolvedValue(false),
    recordAnalysis: jest.fn().mockResolvedValue(undefined),
    markAnalysisFailed: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function mockFetch(body: unknown, ok = true, status = 200) {
  return jest.fn().mockResolvedValue({ ok, status, json: async () => body });
}

function visionResponse(facts: Record<string, unknown>) {
  return {
    model: 'gpt-5-mini',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(facts) }] }],
  };
}

describe('PaymentProofAnalysisService', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('pago_total: llama a Vision (fake), contrasta contra el pedido y persiste el veredicto', async () => {
    global.fetch = mockFetch(
      visionResponse({
        looksLikeReceipt: true,
        legible: true,
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: 25,
        transactionRef: 'TX-1',
      }),
    ) as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-1',
      orderId: 'order-1',
      bytes: Buffer.from('fake-image'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-1',
      expect.objectContaining({ verdict: 'ok', amountLabel: 'pago_total' }),
    );
    expect(proofs.markAnalysisFailed).not.toHaveBeenCalled();
    // Sin red real hacia Kapso/Baneco: el único fetch es a la Responses API.
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('api.openai.com');
  });

  it('pago_productos: el monto leído coincide con el subtotal (sin envío)', async () => {
    global.fetch = mockFetch(
      visionResponse({
        looksLikeReceipt: true,
        legible: true,
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: 20,
      }),
    ) as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-2',
      orderId: 'order-1',
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-2',
      expect.objectContaining({ amountLabel: 'pago_productos' }),
    );
  });

  it('revisar_monto: el monto leído no cuadra con ninguno de los dos pagos válidos', async () => {
    global.fetch = mockFetch(
      visionResponse({
        looksLikeReceipt: true,
        legible: true,
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: 15,
      }),
    ) as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-3',
      orderId: 'order-1',
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-3',
      expect.objectContaining({ verdict: 'suspicious', amountLabel: 'revisar_monto' }),
    );
  });

  it('monto ilegible (la lectura no devuelve amount): revisar_monto', async () => {
    global.fetch = mockFetch(
      visionResponse({
        looksLikeReceipt: true,
        legible: true,
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: null,
      }),
    ) as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-4',
      orderId: 'order-1',
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-4',
      expect.objectContaining({ amountLabel: 'revisar_monto' }),
    );
  });

  it('un fallo de OpenAI (timeout/HTTP) marca analysis_status=failed y NO toca capture_status ni payment_status', async () => {
    global.fetch = mockFetch({}, false, 500) as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-5',
      orderId: 'order-1',
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.markAnalysisFailed).toHaveBeenCalledWith('proof-5');
    expect(proofs.recordAnalysis).not.toHaveBeenCalled();
  });

  it('referencia reutilizada: se consulta PaymentProofsService.findByTransactionRef y se refleja en el veredicto', async () => {
    global.fetch = mockFetch(
      visionResponse({
        looksLikeReceipt: true,
        legible: true,
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: 25,
        transactionRef: 'TX-DUP',
      }),
    ) as never;
    const proofs = fakeProofs({ findByTransactionRef: jest.fn().mockResolvedValue(true) });
    const service = new PaymentProofAnalysisService(
      fakeDb({ subtotal_amount: '20.00', total_amount: '25.00' }) as never,
      fakeConfig(),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-6',
      orderId: 'order-1',
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(proofs.findByTransactionRef).toHaveBeenCalledWith('TX-DUP', 'proof-6');
    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-6',
      expect.objectContaining({
        verdict: 'suspicious',
        reasons: expect.arrayContaining(['reference_reused']),
      }),
    );
  });

  it('sin pedido asociado (orderId null), no consulta montos y la etiqueta queda null', async () => {
    global.fetch = mockFetch(
      visionResponse({ looksLikeReceipt: true, legible: true, amount: 25 }),
    ) as never;
    const db = fakeDb(null);
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(db as never, fakeConfig(), proofs as never);

    await service.analyze({
      proofId: 'proof-7',
      orderId: null,
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(db.selectFrom).not.toHaveBeenCalled();
    expect(proofs.recordAnalysis).toHaveBeenCalledWith(
      'proof-7',
      expect.objectContaining({ amountLabel: null }),
    );
  });

  it('con el análisis apagado (PAYMENT_PROOF_ANALYSIS_ENABLED != "true"), no llama a fetch ni a PaymentProofsService', async () => {
    const fetchMock = mockFetch({});
    global.fetch = fetchMock as never;
    const proofs = fakeProofs();
    const service = new PaymentProofAnalysisService(
      fakeDb(null) as never,
      fakeConfig({ paymentProof: { analysisEnabled: 'false' } }),
      proofs as never,
    );

    await service.analyze({
      proofId: 'proof-8',
      orderId: null,
      bytes: Buffer.from('x'),
      mimeType: 'image/jpeg',
      receivedAtMs: Date.now(),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(proofs.recordAnalysis).not.toHaveBeenCalled();
    expect(proofs.markAnalysisFailed).not.toHaveBeenCalled();
  });
});
