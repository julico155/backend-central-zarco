import { checkoutGateAt, classifyServiceWindow, lastClosesHourCrossing } from './service-window';

const HOURS = { opensHour: 17, closesHour: 23 };

// Bolivia es UTC-4 fijo: hora local H = hora UTC - 4, o dicho al revés,
// para que sean las H en La Paz hay que usar UTC = H + 4.
function laPazTime(hour: number, minute = 0): Date {
  return new Date(Date.UTC(2026, 0, 15, hour + 4, minute, 0));
}

describe('classifyServiceWindow (margen ancho de cordura, horario 17-23)', () => {
  it('cerrado antes de las 17:00', () => {
    expect(classifyServiceWindow(laPazTime(10), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(16), HOURS)).toBe('closed');
  });

  it('abierto entre las 17:00 y las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(17), HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(22), HOURS)).toBe('open');
  });

  it('cerrado desde las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(23), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(0), HOURS)).toBe('closed');
  });

  it('un instante ilegible (NaN) sale closed, nunca abierto', () => {
    expect(classifyServiceWindow(new Date(NaN), HOURS)).toBe('closed');
  });
});

const OVERNIGHT_HOURS = { opensHour: 19, closesHour: 4 };

describe('classifyServiceWindow (margen cruzando medianoche, horario 19-4)', () => {
  it('cerrado antes de las 19:00', () => {
    expect(classifyServiceWindow(laPazTime(10), OVERNIGHT_HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(18), OVERNIGHT_HOURS)).toBe('closed');
  });

  it('abierto desde las 19:00, incluyendo después de medianoche', () => {
    expect(classifyServiceWindow(laPazTime(19), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(23), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(0), OVERNIGHT_HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(3), OVERNIGHT_HOURS)).toBe('open');
  });

  it('cerrado desde las 4:00', () => {
    expect(classifyServiceWindow(laPazTime(4), OVERNIGHT_HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(12), OVERNIGHT_HOURS)).toBe('closed');
  });
});

describe('checkoutGateAt (la caja decide adentro del margen horario)', () => {
  it('afuera del margen: closed sin importar la caja', () => {
    expect(checkoutGateAt(laPazTime(10), OVERNIGHT_HOURS, true)).toEqual({ gate: 'closed' });
    expect(checkoutGateAt(laPazTime(10), OVERNIGHT_HOURS, false)).toEqual({ gate: 'closed' });
  });

  it('adentro del margen con caja abierta: proceed', () => {
    expect(checkoutGateAt(laPazTime(20), OVERNIGHT_HOURS, true)).toEqual({ gate: 'proceed' });
  });

  it('adentro del margen sin caja abierta: late_review, aunque sea temprano en la noche', () => {
    // El cajero todavía no abrió — no importa que falten horas para el
    // cierre "oficial", si no hay caja el pedido se encola igual.
    expect(checkoutGateAt(laPazTime(20), OVERNIGHT_HOURS, false)).toEqual({ gate: 'late_review' });
  });

  it('cerraron la caja temprano: los pedidos posteriores se encolan aunque siga dentro del margen', () => {
    expect(checkoutGateAt(laPazTime(1), OVERNIGHT_HOURS, false)).toEqual({ gate: 'late_review' });
  });

  it('se quedaron abiertos hasta tarde: sigue proceed mientras la caja siga abierta', () => {
    expect(checkoutGateAt(laPazTime(3), OVERNIGHT_HOURS, true)).toEqual({ gate: 'proceed' });
  });
});

describe('lastClosesHourCrossing (corte de KitchenAutoCompleteCron)', () => {
  const closesHour = 23;

  it('ya pasó la hora de cierre hoy: el cruce es el de hoy', () => {
    const now = laPazTime(23); // 23:00 La Paz, justo cruzando
    const crossing = lastClosesHourCrossing(now, closesHour);
    expect(crossing.getTime()).toBe(now.getTime());
  });

  it('todavía no llega a la hora de cierre hoy: el cruce es el de ayer', () => {
    const now = laPazTime(10); // 10:00 La Paz, closesHour=23 todavía no pasó hoy
    const crossing = lastClosesHourCrossing(now, closesHour);
    const expected = new Date(laPazTime(23).getTime() - 24 * 60 * 60 * 1000);
    expect(crossing.getTime()).toBe(expected.getTime());
  });

  it('un pedido creado justo antes del cruce queda del lado de "antes"; uno creado justo después, no', () => {
    const now = laPazTime(23, 30); // 23:30, media hora después del cierre
    const crossing = lastClosesHourCrossing(now, closesHour);
    const before = new Date(crossing.getTime() - 1000);
    const after = new Date(crossing.getTime() + 1000);
    expect(before.getTime() < crossing.getTime()).toBe(true);
    expect(after.getTime() > crossing.getTime()).toBe(true);
  });
});
