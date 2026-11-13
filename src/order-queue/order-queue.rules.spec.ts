import {
  canAdmitDirectly,
  freeSlots,
  queueReadyText,
  releaseCount,
  REMINDER_COOLDOWN_MS,
  shouldSendReminder,
} from './order-queue.rules';

describe('freeSlots', () => {
  it('descuenta lo que hay en cocina y lo ya prometido', () => {
    expect(freeSlots(15, 10, 2)).toBe(3);
  });

  it('nunca es negativo', () => {
    expect(freeSlots(15, 20, 0)).toBe(0);
  });
});

describe('releaseCount (a cuántos de la fila se avisa)', () => {
  it('no avisa de a uno: con 3 cupos libres y 20 esperando, todavía no (batch 5)', () => {
    expect(releaseCount(3, 5, 20)).toBe(0);
  });

  it('con 5 cupos libres avisa a los primeros 5', () => {
    expect(releaseCount(5, 5, 20)).toBe(5);
  });

  it('con más cupos que el lote avisa a tantos como cupos haya', () => {
    expect(releaseCount(8, 5, 20)).toBe(8);
  });

  it('nunca avisa a más gente de la que espera', () => {
    expect(releaseCount(12, 5, 4)).toBe(4);
  });

  it('si en la fila hay menos que el lote, alcanza con que quepan todos', () => {
    expect(releaseCount(2, 5, 2)).toBe(2);
    expect(releaseCount(1, 5, 2)).toBe(0);
  });

  it('sin cupos o sin fila no avisa a nadie', () => {
    expect(releaseCount(0, 5, 10)).toBe(0);
    expect(releaseCount(10, 5, 0)).toBe(0);
  });
});

describe('canAdmitDirectly', () => {
  it('entra directo solo con cupo y sin nadie esperando antes', () => {
    expect(canAdmitDirectly(3, 0)).toBe(true);
    expect(canAdmitDirectly(3, 1)).toBe(false);
    expect(canAdmitDirectly(0, 0)).toBe(false);
  });
});

describe('shouldSendReminder', () => {
  const now = new Date('2026-11-13T00:00:00Z');

  it('la primera vez siempre', () => {
    expect(shouldSendReminder(null, now)).toBe(true);
  });

  it('no repite dentro del enfriamiento, sí después', () => {
    expect(shouldSendReminder(new Date(now.getTime() - 60_000), now)).toBe(false);
    expect(shouldSendReminder(new Date(now.getTime() - REMINDER_COOLDOWN_MS), now)).toBe(true);
  });
});

describe('queueReadyText', () => {
  it('avisa cuánto tiempo tiene para pedir', () => {
    expect(queueReadyText()).toContain('20 minutos');
  });
});
