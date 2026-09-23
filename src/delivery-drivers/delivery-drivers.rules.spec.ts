import { DomainException } from '../common/exceptions/domain-exception';
import {
  assertRoleCanMoveStatus,
  checkDriverPresence,
  mapsUrl,
  presenceException,
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

describe('mapsUrl', () => {
  it('arma el link de Google Maps con las coordenadas', () => {
    expect(mapsUrl(-17.39, -66.16)).toBe(
      'https://www.google.com/maps/search/?api=1&query=-17.39,-66.16',
    );
  });
});
