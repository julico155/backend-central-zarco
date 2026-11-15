import { HttpStatus } from '@nestjs/common';
import { OrderItemExtraSnapshot } from '../database/types';
import { DomainException, ValidationError } from '../common/exceptions/domain-exception';

/** Lo que manda el cliente por línea: qué extra y cuántas veces en UNA unidad del producto. */
export interface ItemExtraInput {
  extraId: string;
  quantity: number;
}

/** Un extra del catálogo ya cargado de la base, con los productos a los que aplica. */
export interface ExtraCatalogEntry {
  id: string;
  name: string;
  price: string | number;
  applies_to_all: boolean;
  is_active: boolean;
  /** Solo relevante cuando applies_to_all = false. */
  productIds: ReadonlySet<string>;
}

/** Clave estable (orden-insensible) de los extras de una línea — para detectar líneas duplicadas. */
export function extrasKey(extras: ItemExtraInput[] | undefined): string {
  return JSON.stringify(
    [...(extras ?? [])]
      .map((e) => [e.extraId, e.quantity] as const)
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
}

export function toCents(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

/**
 * Valida los extras de UNA línea contra el catálogo y devuelve su snapshot (con el precio de hoy) y lo que suman por
 * unidad del producto, en centavos. Nunca confía en un precio del cliente: solo viaja `extraId` + `quantity`.
 */
export function priceItemExtras(
  productId: string,
  extras: ItemExtraInput[] | undefined,
  catalog: ReadonlyMap<string, ExtraCatalogEntry>,
): { snapshot: OrderItemExtraSnapshot[]; perUnitCents: number } {
  if (!extras || extras.length === 0) return { snapshot: [], perUnitCents: 0 };

  const seen = new Set<string>();
  const snapshot: OrderItemExtraSnapshot[] = [];
  let perUnitCents = 0;

  for (const input of extras) {
    if (seen.has(input.extraId)) {
      throw new ValidationError('Un extra se repite en la misma línea. Mandá una sola entrada con su cantidad.');
    }
    seen.add(input.extraId);

    const extra = catalog.get(input.extraId);
    if (!extra) {
      throw new DomainException('unknown_extra', HttpStatus.BAD_REQUEST, 'El extra no existe.', {
        productId,
        extraId: input.extraId,
      });
    }
    if (!extra.is_active) {
      throw new DomainException(
        'extra_unavailable',
        HttpStatus.CONFLICT,
        `El extra "${extra.name}" ya no está disponible.`,
        { productId, extraId: extra.id },
      );
    }
    if (!extra.applies_to_all && !extra.productIds.has(productId)) {
      throw new DomainException(
        'extra_not_for_product',
        HttpStatus.BAD_REQUEST,
        `El extra "${extra.name}" no se puede agregar a este producto.`,
        { productId, extraId: extra.id },
      );
    }

    const unitCents = toCents(extra.price);
    perUnitCents += unitCents * input.quantity;
    snapshot.push({
      extraId: extra.id,
      name: extra.name,
      unitPrice: unitCents / 100,
      quantity: input.quantity,
    });
  }

  return { snapshot, perUnitCents };
}

/** "Trancapecho (+2 Carne, +1 Queso)" — para los consumidores cuyo contrato no tiene un campo de extras (mensajes al cliente). */
export function describeExtras(extras: readonly { name: string; quantity: number }[]): string {
  return extras.map((e) => `+${e.quantity} ${e.name}`).join(', ');
}
