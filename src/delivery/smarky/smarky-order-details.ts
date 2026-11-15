import { SmarkyCreateDeliveryInput } from './smarky.types';

type OrderDetailsInput = {
  payment_method: string;
  subtotal_amount: string;
  split_cash_amount: string | null;
  notes: string | null;
};

type ItemInput = {
  product_name_snapshot: string;
  quantity: number;
  excluded_complements: string[] | null;
};

export type SmarkyOrderDetails = Pick<
  SmarkyCreateDeliveryInput,
  'paymentMethod' | 'cashToCollect' | 'items' | 'orderNotes'
>;

const MAX_ITEMS = 50;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Datos informativos para el repartidor (la plataforma no toca ese dinero).
 * - `cash` puro: cobra la comida (`subtotal_amount`, sin envío).
 * - `split`: la parte en efectivo, sin pasar de la comida; si no queda efectivo por la comida, `qr`.
 * - `qr`/`card`: `qr`, sin monto a cobrar.
 */
export function buildSmarkyOrderDetails(order: OrderDetailsInput, items: ItemInput[]): SmarkyOrderDetails {
  const food = Number(order.subtotal_amount);
  let cash = 0;
  if (order.payment_method === 'cash') cash = food;
  else if (order.payment_method === 'split') cash = Math.min(Number(order.split_cash_amount ?? 0), food);

  const details: SmarkyOrderDetails = {
    paymentMethod: Number.isFinite(cash) && cash > 0 ? 'cash' : 'qr',
  };
  if (details.paymentMethod === 'cash') details.cashToCollect = cash.toFixed(2);

  const lines = items
    .filter((item) => item.quantity >= 1)
    .slice(0, MAX_ITEMS)
    .map((item) => {
      const excluded = (item.excluded_complements ?? []).filter(Boolean);
      return {
        name: clip(item.product_name_snapshot, 120),
        quantity: Math.min(item.quantity, 999),
        ...(excluded.length > 0 ? { notes: clip(`Sin ${excluded.join(', ')}`, 200) } : {}),
      };
    });
  if (lines.length > 0) details.items = lines;

  const notes = order.notes?.trim();
  if (notes) details.orderNotes = clip(notes, 500);
  return details;
}
