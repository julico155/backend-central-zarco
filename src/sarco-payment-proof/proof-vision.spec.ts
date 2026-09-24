import { parseProofFacts, readProofFacts } from './proof-vision';
import type { AgentModel } from '../sarco-agent/core/model';

describe('parseProofFacts', () => {
  it('parsea una respuesta JSON válida', () => {
    const facts = parseProofFacts(
      JSON.stringify({
        looksLikeReceipt: true,
        legible: true,
        bank: 'BNB',
        destinationBank: 'BNB',
        destinationAccount: '78486705',
        destinationHolder: 'DON ZARCO',
        amount: 25,
        currency: 'BOB',
        transactionRef: 'TX-1',
        paidAtLocal: '2026-01-01T12:00',
      }),
    );
    expect(facts).toEqual({
      looksLikeReceipt: true,
      legible: true,
      bank: 'BNB',
      destinationBank: 'BNB',
      destinationAccount: '78486705',
      destinationHolder: 'DON ZARCO',
      amount: 25,
      currency: 'BOB',
      transactionRef: 'TX-1',
      paidAtLocal: '2026-01-01T12:00',
    });
  });

  it('recorta texto alrededor del JSON (```json y frases)', () => {
    const facts = parseProofFacts(
      '```json\n' + JSON.stringify({ looksLikeReceipt: false, legible: true }) + '\n```',
    );
    expect(facts).toMatchObject({ looksLikeReceipt: false, legible: true });
  });

  it('acepta un monto con formato "48,00" o "Bs 48.00"', () => {
    const facts = parseProofFacts(
      JSON.stringify({ looksLikeReceipt: true, legible: true, amount: '48,00' }),
    );
    expect(facts?.amount).toBe(48);
  });

  it('cadenas vacías se normalizan a null, nunca a ""', () => {
    const facts = parseProofFacts(
      JSON.stringify({ looksLikeReceipt: true, legible: true, bank: '' }),
    );
    expect(facts?.bank).toBeNull();
  });

  it('una respuesta sin las claves booleanas obligatorias es inválida (null)', () => {
    expect(parseProofFacts(JSON.stringify({ amount: 25 }))).toBeNull();
  });

  it('texto sin ningún JSON es inválido', () => {
    expect(parseProofFacts('lo siento, no puedo ayudar con eso')).toBeNull();
  });
});

describe('readProofFacts (sin red real: AgentModel fake)', () => {
  function fakeModel(complete: AgentModel['complete']): AgentModel {
    return { model: 'gpt-5-mini', complete };
  }

  it('devuelve los hechos cuando el modelo responde bien', async () => {
    const complete = jest.fn().mockResolvedValue({
      ok: true,
      text: JSON.stringify({ looksLikeReceipt: true, legible: true, amount: 25 }),
      model: 'gpt-5-mini',
    });
    const result = await readProofFacts(fakeModel(complete), 'data:image/jpeg;base64,AAAA');

    expect(result).toEqual({
      ok: true,
      facts: expect.objectContaining({ looksLikeReceipt: true, legible: true, amount: 25 }),
      model: 'gpt-5-mini',
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('un fallo del modelo (http_error) se reporta con el status pegado al código', async () => {
    const complete = jest.fn().mockResolvedValue({ ok: false, error: 'http_error', status: 429 });
    const result = await readProofFacts(fakeModel(complete), 'data:image/jpeg;base64,AAAA');

    expect(result).toEqual({ ok: false, error: 'model_error', code: 'http_error.429' });
  });

  it('una respuesta con forma inválida es invalid_response, no revienta', async () => {
    const complete = jest
      .fn()
      .mockResolvedValue({ ok: true, text: 'no es json', model: 'gpt-5-mini' });
    const result = await readProofFacts(fakeModel(complete), 'data:image/jpeg;base64,AAAA');

    expect(result).toEqual({ ok: false, error: 'invalid_response' });
  });

  it('si el adaptador lanza, se captura como model_error (nunca se propaga)', async () => {
    const complete = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await readProofFacts(fakeModel(complete), 'data:image/jpeg;base64,AAAA');

    expect(result).toEqual({ ok: false, error: 'model_error', code: 'threw' });
  });
});
