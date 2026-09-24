import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import {
  assertPaymentMethodAllowed,
  isPaymentMethodAllowed,
  resolveOrderChannel,
} from './order-channel';

describe('assertPaymentMethodAllowed', () => {
  it('WhatsApp solo acepta QR', () => {
    expect(() => assertPaymentMethodAllowed('whatsapp', 'qr')).not.toThrow();
    for (const method of ['cash', 'card', 'split'] as const) {
      try {
        assertPaymentMethodAllowed('whatsapp', method);
        fail('debía lanzar');
      } catch (error) {
        expect((error as DomainException).code).toBe('payment_method_not_allowed');
        expect((error as DomainException).getStatus()).toBe(400);
      }
    }
  });

  it('el POS conserva sus métodos', () => {
    for (const method of ['qr', 'cash', 'split'] as const) {
      expect(() => assertPaymentMethodAllowed('pos', method)).not.toThrow();
    }
  });
});

describe('isPaymentMethodAllowed (versión no-throw, usada por sarco-agent/sarco-menu para derivar cashAllowed)', () => {
  it('nunca hardcodea: refleja exactamente lo que decide assertPaymentMethodAllowed', () => {
    expect(isPaymentMethodAllowed('whatsapp', 'qr')).toBe(true);
    expect(isPaymentMethodAllowed('whatsapp', 'cash')).toBe(false);
    expect(isPaymentMethodAllowed('pos', 'cash')).toBe(true);
  });
});

describe('resolveOrderChannel', () => {
  it('el JWT de staff es pos y el token del agente es whatsapp', () => {
    expect(resolveOrderChannel('pos')).toBe('pos');
    expect(resolveOrderChannel('whatsapp-gateway')).toBe('whatsapp');
    expect(resolveOrderChannel('web')).toBe('web');
  });

  it('acepta un channel declarado que coincide con la credencial', () => {
    expect(resolveOrderChannel('pos', 'pos')).toBe('pos');
    expect(resolveOrderChannel('whatsapp-gateway', 'whatsapp')).toBe('whatsapp');
  });

  it('rechaza con 400 channel_mismatch si el body declara otro canal', () => {
    try {
      resolveOrderChannel('pos', 'whatsapp');
      fail('debía lanzar');
    } catch (error) {
      expect(error).toBeInstanceOf(DomainException);
      expect((error as DomainException).code).toBe('channel_mismatch');
      expect((error as DomainException).getStatus()).toBe(400);
    }
    expect(() => resolveOrderChannel('whatsapp-gateway', 'pos')).toThrow(DomainException);
  });

  it('rechaza un cliente de servicio sin canal asignado', () => {
    expect(() => resolveOrderChannel('otro-servicio')).toThrow(ValidationError);
  });
});
