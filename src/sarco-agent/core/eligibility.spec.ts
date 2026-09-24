import { evaluateAgentEligibility, parseAccessMode, parseTestPhones } from './eligibility';

describe('parseAccessMode', () => {
  it('solo la cadena exacta "all" abre el agente', () => {
    expect(parseAccessMode('all')).toBe('all');
    expect(parseAccessMode('ALL')).toBe('allowlist');
    expect(parseAccessMode('true')).toBe('allowlist');
    expect(parseAccessMode(undefined)).toBe('allowlist');
    expect(parseAccessMode(null)).toBe('allowlist');
  });
});

describe('parseTestPhones', () => {
  it('normaliza, deduplica y descarta entradas sin dígitos', () => {
    expect(parseTestPhones('+591 700-00000, 59170000000, , basura')).toEqual(['59170000000']);
  });

  it('sin valor, lista vacía', () => {
    expect(parseTestPhones(undefined)).toEqual([]);
  });
});

describe('evaluateAgentEligibility', () => {
  const base = {
    enabled: true,
    accessMode: 'allowlist' as const,
    testPhones: ['59170000000'],
    hasApiKey: true,
  };

  it('deshabilitado por AI_ENABLED', () => {
    expect(evaluateAgentEligibility('59170000000', { ...base, enabled: false })).toBe('disabled');
  });

  it('sin API key, not_configured', () => {
    expect(evaluateAgentEligibility('59170000000', { ...base, hasApiKey: false })).toBe(
      'not_configured',
    );
  });

  it('teléfono fuera de la allowlist', () => {
    expect(evaluateAgentEligibility('59171111111', base)).toBe('phone_not_allowed');
  });

  it('teléfono en la allowlist, eligible', () => {
    expect(evaluateAgentEligibility('59170000000', base)).toBe('eligible');
  });

  it('modo all abre a cualquier teléfono con número, sin consultar la lista', () => {
    expect(
      evaluateAgentEligibility('59199999999', { ...base, accessMode: 'all', testPhones: [] }),
    ).toBe('eligible');
  });

  it('teléfono vacío nunca es elegible, ni siquiera en modo all', () => {
    expect(evaluateAgentEligibility('', { ...base, accessMode: 'all' })).toBe('phone_not_allowed');
  });
});
