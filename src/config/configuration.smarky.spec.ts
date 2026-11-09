import configuration from './configuration';

describe('configuración de reparto', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });
  function cargar(extra: Record<string, string | undefined>) {
    process.env = { ...original, DATABASE_URL: 'postgres://x', JWT_SECRET: 's', ...extra };
    return configuration().delivery;
  }

  it('por defecto: proveedor interno y transición activada', () => {
    const d = cargar({ DELIVERY_PROVIDER: undefined, SMARKY_NOTIFY_OWN_DRIVERS: undefined });
    expect(d.provider).toBe('internal');
    expect(d.smarky.notifyOwnDrivers).toBe(true);
  });

  it("SMARKY_NOTIFY_OWN_DRIVERS=false (cualquier mayúscula) apaga la transición; cualquier otro valor la deja activa", () => {
    expect(cargar({ SMARKY_NOTIFY_OWN_DRIVERS: 'false' }).smarky.notifyOwnDrivers).toBe(false);
    expect(cargar({ SMARKY_NOTIFY_OWN_DRIVERS: ' FALSE ' }).smarky.notifyOwnDrivers).toBe(false);
    expect(cargar({ SMARKY_NOTIFY_OWN_DRIVERS: 'true' }).smarky.notifyOwnDrivers).toBe(true);
    expect(cargar({ SMARKY_NOTIFY_OWN_DRIVERS: '' }).smarky.notifyOwnDrivers).toBe(true);
  });

  it('solo DELIVERY_PROVIDER=smarky activa la plataforma', () => {
    expect(cargar({ DELIVERY_PROVIDER: 'Smarky' }).provider).toBe('smarky');
    expect(cargar({ DELIVERY_PROVIDER: 'otra' }).provider).toBe('internal');
  });
});

describe('configuración del código de entrega', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });
  const cargar = (v: string | undefined) => {
    process.env = { ...original, DATABASE_URL: 'postgres://x', JWT_SECRET: 's', SMARKY_REQUIRE_DELIVERY_CODE: v };
    return configuration().delivery.smarky.requireDeliveryCode;
  };

  it('por defecto no se pide código de entrega; solo "true" lo reactiva', () => {
    expect(cargar(undefined)).toBe(false);
    expect(cargar('')).toBe(false);
    expect(cargar('false')).toBe(false);
    expect(cargar(' TRUE ')).toBe(true);
  });
});
