export const LOGISTICS_SOURCE_SYSTEM = 'zarco-orders-core';

export interface CreateLogisticsDeliveryRequest {
  tenantId: string;
  restaurantId: string;
  branchId: string;
  externalOrderId: string;
  sourceSystem: typeof LOGISTICS_SOURCE_SYSTEM;
  pickupAddress: string | null;
  pickupLatitude: number;
  pickupLongitude: number;
  dropoffAddress: string;
  dropoffLatitude: number;
  dropoffLongitude: number;
  customerName: string;
  customerPhone: string | null;
  customerNotes: string | null;
  deliveryFee: number;
}

export interface LogisticsDeliverySnapshotInput {
  logistics: {
    tenantId: string;
    restaurantId: string;
    branchId: string;
    pickupAddress: string | null;
  };
  order: {
    id: string;
    customerName: string;
    customerNotes: string | null;
    deliveryBaseAmount: string;
    deliverySurchargeAmount: string;
    dropoffAddress: string | null;
    dropoffLatitude: number | null;
    dropoffLongitude: number | null;
  };
  customerPhone: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
}

export function buildCreateLogisticsDeliveryRequest(
  input: LogisticsDeliverySnapshotInput,
): CreateLogisticsDeliveryRequest {
  const tenantId = requiredString(input.logistics.tenantId, 'tenantId');
  const restaurantId = requiredString(input.logistics.restaurantId, 'restaurantId');
  const branchId = requiredString(input.logistics.branchId, 'branchId');
  const externalOrderId = requiredString(input.order.id, 'externalOrderId');
  const dropoffAddress = requiredString(input.order.dropoffAddress, 'dropoffAddress');
  const pickupLatitude = requiredCoordinate(input.pickupLatitude, 'pickupLatitude');
  const pickupLongitude = requiredCoordinate(input.pickupLongitude, 'pickupLongitude');
  const dropoffLatitude = requiredCoordinate(input.order.dropoffLatitude, 'dropoffLatitude');
  const dropoffLongitude = requiredCoordinate(input.order.dropoffLongitude, 'dropoffLongitude');
  const deliveryBaseAmount = requiredAmount(input.order.deliveryBaseAmount, 'deliveryBaseAmount');
  const deliverySurchargeAmount = requiredAmount(
    input.order.deliverySurchargeAmount,
    'deliverySurchargeAmount',
  );

  return {
    tenantId,
    restaurantId,
    branchId,
    externalOrderId,
    sourceSystem: LOGISTICS_SOURCE_SYSTEM,
    pickupAddress: input.logistics.pickupAddress,
    pickupLatitude,
    pickupLongitude,
    dropoffAddress,
    dropoffLatitude,
    dropoffLongitude,
    customerName: requiredString(input.order.customerName, 'customerName'),
    customerPhone: input.customerPhone,
    customerNotes: input.order.customerNotes,
    deliveryFee: deliveryBaseAmount + deliverySurchargeAmount,
  };
}

function requiredString(value: string | null, field: string): string {
  if (value === null || value.trim().length === 0) {
    throw new Error(`Missing required logistics field: ${field}`);
  }
  return value;
}

function requiredCoordinate(value: number | null, field: string): number {
  if (value === null || !Number.isFinite(value)) {
    throw new Error(`Missing required logistics field: ${field}`);
  }
  return value;
}

function requiredAmount(value: string, field: string): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error(`Invalid logistics field: ${field}`);
  }
  return amount;
}
