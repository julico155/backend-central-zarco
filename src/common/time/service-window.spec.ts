import { checkoutGateAt, classifyServiceWindow } from './service-window';

const HOURS = { opensHour: 17, lateReviewHour: 22, closesHour: 23 };

// Bolivia es UTC-4 fijo: hora local H = hora UTC - 4, o dicho al revés,
// para que sean las H en La Paz hay que usar UTC = H + 4.
function laPazTime(hour: number): Date {
  return new Date(Date.UTC(2026, 0, 15, hour + 4, 0, 0));
}

describe('classifyServiceWindow (invariante 7 del plan, horario 17-22-23)', () => {
  it('cerrado antes de las 17:00', () => {
    expect(classifyServiceWindow(laPazTime(10), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(16), HOURS)).toBe('closed');
  });

  it('abierto entre las 17:00 y las 22:00', () => {
    expect(classifyServiceWindow(laPazTime(17), HOURS)).toBe('open');
    expect(classifyServiceWindow(laPazTime(21), HOURS)).toBe('open');
  });

  it('revisión nocturna entre las 22:00 y las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(22), HOURS)).toBe('late_review');
  });

  it('cerrado desde las 23:00', () => {
    expect(classifyServiceWindow(laPazTime(23), HOURS)).toBe('closed');
    expect(classifyServiceWindow(laPazTime(0), HOURS)).toBe('closed');
  });

  it('checkoutGateAt mapea cada ventana a su gate', () => {
    expect(checkoutGateAt(laPazTime(18), HOURS)).toEqual({ gate: 'proceed' });
    expect(checkoutGateAt(laPazTime(22), HOURS)).toEqual({ gate: 'late_review' });
    expect(checkoutGateAt(laPazTime(23), HOURS)).toEqual({ gate: 'closed' });
  });

  it('un instante ilegible (NaN) sale closed, nunca abierto', () => {
    expect(classifyServiceWindow(new Date(NaN), HOURS)).toBe('closed');
  });
});
