import { describeClockSkew, measureClockSkew } from './clock';

describe('measureClockSkew (solo lectura)', () => {
  afterEach(() => jest.useRealTimers());

  it('mide la diferencia con el punto medio de la consulta y solo ejecuta un SELECT', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const queries: string[] = [];
    const client = {
      async query(text: string) {
        queries.push(text);
        jest.setSystemTime(1_000_100); // 100 ms de ida y vuelta
        return { rows: [{ ms: 1_000_050 + 700 }] }; // la base va 700 ms adelante
      },
    };

    const skew = await measureClockSkew(client);

    expect(skew).toEqual({ skewMs: 700, rttMs: 100 });
    expect(queries).toHaveLength(1);
    expect(queries[0].trim().toLowerCase()).toMatch(/^select/);
  });

  it('describe el sentido de la diferencia', () => {
    expect(describeClockSkew('Agente', { skewMs: 700, rttMs: 40 })).toContain('ATRASADA');
    expect(describeClockSkew('Agente', { skewMs: -700, rttMs: 40 })).toContain('ADELANTADA');
    expect(describeClockSkew('Agente', { skewMs: 0, rttMs: 40 })).toContain('sin diferencia');
  });
});
