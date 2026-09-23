import { DomainException } from '../common/exceptions/domain-exception';
import {
  assertRoleCanMoveStatus,
  checkDriverPresence,
  mapsUrl,
  presenceException,
  resolveHistoryDriverId,
} from './delivery-drivers.rules';

describe('checkDriverPresence', () => {
  it('dentro del radio es ok, justo en el borde también', () => {
    expect(checkDriverPresence(40, 10, 150)).toEqual({ ok: true });
    expect(checkDriverPresence(150, undefined, 150)).toEqual({ ok: true });
  });

  it('fuera del radio es not_at_restaurant', () => {
    expect(checkDriverPresence(151, 10, 150)).toEqual({ ok: false, code: 'not_at_restaurant' });
  });

  it('una precisión peor que el radio no sirve para decidir', () => {
    expect(checkDriverPresence(10, 500, 150)).toEqual({ ok: false, code: 'location_too_imprecise' });
  });
});

describe('presenceException', () => {
  it('not_at_restaurant es 403 con la distancia y location_too_imprecise es 400', () => {
    const far = presenceException({ ok: false, code: 'not_at_restaurant' }, 800, 150);
    expect(far).toBeInstanceOf(DomainException);
    expect(far.getStatus()).toBe(403);
    expect(far.details).toEqual({ distanceMeters: 800, radiusMeters: 150 });
    expect(presenceException({ ok: false, code: 'location_too_imprecise' }, 10, 150).getStatus()).toBe(400);
  });
});

describe('assertRoleCanMoveStatus', () => {
  it('la cocina no puede mover un delivery a out_for_delivery ni delivered', () => {
    for (const to of ['out_for_delivery', 'delivered'] as const) {
      expect(() => assertRoleCanMoveStatus('kitchen', 'delivery', to)).toThrow(DomainException);
    }
  });

  it('el admin sí, y la cocina sigue moviendo pickup y mesa', () => {
    expect(() => assertRoleCanMoveStatus('admin', 'delivery', 'delivered')).not.toThrow();
    expect(() => assertRoleCanMoveStatus('kitchen', 'pickup', 'delivered')).not.toThrow();
    expect(() => assertRoleCanMoveStatus('kitchen', 'dine_in', 'delivered')).not.toThrow();
    expect(() => assertRoleCanMoveStatus('kitchen', 'delivery', 'ready')).not.toThrow();
  });
});

describe('resolveHistoryDriverId', () => {
  const driver = { sub: 'driver-1', role: 'delivery' as const };
  const admin = { sub: 'admin-1', role: 'admin' as const };
  const cashier = { sub: 'cashier-1', role: 'cashier' as const };

  it('el repartidor solo ve lo suyo: sin filtro o con su propio id', () => {
    expect(resolveHistoryDriverId(driver, undefined)).toBe('driver-1');
    expect(resolveHistoryDriverId(driver, 'driver-1')).toBe('driver-1');
  });

  it('el repartidor pidiendo las entregas de otro recibe 403', () => {
    try {
      resolveHistoryDriverId(driver, 'driver-2');
      fail('debía lanzar');
    } catch (error) {
      expect((error as DomainException).code).toBe('not_your_history');
      expect((error as DomainException).getStatus()).toBe(403);
    }
  });

  it('admin y cajero pueden filtrar por un repartidor o ver todos (null)', () => {
    expect(resolveHistoryDriverId(admin, 'driver-2')).toBe('driver-2');
    expect(resolveHistoryDriverId(cashier, undefined)).toBeNull();
  });
});

describe('mapsUrl', () => {
  it('arma el link de Google Maps con las coordenadas', () => {
    expect(mapsUrl(-17.39, -66.16)).toBe(
      'https://www.google.com/maps/search/?api=1&query=-17.39,-66.16',
    );
  });
});
