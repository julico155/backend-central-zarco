import {
  matchesAccount,
  matchesBank,
  matchesHolder,
  parseExpectedAccount,
} from './expected-account';

describe('matchesAccount', () => {
  it('coincide con una cuenta exacta', () => {
    expect(matchesAccount('78486705', ['78486705'])).toBe('match');
  });

  it('coincide con una cuenta enmascarada por los extremos (78***705 vs 78486705)', () => {
    expect(matchesAccount('78***705', ['78486705'])).toBe('match');
  });

  it('NO confunde 78***705 con una cuenta que solo comparte la cola pegada mal (regression del 03-09)', () => {
    // 78***705 -> cabeza "78", cola "705". Una cuenta que termine en 8705 en
    // vez de en 6705 no debe dar match por concatenar ciegamente.
    expect(matchesAccount('78***705', ['12348705'])).toBe('mismatch');
  });

  it('cuentas ilegibles o sin configurar dan unknown, nunca mismatch', () => {
    expect(matchesAccount(null, ['78486705'])).toBe('unknown');
    expect(matchesAccount('78486705', [])).toBe('unknown');
  });

  it('basta con que UNA de varias cuentas configuradas coincida', () => {
    expect(matchesAccount('99999999', ['11111111', '99999999'])).toBe('match');
  });

  it('mismatch solo si hubo una comparación real (no todo quedó unknown)', () => {
    expect(matchesAccount('12', ['78486705'])).toBe('unknown'); // muy corto para comparar
    expect(matchesAccount('99999999', ['78486705'])).toBe('mismatch');
  });
});

describe('matchesHolder', () => {
  it('DON ZARCO encaja dentro de DON ZARCO SRL', () => {
    expect(matchesHolder('DON ZARCO', ['DON ZARCO SRL'])).toBe('match');
  });

  it('tolera tildes, mayúsculas y orden de acentos', () => {
    expect(matchesHolder('juan pérez', ['JUAN PEREZ'])).toBe('match');
  });

  it('un nombre distinto es mismatch', () => {
    expect(matchesHolder('MARIA LOPEZ', ['DON ZARCO'])).toBe('mismatch');
  });

  it('sin nombre leído o sin alias configurados, unknown', () => {
    expect(matchesHolder(null, ['DON ZARCO'])).toBe('unknown');
  });
});

describe('matchesBank', () => {
  it('BNB coincide con uno de sus alias configurados (la separación por "|" la hace parseExpectedAccount)', () => {
    expect(matchesBank('BNB', ['BNB', 'Banco Nacional de Bolivia'])).toBe('match');
  });

  it('coincide por palabras distintivas, ignorando "banco"/"bolivia"/"s.a."', () => {
    expect(matchesBank('Banco Mercantil Santa Cruz S.A.', ['Mercantil Santa Cruz'])).toBe('match');
  });

  it('si a un lado no queda ninguna palabra distintiva, unknown (no acusa por "Banco" a secas)', () => {
    expect(matchesBank('Banca Movil', ['Banco'])).toBe('unknown');
  });
});

describe('parseExpectedAccount', () => {
  it('separa cuentas y alias por "|"', () => {
    const expected = parseExpectedAccount({
      bank: 'BNB',
      bankAliases: 'Banco Nacional de Bolivia',
      accountNumbers: '78486705|99999999',
      holder: 'Don Zarco',
      holderAliases: 'Don Zarco SRL',
    });
    expect(expected).toEqual({
      bankNames: ['BNB', 'Banco Nacional de Bolivia'],
      accountNumbers: ['78486705', '99999999'],
      holderNames: ['Don Zarco', 'Don Zarco SRL'],
    });
  });

  it('sin cuentas ni titular configurados, null (nada que contrastar)', () => {
    expect(parseExpectedAccount({})).toBeNull();
  });
});
