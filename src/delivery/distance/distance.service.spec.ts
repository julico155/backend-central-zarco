import { HaversineDistanceService } from './distance.service';

describe('HaversineDistanceService', () => {
  const service = new HaversineDistanceService();

  it('el mismo punto da 0 metros', () => {
    const point = { latitude: -16.5, longitude: -68.15 };
    expect(service.metersBetween(point, point)).toBe(0);
  });

  it('un grado de latitud son ~111.32 km (tolerancia 1%)', () => {
    const a = { latitude: 0, longitude: 0 };
    const b = { latitude: 1, longitude: 0 };
    const meters = service.metersBetween(a, b);
    expect(meters).toBeGreaterThan(111_320 * 0.99);
    expect(meters).toBeLessThan(111_320 * 1.01);
  });

  it('es simétrica', () => {
    const a = { latitude: -16.5, longitude: -68.15 };
    const b = { latitude: -16.51, longitude: -68.12 };
    expect(service.metersBetween(a, b)).toBe(service.metersBetween(b, a));
  });
});
