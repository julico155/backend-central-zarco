import {
  judgeProof,
  labelForAmount,
  type ProofFacts,
  type ProofJudgeContext,
} from './proof-analysis';

const expectedAccount = {
  bankNames: ['BNB'],
  accountNumbers: ['78486705'],
  holderNames: ['DON ZARCO'],
};

function facts(overrides: Partial<ProofFacts> = {}): ProofFacts {
  return {
    looksLikeReceipt: true,
    legible: true,
    bank: 'BNB',
    destinationBank: 'BNB',
    destinationAccount: '78486705',
    destinationHolder: 'DON ZARCO',
    amount: 25,
    currency: 'BOB',
    transactionRef: 'TX-1',
    paidAtLocal: null,
    ...overrides,
  };
}

function ctx(overrides: Partial<ProofJudgeContext> = {}): ProofJudgeContext {
  return {
    expected: expectedAccount,
    receivedAtMs: Date.parse('2026-01-01T12:00:00.000Z'),
    referenceReused: false,
    amounts: { subtotal: 20, total: 25 },
    ...overrides,
  };
}

describe('labelForAmount', () => {
  const amounts = { subtotal: 20, total: 25 };
  it('pago_total: coincide con el total exacto', () => {
    expect(labelForAmount(25, amounts)).toBe('pago_total');
  });
  it('pago_productos: coincide con el subtotal exacto', () => {
    expect(labelForAmount(20, amounts)).toBe('pago_productos');
  });
  it('revisar_monto: cualquier otra cifra, incluso un boliviano de más', () => {
    expect(labelForAmount(26, amounts)).toBe('revisar_monto');
    expect(labelForAmount(19, amounts)).toBe('revisar_monto');
  });
  it('revisar_monto: monto ilegible (null) o no finito', () => {
    expect(labelForAmount(null, amounts)).toBe('revisar_monto');
    expect(labelForAmount(Number.NaN, amounts)).toBe('revisar_monto');
  });
  it('en recojo (subtotal === total), cualquier pago correcto es pago_total', () => {
    expect(labelForAmount(20, { subtotal: 20, total: 20 })).toBe('pago_total');
  });
});

describe('judgeProof', () => {
  it('pago_total: cuenta/titular/banco correctos y monto = total → ok, pago_total', () => {
    const result = judgeProof(facts({ amount: 25 }), ctx());
    expect(result).toMatchObject({ verdict: 'ok', reasons: [], amountLabel: 'pago_total' });
  });

  it('pago_productos: mismo comprobante correcto pero monto = subtotal (sin envío)', () => {
    const result = judgeProof(facts({ amount: 20 }), ctx());
    expect(result.amountLabel).toBe('pago_productos');
    expect(result.verdict).toBe('ok');
  });

  it('revisar_monto: comprobante correcto pero el monto no cuadra con ninguno de los dos', () => {
    const result = judgeProof(facts({ amount: 15 }), ctx());
    expect(result.amountLabel).toBe('revisar_monto');
    expect(result.verdict).toBe('suspicious');
    expect(result.reasons).toContain('amount_mismatch');
  });

  it('monto ilegible: revisar_monto, pero el veredicto sigue siendo el de legibilidad, no suspicious por el monto', () => {
    const result = judgeProof(facts({ amount: null }), ctx());
    expect(result.amountLabel).toBe('revisar_monto');
    // La cuenta/titular/banco siguen correctos, así que el único motivo es el monto.
    expect(result.verdict).toBe('suspicious');
    expect(result.reasons).toEqual(['amount_mismatch']);
  });

  it('imagen no legible: unreadable, NUNCA suspicious (una foto mala no es una acusación)', () => {
    const result = judgeProof(facts({ legible: false }), ctx());
    expect(result.verdict).toBe('unreadable');
    expect(result.reasons).toEqual(['unreadable']);
  });

  it('no parece un comprobante: suspicious con not_a_receipt', () => {
    const result = judgeProof(facts({ looksLikeReceipt: false }), ctx());
    expect(result.verdict).toBe('suspicious');
    expect(result.reasons).toEqual(['not_a_receipt']);
  });

  it('cuenta destino distinta: suspicious con account_mismatch', () => {
    const result = judgeProof(facts({ destinationAccount: '00000000' }), ctx());
    expect(result.reasons).toContain('account_mismatch');
    expect(result.verdict).toBe('suspicious');
  });

  it('la cuenta manda sobre el nombre: cuenta correcta + titular distinto NO acusa holder_mismatch', () => {
    const result = judgeProof(
      facts({ destinationAccount: '78486705', destinationHolder: 'OTRA PERSONA' }),
      ctx(),
    );
    expect(result.reasons).not.toContain('holder_mismatch');
  });

  it('sin cuenta legible, el titular SÍ acusa si no coincide', () => {
    const result = judgeProof(
      facts({ destinationAccount: null, destinationHolder: 'OTRA PERSONA' }),
      ctx(),
    );
    expect(result.reasons).toContain('holder_mismatch');
  });

  it('referencia reutilizada: suspicious con reference_reused', () => {
    const result = judgeProof(facts(), ctx({ referenceReused: true }));
    expect(result.reasons).toContain('reference_reused');
    expect(result.verdict).toBe('suspicious');
  });

  it('sin pedido asociado (amounts ausente), la etiqueta queda null, nunca "cuadra"', () => {
    const result = judgeProof(facts(), ctx({ amounts: null }));
    expect(result.amountLabel).toBeNull();
  });

  it('nada que contrastar (sin cuenta/titular/banco configurados): unreadable, no ok falso', () => {
    const result = judgeProof(
      facts(),
      ctx({ expected: { bankNames: [], accountNumbers: [], holderNames: [] } }),
    );
    expect(result.verdict).toBe('unreadable');
  });
});
