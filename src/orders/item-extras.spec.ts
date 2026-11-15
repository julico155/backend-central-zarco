import { DomainException, ValidationError } from '../common/exceptions/domain-exception';
import { ExtraCatalogEntry, describeExtras, extrasKey, priceItemExtras } from './item-extras';

const TRANCAPECHO = 'p-trancapecho';
const MIXTO = 'p-mixto';

function entry(overrides: Partial<ExtraCatalogEntry> & { id: string }): ExtraCatalogEntry {
  return {
    name: 'Carne',
    price: '10.00',
    applies_to_all: false,
    is_active: true,
    productIds: new Set<string>(),
    ...overrides,
  };
}

const catalog = new Map<string, ExtraCatalogEntry>([
  ['carne-tranca', entry({ id: 'carne-tranca', name: 'Carne', price: '10.00', productIds: new Set([TRANCAPECHO]) })],
  ['carne-mixto', entry({ id: 'carne-mixto', name: 'Carne', price: '12.50', productIds: new Set([MIXTO]) })],
  ['queso', entry({ id: 'queso', name: 'Queso', price: '3.00', applies_to_all: true })],
  ['agotado', entry({ id: 'agotado', name: 'Huevo', price: '2.00', applies_to_all: true, is_active: false })],
]);

describe('priceItemExtras', () => {
  it('sin extras no suma nada', () => {
    expect(priceItemExtras(TRANCAPECHO, undefined, catalog)).toEqual({ snapshot: [], perUnitCents: 0 });
    expect(priceItemExtras(TRANCAPECHO, [], catalog)).toEqual({ snapshot: [], perUnitCents: 0 });
  });

  it('suma precio × cantidad de cada extra, por unidad del producto', () => {
    const result = priceItemExtras(
      TRANCAPECHO,
      [
        { extraId: 'carne-tranca', quantity: 2 },
        { extraId: 'queso', quantity: 1 },
      ],
      catalog,
    );
    expect(result.perUnitCents).toBe(2 * 1000 + 300);
    expect(result.snapshot).toEqual([
      { extraId: 'carne-tranca', name: 'Carne', unitPrice: 10, quantity: 2 },
      { extraId: 'queso', name: 'Queso', unitPrice: 3, quantity: 1 },
    ]);
  });

  it('la carne de otro plato tiene su propio precio y no se puede usar en este', () => {
    expect(priceItemExtras(MIXTO, [{ extraId: 'carne-mixto', quantity: 1 }], catalog).perUnitCents).toBe(1250);
    expect(() => priceItemExtras(TRANCAPECHO, [{ extraId: 'carne-mixto', quantity: 1 }], catalog)).toThrow(
      expect.objectContaining({ code: 'extra_not_for_product' }),
    );
  });

  it('un extra para todos los platos sirve en cualquier producto', () => {
    expect(priceItemExtras(MIXTO, [{ extraId: 'queso', quantity: 1 }], catalog).perUnitCents).toBe(300);
    expect(priceItemExtras(TRANCAPECHO, [{ extraId: 'queso', quantity: 1 }], catalog).perUnitCents).toBe(300);
  });

  it('rechaza un extra inexistente o dado de baja', () => {
    expect(() => priceItemExtras(MIXTO, [{ extraId: 'nope', quantity: 1 }], catalog)).toThrow(DomainException);
    expect(() => priceItemExtras(MIXTO, [{ extraId: 'agotado', quantity: 1 }], catalog)).toThrow(
      expect.objectContaining({ code: 'extra_unavailable' }),
    );
  });

  it('rechaza el mismo extra repetido en una línea', () => {
    expect(() =>
      priceItemExtras(
        MIXTO,
        [
          { extraId: 'queso', quantity: 1 },
          { extraId: 'queso', quantity: 1 },
        ],
        catalog,
      ),
    ).toThrow(ValidationError);
  });

  it('los centavos no acumulan error de punto flotante', () => {
    const cheap = new Map([['c', entry({ id: 'c', price: '0.10', applies_to_all: true })]]);
    expect(priceItemExtras(MIXTO, [{ extraId: 'c', quantity: 3 }], cheap).perUnitCents).toBe(30);
  });
});

describe('extrasKey', () => {
  it('no depende del orden', () => {
    expect(
      extrasKey([
        { extraId: 'a', quantity: 1 },
        { extraId: 'b', quantity: 2 },
      ]),
    ).toBe(
      extrasKey([
        { extraId: 'b', quantity: 2 },
        { extraId: 'a', quantity: 1 },
      ]),
    );
  });

  it('distingue cantidades distintas del mismo extra', () => {
    expect(extrasKey([{ extraId: 'a', quantity: 1 }])).not.toBe(extrasKey([{ extraId: 'a', quantity: 2 }]));
  });

  it('sin extras es lo mismo que lista vacía', () => {
    expect(extrasKey(undefined)).toBe(extrasKey([]));
  });
});

describe('describeExtras', () => {
  it('arma el texto para los mensajes al cliente', () => {
    expect(
      describeExtras([
        { name: 'Carne', quantity: 2 },
        { name: 'Queso', quantity: 1 },
      ]),
    ).toBe('+2 Carne, +1 Queso');
  });
});
