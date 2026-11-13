import { computeServiceStatus, hoursLabel, ServiceStatusRow } from './service-status';

// Bolivia es UTC-4: 23:00 UTC = 19:00 en La Paz; 08:00 UTC = 04:00; 10:00 UTC = 06:00.
const at = (utcHour: number, day = 12) => new Date(Date.UTC(2026, 10, day, utcHour, 0, 0));

const base: ServiceStatusRow = {
  manually_closed: false,
  extended_service_enabled: false,
  schedule_opens_hour: 19,
  schedule_closes_hour: 4,
  closed_message: 'Estamos cerrados por ahora.',
  extended_message: 'Hoy seguimos atendiendo.',
  cash_enabled: true,
  allow_promo_with_items: true,
  queue_enabled: false,
};
const row = (overrides: Partial<ServiceStatusRow> = {}): ServiceStatusRow => ({ ...base, ...overrides });

describe('computeServiceStatus', () => {
  it('dentro del horario (cruzando la medianoche) está abierto', () => {
    expect(computeServiceStatus(row(), at(23)).reason).toBe('open'); // 19:00
    expect(computeServiceStatus(row(), at(3, 13)).reason).toBe('open'); // 23:00
    expect(computeServiceStatus(row(), at(7, 13)).reason).toBe('open'); // 03:00
  });

  it('fuera del horario está cerrado y el texto trae el horario', () => {
    const status = computeServiceStatus(row(), at(10, 13)); // 06:00
    expect(status.open).toBe(false);
    expect(status.reason).toBe('outside_hours');
    expect(status.closedText).toBe('Estamos cerrados por ahora.\nHorario de atención: 19:00 a 04:00.');
  });

  it('"Seguimos atendiendo" mantiene abierto pasada la hora de cierre y avisa al cliente', () => {
    const status = computeServiceStatus(row({ extended_service_enabled: true }), at(10, 13)); // 06:00
    expect(status.open).toBe(true);
    expect(status.reason).toBe('extended');
    expect(status.noticeText).toBe('Hoy seguimos atendiendo.');
    expect(status.closedText).toBe('');
  });

  it('dentro del horario "Seguimos atendiendo" no cambia nada: sigue siendo open, sin aviso', () => {
    const status = computeServiceStatus(row({ extended_service_enabled: true }), at(23));
    expect(status.reason).toBe('open');
    expect(status.noticeText).toBe('');
  });

  it('"Cerrado" gana sobre el horario y sobre "Seguimos atendiendo", y no agrega el horario al texto', () => {
    const status = computeServiceStatus(row({ manually_closed: true, extended_service_enabled: true }), at(23));
    expect(status.open).toBe(false);
    expect(status.reason).toBe('manual_closed');
    expect(status.closedText).toBe('Estamos cerrados por ahora.');
  });

  it('expone las reglas fijas y los demás modos tal cual', () => {
    const status = computeServiceStatus(
      row({ cash_enabled: false, allow_promo_with_items: false, queue_enabled: true }),
      at(23),
    );
    expect(status).toMatchObject({ cashEnabled: false, allowPromoWithItems: false, queueEnabled: true });
  });
});

describe('hoursLabel', () => {
  it('formatea con dos dígitos', () => {
    expect(hoursLabel(19, 4)).toBe('19:00 a 04:00');
  });
});
