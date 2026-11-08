import { signSmarkyPayload, verifySmarkySignature } from './smarky-signature';

describe('verifySmarkySignature', () => {
  const secret = 'secreto-de-prueba';
  const body = Buffer.from(JSON.stringify({ eventId: 'e1', type: 'entrega.asignada' }));
  const now = 1_800_000_000_000;
  const t = now / 1000;
  const header = (ts: number, sig = signSmarkyPayload(secret, ts, body)) => `t=${ts},v1=${sig}`;

  it('acepta una firma correcta y reciente', () => {
    expect(verifySmarkySignature(secret, header(t), body, now)).toEqual({ valid: true });
  });

  it('rechaza si falta el header o el cuerpo crudo', () => {
    expect(verifySmarkySignature(secret, undefined, body, now)).toEqual({ valid: false, reason: 'missing' });
    expect(verifySmarkySignature(secret, header(t), undefined, now)).toEqual({ valid: false, reason: 'missing' });
  });

  it('rechaza si no hay secreto configurado', () => {
    expect(verifySmarkySignature('', header(t), body, now)).toEqual({ valid: false, reason: 'missing' });
  });

  it('rechaza un header mal formado', () => {
    expect(verifySmarkySignature(secret, 'basura', body, now)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifySmarkySignature(secret, `t=${t},v1=corta`, body, now)).toEqual({ valid: false, reason: 'malformed' });
    expect(verifySmarkySignature(secret, `v1=${'a'.repeat(64)}`, body, now)).toEqual({
      valid: false,
      reason: 'malformed',
    });
  });

  it('rechaza una firma de otro secreto o con el cuerpo alterado', () => {
    const otra = signSmarkyPayload('otro-secreto', t, body);
    expect(verifySmarkySignature(secret, header(t, otra), body, now)).toEqual({ valid: false, reason: 'mismatch' });
    const alterado = Buffer.from(body.toString().replace('e1', 'e2'));
    expect(verifySmarkySignature(secret, header(t), alterado, now)).toEqual({ valid: false, reason: 'mismatch' });
  });

  it('rechaza si t está a más de 5 minutos, en cualquier sentido', () => {
    expect(verifySmarkySignature(secret, header(t - 301), body, now)).toEqual({ valid: false, reason: 'stale' });
    expect(verifySmarkySignature(secret, header(t + 301), body, now)).toEqual({ valid: false, reason: 'stale' });
    expect(verifySmarkySignature(secret, header(t - 299), body, now)).toEqual({ valid: true });
  });

  it('el timestamp forma parte de lo firmado: no se puede reutilizar una firma con otro t', () => {
    const firmaVieja = signSmarkyPayload(secret, t - 10, body);
    expect(verifySmarkySignature(secret, header(t, firmaVieja), body, now)).toEqual({
      valid: false,
      reason: 'mismatch',
    });
  });

  it('acepta si alguno de varios v1 coincide (rotación de secreto)', () => {
    const buena = signSmarkyPayload(secret, t, body);
    const vieja = signSmarkyPayload('secreto-anterior', t, body);
    expect(verifySmarkySignature(secret, `t=${t},v1=${vieja},v1=${buena}`, body, now)).toEqual({ valid: true });
  });
});
