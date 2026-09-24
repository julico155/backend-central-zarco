import { canHandOff } from './handoff-gate';
import { isExplicitHumanRequest } from './explicit-request';
import { hasProblemSignal } from './problem-signal';

describe('isExplicitHumanRequest', () => {
  it('exige verbo de contacto Y sustantivo de persona juntos', () => {
    expect(isExplicitHumanRequest('quiero hablar con una persona')).toBe(true);
    expect(isExplicitHumanRequest('quiero hablar de mi pedido')).toBe(false);
    expect(isExplicitHumanRequest('una persona me dijo que tenían promo')).toBe(false);
  });

  it('reconoce frases directas sin verbo', () => {
    expect(isExplicitHumanRequest('atencion humana porfa')).toBe(true);
  });
});

describe('hasProblemSignal', () => {
  it('detecta un problema de dinero', () => {
    expect(hasProblemSignal('me cobraron de mas')).toBe(true);
  });

  it('detecta un pedido en mal estado', () => {
    expect(hasProblemSignal('llego frio el pedido')).toBe(true);
  });

  it('detecta una queja formal', () => {
    expect(hasProblemSignal('quiero poner un reclamo')).toBe(true);
  });

  it('la impaciencia normal no es un problema', () => {
    expect(hasProblemSignal('cuanto falta para que llegue')).toBe(false);
  });

  it('sin texto, no hay evidencia', () => {
    expect(hasProblemSignal(null)).toBe(false);
  });
});

describe('canHandOff', () => {
  it('deriva con petición explícita, con señal de problema, o con ambas', () => {
    expect(canHandOff({ explicitRequest: true, problemSignal: false })).toBe(true);
    expect(canHandOff({ explicitRequest: false, problemSignal: true })).toBe(true);
    expect(canHandOff({ explicitRequest: false, problemSignal: false })).toBe(false);
  });
});
