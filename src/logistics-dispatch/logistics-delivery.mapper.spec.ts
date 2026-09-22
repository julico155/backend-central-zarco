import { buildCreateLogisticsDeliveryRequest } from './logistics-delivery.mapper';

const input = {
  logistics: {
    tenantId: 'tenant-a',
    restaurantId: 'restaurant-a',
    branchId: 'branch-a',
    pickupAddress: null,
  },
  order: {
    id: 'order-a',
    customerName: 'Ana',
    customerNotes: 'Timbre rojo',
    deliveryBaseAmount: '12.50',
    deliverySurchargeAmount: '2.50',
    dropoffAddress: 'Av. Siempre Viva 123',
    dropoffLatitude: -17.78,
    dropoffLongitude: -63.18,
  },
  customerPhone: null,
  pickupLatitude: -17.77,
  pickupLongitude: -63.17,
};

describe('buildCreateLogisticsDeliveryRequest', () => {
  it('creates the immutable Logistics payload using base plus surcharge, never order total', () => {
    const payload = buildCreateLogisticsDeliveryRequest(input);

    expect(payload).toEqual({
      tenantId: 'tenant-a',
      restaurantId: 'restaurant-a',
      branchId: 'branch-a',
      externalOrderId: 'order-a',
      sourceSystem: 'zarco-orders-core',
      pickupAddress: null,
      pickupLatitude: -17.77,
      pickupLongitude: -63.17,
      dropoffAddress: 'Av. Siempre Viva 123',
      dropoffLatitude: -17.78,
      dropoffLongitude: -63.18,
      customerName: 'Ana',
      customerPhone: null,
      customerNotes: 'Timbre rojo',
      deliveryFee: 15,
    });
    expect(payload).not.toHaveProperty('totalAmount');
  });

  it.each([
    ['tenantId', { logistics: { ...input.logistics, tenantId: '' } }],
    ['restaurantId', { logistics: { ...input.logistics, restaurantId: '' } }],
    ['branchId', { logistics: { ...input.logistics, branchId: '' } }],
    ['dropoffAddress', { order: { ...input.order, dropoffAddress: null } }],
    ['pickupLatitude', { pickupLatitude: null }],
    ['pickupLongitude', { pickupLongitude: null }],
    ['dropoffLatitude', { order: { ...input.order, dropoffLatitude: null } }],
    ['dropoffLongitude', { order: { ...input.order, dropoffLongitude: null } }],
  ])('fails explicitly when %s is missing', (field, overrides) => {
    expect(() =>
      buildCreateLogisticsDeliveryRequest({ ...input, ...overrides } as typeof input),
    ).toThrow(`Missing required logistics field: ${field}`);
  });
});
