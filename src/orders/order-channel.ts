import { HttpStatus } from '@nestjs/common';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { STAFF_API_CLIENT } from '../common/guards/service-or-staff-auth.guard';
import { OrderChannel, OrderPaymentMethod } from '../database/types';

/**
 * Canal de origen de un pedido según la CREDENCIAL con que llegó, nunca según
 * lo que diga el body: el JWT de staff (POS/dashboard) es `pos` y cada token de
 * servicio mapea a su propio canal. Así un cliente no puede hacerse pasar por
 * otro para saltarse las reglas de su canal.
 */
const CHANNEL_BY_API_CLIENT: Record<string, OrderChannel> = {
  [STAFF_API_CLIENT]: 'pos',
  'whatsapp-gateway': 'whatsapp',
  web: 'web',
};

/**
 * Reglas de pago por canal. WhatsApp solo cobra por QR (delivery, pickup y
 * mesa): no hay persona presente que reciba efectivo, y un pedido sin pagar no
 * debe llegar a cocina. El POS conserva sus métodos (efectivo, QR y split).
 */
export function assertPaymentMethodAllowed(
  channel: OrderChannel,
  paymentMethod: OrderPaymentMethod,
): void {
  if (channel === 'whatsapp' && paymentMethod !== 'qr') {
    throw new DomainException(
      'payment_method_not_allowed',
      HttpStatus.BAD_REQUEST,
      'Los pedidos de WhatsApp solo se pagan por QR.',
      { channel, paymentMethod, allowed: ['qr'] },
    );
  }
}

export function resolveOrderChannel(apiClient: string, declared?: OrderChannel): OrderChannel {
  const channel = CHANNEL_BY_API_CLIENT[apiClient];
  if (!channel) {
    throw new ValidationError(`El cliente de servicio "${apiClient}" no tiene un canal de pedidos asignado.`);
  }
  if (declared !== undefined && declared !== channel) {
    throw new DomainException(
      'channel_mismatch',
      HttpStatus.BAD_REQUEST,
      `Esta credencial solo puede crear pedidos del canal "${channel}", pero el body declara "${declared}".`,
      { expected: channel, declared },
    );
  }
  return channel;
}
