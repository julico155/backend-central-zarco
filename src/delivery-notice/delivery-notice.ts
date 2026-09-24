/**
 * Aviso del pedido al grupo de reparto (Telegram) — módulo PURO, sin red ni
 * base de datos. Puerto directo de sarcoRestaurant
 * (src/lib/alerts/delivery-notice.ts + `deliveryCollectOf` de
 * src/lib/kitchen/ticket-view.ts + `promotionsToKitchenLines`). El texto es el
 * que las motos ya leen: no cambiar el formato sin avisar al reparto.
 *
 * Se envía con `parse_mode: 'HTML'`; la única etiqueta que pone este módulo es
 * `<b>QUIERE EFECTIVO</b>`, todo lo variable se escapa.
 */

export interface DeliveryNoticeItem {
  name: string;
  quantity: number;
}

/** Junta las unidades del mismo producto conservando el orden de primera aparición. */
export function mergeNoticeItems(items: DeliveryNoticeItem[]): DeliveryNoticeItem[] {
  const porNombre = new Map<string, DeliveryNoticeItem>();
  for (const item of items) {
    const previo = porNombre.get(item.name);
    if (previo) previo.quantity += item.quantity;
    else porNombre.set(item.name, { name: item.name, quantity: item.quantity });
  }
  return [...porNombre.values()];
}

/** Qué se cobra al entregar, ya resuelto por `deliveryCollectOf`. */
export type DeliveryNoticeCollect =
  { kind: 'pagado' } | { kind: 'envio' } | { kind: 'todo'; amount: number };

export interface DeliveryNoticeInput {
  orderNumber: string;
  customerName: string | null;
  customerPhone: string;
  items: DeliveryNoticeItem[];
  deliveryAmount: number;
  subtotalAmount: number;
  isCash: boolean;
  collect: DeliveryNoticeCollect | null;
  customerNote: string | null;
  latitude: number;
  longitude: number;
  distanceMeters: number | null;
}

/** Tres caracteres, los que Telegram exige en modo HTML. */
export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Bs con dos decimales solo cuando hacen falta: "16" y no "16.00". */
function formatBs(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2);
}

/** Kilómetros con un decimal: 5762 m → "5.8 km". */
function formatDistance(meters: number): string {
  return `${(meters / 1000).toFixed(1)} km`;
}

/** `ORD-260902-009` → `ORD-009`; cualquier otra forma se devuelve entera. */
export function shortOrderNumber(orderNumber: string): string {
  const partes = /^ORD-\d{6}-(\d+)$/.exec(orderNumber.trim());
  return partes === null ? orderNumber : `ORD-${partes[1]}`;
}

/** Enlace directo al chat de WhatsApp; sin dígitos devuelve el texto tal cual. */
export function whatsappLink(phone: string): string {
  const digitos = phone.replace(/\D+/g, '');
  return digitos === '' ? phone : `https://wa.me/${digitos}`;
}

export function mapsLink(latitude: number, longitude: number): string {
  return `https://www.google.com/maps/search/?api=1&query=${latitude},${longitude}`;
}

export function buildDeliveryNotice(input: DeliveryNoticeInput): string {
  const lines: string[] = [];
  lines.push(shortOrderNumber(input.orderNumber));
  lines.push('');

  const nombre = (input.customerName ?? '').trim();
  lines.push(`Cliente: ${escapeTelegramHtml(nombre === '' ? 'sin nombre' : nombre)}`);
  lines.push(`Teléfono: ${escapeTelegramHtml(whatsappLink(input.customerPhone))}`);
  lines.push('');

  const total = input.items.reduce((sum, i) => sum + i.quantity, 0);
  lines.push(`Pedido (${total} ${total === 1 ? 'producto' : 'productos'}):`);
  for (const item of input.items) {
    lines.push(`  ${item.quantity}x ${escapeTelegramHtml(item.name)}`);
  }
  lines.push('');

  const distancia =
    input.distanceMeters === null ? '' : ` · ${formatDistance(input.distanceMeters)}`;

  if (input.isCash) {
    lines.push('<b>QUIERE EFECTIVO</b>');
    lines.push(`Productos: Bs ${formatBs(input.subtotalAmount)}`);
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distancia}`);
    lines.push(`TOTAL A COBRAR: Bs ${formatBs(input.subtotalAmount + input.deliveryAmount)}`);
    lines.push('');
  } else {
    lines.push(`Envío: Bs ${formatBs(input.deliveryAmount)}${distancia}`);
    lines.push('');
    const instruccion = collectLine(input.collect);
    if (instruccion !== null) {
      lines.push(instruccion);
      lines.push('');
    }
  }

  const nota = customerNoteBlock(input.customerNote);
  if (nota !== null) {
    lines.push(...nota);
    lines.push('');
  }

  lines.push(`Ubicación: ${escapeTelegramHtml(mapsLink(input.latitude, input.longitude))}`);
  return lines.join('\n');
}

/** Una línea por renglón de `notes`; las vacías se caen. */
function customerNoteBlock(note: string | null): string[] | null {
  const lineas = (note ?? '')
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea !== '');
  if (lineas.length === 0) return null;
  return ['NOTA DEL CLIENTE:', ...lineas.map((linea) => escapeTelegramHtml(linea))];
}

function collectLine(collect: DeliveryNoticeCollect | null): string | null {
  if (collect === null) return null;
  if (collect.kind === 'pagado') return 'ENVÍO PAGADO';
  if (collect.kind === 'envio') return 'COBRAR ENVÍO';
  return `COBRAR TODO: Bs ${formatBs(collect.amount)}`;
}

// ── Qué se cobra en la puerta ────────────────────────────────────────────────

export type DeliveryCollectKind =
  { kind: 'pagado' } | { kind: 'envio'; amount: number } | { kind: 'todo'; amount: number };

export type DeliveryCollect = DeliveryCollectKind & {
  basis: 'efectivo' | 'persona' | 'comprobante' | 'pedido';
};

export interface DeliveryCollectInput {
  deliveryType: string;
  paymentMethod: string;
  totalAmount: number;
  subtotalAmount: number;
  /** Triestado: null = nadie decidió; false = una persona dijo "cobrar envío". */
  deliveryFeePaid: boolean | null;
  /** `payment_proofs.analysis_amount_label` del comprobante del pedido, si hay. */
  amountLabel: string | null;
}

/**
 * Precedencia exacta de sarcoRestaurant:
 *   0. efectivo → cobrar TODO (manda sobre cualquier override)
 *   1. override humano true → pagado; false → cobrar envío
 *   2. sin override + `pago_total` → pagado
 *   3. sin override + `pago_productos` → cobrar envío
 *   4. `revisar_monto` / sin etiqueta → regla por defecto del pedido (QR)
 */
export function deliveryCollectOf(input: DeliveryCollectInput): DeliveryCollect | null {
  if (input.deliveryType !== 'delivery') return null;
  const total = Number(input.totalAmount) || 0;
  const subtotal = Number(input.subtotalAmount) || 0;
  const envio = total - subtotal;

  if (input.paymentMethod === 'cash') {
    return total > 0 ? { kind: 'todo', amount: total, basis: 'efectivo' } : null;
  }

  const segunElPedido = (): DeliveryCollectKind | null => {
    if (input.paymentMethod === 'qr') {
      return envio > 0 ? { kind: 'envio', amount: envio } : { kind: 'pagado' };
    }
    return null;
  };

  if (input.deliveryFeePaid === true) return { kind: 'pagado', basis: 'persona' };
  if (input.deliveryFeePaid === false) {
    const deducido = segunElPedido();
    return deducido !== null && deducido.kind !== 'pagado'
      ? { ...deducido, basis: 'persona' }
      : { kind: 'envio', amount: envio > 0 ? envio : 0, basis: 'persona' };
  }

  if (input.amountLabel === 'pago_total') return { kind: 'pagado', basis: 'comprobante' };

  const deducido = segunElPedido();
  if (deducido === null) return null;

  if (input.amountLabel === 'pago_productos') return { ...deducido, basis: 'comprobante' };
  return { ...deducido, basis: 'pedido' };
}

/** Lo que el aviso necesita de `DeliveryCollect` (sin `basis`). */
export function toNoticeCollect(collect: DeliveryCollect | null): DeliveryNoticeCollect | null {
  if (collect === null) return null;
  if (collect.kind === 'pagado') return { kind: 'pagado' };
  if (collect.kind === 'envio') return { kind: 'envio' };
  return { kind: 'todo', amount: collect.amount };
}

// ── Componentes reales de las promociones ────────────────────────────────────

/** Aplana los combos en sus productos reales (cantidad del componente × veces el combo). */
export function promotionsToNoticeItems(
  promotions: { comboQuantity: number; components: unknown }[],
): DeliveryNoticeItem[] {
  const lineas: DeliveryNoticeItem[] = [];
  for (const promo of promotions) {
    const veces = Number(promo.comboQuantity);
    if (!Number.isFinite(veces) || veces < 1) continue;
    if (!Array.isArray(promo.components)) continue;
    for (const bruto of promo.components) {
      if (typeof bruto !== 'object' || bruto === null) continue;
      const c = bruto as Record<string, unknown>;
      const name = typeof c.name === 'string' ? c.name.trim() : '';
      if (name === '') continue;
      const quantity = Number(c.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) continue;
      lineas.push({ name, quantity: quantity * veces });
    }
  }
  return lineas;
}
