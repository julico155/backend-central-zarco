import {
  generateMenuSessionToken,
  hashMenuSessionToken,
  verifyMenuSessionToken,
} from './menu-session-token';

describe('menu-session-token', () => {
  it('el mismo WAMID + el mismo secreto siempre generan el mismo token', () => {
    const a = generateMenuSessionToken('wamid.1', 'secret');
    const b = generateMenuSessionToken('wamid.1', 'secret');
    expect(a).toBe(b);
  });

  it('WAMIDs distintos producen tokens distintos', () => {
    const a = generateMenuSessionToken('wamid.1', 'secret');
    const b = generateMenuSessionToken('wamid.2', 'secret');
    expect(a).not.toBe(b);
  });

  it('verifyMenuSessionToken acepta el token correcto contra su hash', () => {
    const token = generateMenuSessionToken('wamid.1', 'secret');
    const hash = hashMenuSessionToken(token);
    expect(verifyMenuSessionToken(token, hash)).toBe(true);
  });

  it('rechaza un token válido contra el hash de OTRA sesión (firma inválida)', () => {
    const token = generateMenuSessionToken('wamid.1', 'secret');
    const otherHash = hashMenuSessionToken(generateMenuSessionToken('wamid.2', 'secret'));
    expect(verifyMenuSessionToken(token, otherHash)).toBe(false);
  });

  it('rechaza un token generado con un secreto distinto', () => {
    const token = generateMenuSessionToken('wamid.1', 'other-secret');
    const hash = hashMenuSessionToken(generateMenuSessionToken('wamid.1', 'secret'));
    expect(verifyMenuSessionToken(token, hash)).toBe(false);
  });

  it('nunca lanza ante basura: hash mal formado o token vacío', () => {
    expect(verifyMenuSessionToken('', 'not-a-hash')).toBe(false);
    expect(verifyMenuSessionToken('token', 'short')).toBe(false);
  });
});
