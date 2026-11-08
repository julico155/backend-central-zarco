import { isAbandonedDeliveryStatus, isTerminalDeliveryStatus, orderStatusForDelivery } from './smarky-status';

describe('orderStatusForDelivery', () => {
  it('buscar, asignar y llegar al local no mueven el pedido (sigue en cocina)', () => {
    for (const estado of ['searching', 'assigned', 'at_restaurant'] as const) {
      expect(orderStatusForDelivery(estado, 'preparing')).toBeNull();
    }
  });

  it('in_transit pasa a out_for_delivery, aunque cocina no lo haya marcado ready', () => {
    expect(orderStatusForDelivery('in_transit', 'confirmed')).toBe('out_for_delivery');
    expect(orderStatusForDelivery('in_transit', 'preparing')).toBe('out_for_delivery');
    expect(orderStatusForDelivery('in_transit', 'ready')).toBe('out_for_delivery');
  });

  it('in_transit repetido no cambia un pedido que ya va en camino', () => {
    expect(orderStatusForDelivery('in_transit', 'out_for_delivery')).toBeNull();
  });

  it('delivered pasa a delivered desde cualquier estado vivo', () => {
    expect(orderStatusForDelivery('delivered', 'out_for_delivery')).toBe('delivered');
    expect(orderStatusForDelivery('delivered', 'preparing')).toBe('delivered');
  });

  it('cancelled y failed NO cancelan un pedido ya pagado (se atiende con repartidores propios)', () => {
    expect(orderStatusForDelivery('cancelled', 'preparing')).toBeNull();
    expect(orderStatusForDelivery('failed', 'ready')).toBeNull();
  });

  it('un pedido entregado o cancelado nunca se mueve', () => {
    for (const actual of ['delivered', 'cancelled'] as const) {
      expect(orderStatusForDelivery('in_transit', actual)).toBeNull();
      expect(orderStatusForDelivery('delivered', actual)).toBeNull();
    }
  });
});

describe('estados de entrega', () => {
  it('terminales y abandonados', () => {
    expect(isTerminalDeliveryStatus('delivered')).toBe(true);
    expect(isTerminalDeliveryStatus('in_transit')).toBe(false);
    expect(isTerminalDeliveryStatus(null)).toBe(false);
    expect(isAbandonedDeliveryStatus('cancelled')).toBe(true);
    expect(isAbandonedDeliveryStatus('failed')).toBe(true);
    expect(isAbandonedDeliveryStatus('delivered')).toBe(false);
    expect(isAbandonedDeliveryStatus(null)).toBe(false);
  });
});
