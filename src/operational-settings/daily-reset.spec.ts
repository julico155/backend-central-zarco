import { dailyResetDue } from './daily-reset';

// Bolivia es UTC-4.
const at = (day: number, utcHour: number) => new Date(Date.UTC(2026, 10, day, utcHour, 0, 0));

describe('dailyResetDue', () => {
  it('antes de la hora de reinicio no toca, aunque el último reinicio haya sido ayer', () => {
    expect(dailyResetDue(at(13, 9), 7, '2026-11-12').due).toBe(false); // 05:00 en La Paz
  });

  it('a la hora de reinicio toca, una sola vez por día', () => {
    expect(dailyResetDue(at(13, 11), 7, '2026-11-12')).toEqual({ due: true, today: '2026-11-13' }); // 07:00
    expect(dailyResetDue(at(13, 12), 7, '2026-11-13').due).toBe(false); // ya se hizo hoy
  });

  it('si el backend estuvo caído a las 7:00, reinicia en cuanto vuelve', () => {
    expect(dailyResetDue(at(13, 16), 7, '2026-11-12').due).toBe(true); // 12:00
  });

  it('un modo activado a la noche, después del reinicio de hoy, sobrevive hasta mañana', () => {
    expect(dailyResetDue(at(14, 2), 7, '2026-11-13').due).toBe(false); // 22:00 del 13 en La Paz
    expect(dailyResetDue(at(14, 8), 7, '2026-11-13').due).toBe(false); // 04:00 del 14
    expect(dailyResetDue(at(14, 11), 7, '2026-11-13').due).toBe(true); // 07:00 del 14
  });

  it('nunca se reinició (null): toca apenas pase la hora', () => {
    expect(dailyResetDue(at(13, 11), 7, null).due).toBe(true);
  });
});
