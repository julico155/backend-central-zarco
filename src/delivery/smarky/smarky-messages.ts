/**
 * Mensaje de WhatsApp con el link de seguimiento y el código de entrega. El código
 * se entrega una sola vez: va en este mensaje y no se guarda ni se escribe en logs.
 */
export function buildTrackingMessage(input: {
  orderNumber: string;
  trackingUrl: string;
  deliveryCode: string | null;
}): string {
  const lines = [
    `Tu pedido ${input.orderNumber} ya está en camino de ser asignado a un repartidor.`,
    '',
    `Sigue tu pedido en vivo aquí: ${input.trackingUrl}`,
  ];
  if (input.deliveryCode) {
    lines.push(
      '',
      `Código de entrega: ${input.deliveryCode}`,
      'Díselo al repartidor solo cuando tengas tu pedido en la mano.',
    );
  }
  return lines.join('\n');
}

/** Teléfono de `customers` (E.164 o solo dígitos) a E.164 con `+`, o null si no es válido. */
export function toE164(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}
