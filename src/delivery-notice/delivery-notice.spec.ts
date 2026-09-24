import {
  buildDeliveryNotice,
  deliveryCollectOf,
  escapeTelegramHtml,
  mapsLink,
  mergeNoticeItems,
  promotionsToNoticeItems,
  shortOrderNumber,
  toNoticeCollect,
  whatsappLink,
  type DeliveryCollectInput,
  type DeliveryNoticeInput,
} from './delivery-notice';

function notice(overrides: Partial<DeliveryNoticeInput> = {}): DeliveryNoticeInput {
  return {
    orderNumber: 'ORD-260902-009',
    customerName: 'Ana Pérez',
    customerPhone: '+591 7000-0000',
    items: [{ name: 'Lomito', quantity: 2 }],
    deliveryAmount: 13,
    subtotalAmount: 48,
    isCash: false,
    collect: { kind: 'envio' },
    customerNote: null,
    latitude: -17.78,
    longitude: -63.18,
    distanceMeters: 5762,
    ...overrides,
  };
}

function collectInput(overrides: Partial<DeliveryCollectInput> = {}): DeliveryCollectInput {
  return {
    deliveryType: 'delivery',
    paymentMethod: 'qr',
    totalAmount: 61,
    subtotalAmount: 48,
    deliveryFeePaid: null,
    amountLabel: null,
    ...overrides,
  };
}

const MAPS = 'https://www.google.com/maps/search/?api=1&amp;query=-17.78,-63.18';

describe('buildDeliveryNotice — formato exacto', () => {
  it('QR con envío por cobrar: texto literal, sin salto final', () => {
    expect(buildDeliveryNotice(notice())).toBe(
      [
        'ORD-009',
        '',
        'Cliente: Ana Pérez',
        'Teléfono: https://wa.me/59170000000',
        '',
        'Pedido (2 productos):',
        '  2x Lomito',
        '',
        'Envío: Bs 13 · 5.8 km',
        '',
        'COBRAR ENVÍO',
        '',
        `Ubicación: ${MAPS}`,
      ].join('\n'),
    );
  });

  it('efectivo: QUIERE EFECTIVO + Productos / Envío / TOTAL A COBRAR y sin instrucción de QR', () => {
    const text = buildDeliveryNotice(
      notice({ isCash: true, collect: { kind: 'todo', amount: 61 } }),
    );
    expect(text).toContain(
      [
        '<b>QUIERE EFECTIVO</b>',
        'Productos: Bs 48',
        'Envío: Bs 13 · 5.8 km',
        'TOTAL A COBRAR: Bs 61',
      ].join('\n'),
    );
    expect(text).not.toContain('COBRAR ENVÍO');
    expect(text).not.toContain('ENVÍO PAGADO');
  });

  it('QR con envío ya pagado', () => {
    expect(buildDeliveryNotice(notice({ collect: { kind: 'pagado' } }))).toContain(
      '\nENVÍO PAGADO\n',
    );
  });

  it('sin instrucción (collect null) no escribe línea de cobro', () => {
    expect(buildDeliveryNotice(notice({ collect: null }))).not.toMatch(/COBRAR|ENVÍO PAGADO/);
  });

  it('montos: enteros sin decimales, fraccionarios con dos', () => {
    const text = buildDeliveryNotice(
      notice({ isCash: true, subtotalAmount: 48.5, deliveryAmount: 13 }),
    );
    expect(text).toContain('Productos: Bs 48.50');
    expect(text).toContain('TOTAL A COBRAR: Bs 61.50');
  });

  it('distancia con un decimal, y sin distancia no deja el separador', () => {
    expect(buildDeliveryNotice(notice({ distanceMeters: 1049 }))).toContain(
      'Envío: Bs 13 · 1.0 km',
    );
    const sin = buildDeliveryNotice(notice({ distanceMeters: null }));
    expect(sin).toContain('Envío: Bs 13\n');
    expect(sin).not.toContain('·');
  });

  it('un solo producto usa el singular', () => {
    expect(buildDeliveryNotice(notice({ items: [{ name: 'Lomito', quantity: 1 }] }))).toContain(
      'Pedido (1 producto):',
    );
  });

  it('nota del cliente: una línea por renglón, sin vacías, escapada, antes de la ubicación', () => {
    const text = buildDeliveryNotice(
      notice({ customerNote: 'sin cebolla\n\n  tocar <timbre> & esperar  ' }),
    );
    expect(text).toContain(
      'NOTA DEL CLIENTE:\nsin cebolla\ntocar &lt;timbre&gt; &amp; esperar\n\nUbicación:',
    );
  });

  it('sin nota no aparece el bloque', () => {
    expect(buildDeliveryNotice(notice({ customerNote: '  \n ' }))).not.toContain(
      'NOTA DEL CLIENTE',
    );
  });

  it('escapa HTML en nombre del cliente y de productos', () => {
    const text = buildDeliveryNotice(
      notice({ customerName: 'A<b>&Co', items: [{ name: 'Sándwich <XL> & más', quantity: 1 }] }),
    );
    expect(text).toContain('Cliente: A&lt;b&gt;&amp;Co');
    expect(text).toContain('  1x Sándwich &lt;XL&gt; &amp; más');
  });

  it('sin nombre → "sin nombre"', () => {
    expect(buildDeliveryNotice(notice({ customerName: '  ' }))).toContain('Cliente: sin nombre');
  });

  it('el teléfono es enlace wa.me y el mapa es enlace de Google Maps (& escapado para HTML)', () => {
    const text = buildDeliveryNotice(notice());
    expect(text).toContain('Teléfono: https://wa.me/59170000000');
    expect(text.endsWith(`Ubicación: ${MAPS}`)).toBe(true);
  });
});

describe('helpers', () => {
  it('escapeTelegramHtml escapa solo & < >', () => {
    expect(escapeTelegramHtml(`a&b<c>d"e'f`)).toBe(`a&amp;b&lt;c&gt;d"e'f`);
  });

  it('shortOrderNumber recorta la jornada y respeta formas viejas', () => {
    expect(shortOrderNumber('ORD-260902-009')).toBe('ORD-009');
    expect(shortOrderNumber('ORD-000123')).toBe('ORD-000123');
  });

  it('whatsappLink / mapsLink', () => {
    expect(whatsappLink('+591 70-00')).toBe('https://wa.me/5917000');
    expect(whatsappLink('sin teléfono')).toBe('sin teléfono');
    expect(mapsLink(1.5, -2.5)).toBe('https://www.google.com/maps/search/?api=1&query=1.5,-2.5');
  });
});

describe('productos repetidos y componentes reales de promociones', () => {
  it('mergeNoticeItems junta por nombre y conserva el orden de primera aparición', () => {
    expect(
      mergeNoticeItems([
        { name: 'Lomito', quantity: 1 },
        { name: 'Coca', quantity: 1 },
        { name: 'Lomito', quantity: 2 },
      ]),
    ).toEqual([
      { name: 'Lomito', quantity: 3 },
      { name: 'Coca', quantity: 1 },
    ]);
  });

  it('un combo se aplana en sus productos reales (no el nombre de la promo) y suma con los sueltos', () => {
    const combo = promotionsToNoticeItems([
      {
        comboQuantity: 2,
        components: [
          { productId: 'p1', code: 'LOM', name: 'Lomito', unitPrice: 20, quantity: 1 },
          { productId: 'p2', code: 'COC', name: 'Coca', unitPrice: 5, quantity: 1 },
        ],
      },
    ]);
    expect(combo).toEqual([
      { name: 'Lomito', quantity: 2 },
      { name: 'Coca', quantity: 2 },
    ]);
    const text = buildDeliveryNotice(
      notice({ items: mergeNoticeItems([{ name: 'Lomito', quantity: 1 }, ...combo]) }),
    );
    expect(text).toContain('Pedido (5 productos):\n  3x Lomito\n  2x Coca');
  });

  it('descarta componentes ilegibles sin romper', () => {
    expect(
      promotionsToNoticeItems([
        { comboQuantity: 1, components: 'basura' },
        { comboQuantity: 0, components: [{ name: 'X', quantity: 1 }] },
        {
          comboQuantity: 1,
          components: [null, { name: '', quantity: 1 }, { name: 'Y', quantity: 1.5 }],
        },
      ]),
    ).toEqual([]);
  });
});

describe('deliveryCollectOf — precedencia de sarcoRestaurant', () => {
  it('no delivery → null', () => {
    expect(deliveryCollectOf(collectInput({ deliveryType: 'pickup' }))).toBeNull();
  });

  it('0. efectivo: cobrar TODO el total, gana sobre cualquier override', () => {
    expect(
      deliveryCollectOf(
        collectInput({ paymentMethod: 'cash', deliveryFeePaid: true, amountLabel: 'pago_total' }),
      ),
    ).toEqual({ kind: 'todo', amount: 61, basis: 'efectivo' });
  });

  it('1. override humano true → envío pagado (gana sobre pago_productos)', () => {
    expect(
      deliveryCollectOf(collectInput({ deliveryFeePaid: true, amountLabel: 'pago_productos' })),
    ).toEqual({ kind: 'pagado', basis: 'persona' });
  });

  it('1. override humano false → cobrar envío (gana sobre pago_total): false NO es "sin override"', () => {
    expect(
      deliveryCollectOf(collectInput({ deliveryFeePaid: false, amountLabel: 'pago_total' })),
    ).toEqual({ kind: 'envio', amount: 13, basis: 'persona' });
  });

  it('2. sin override + pago_total → envío pagado', () => {
    expect(deliveryCollectOf(collectInput({ amountLabel: 'pago_total' }))).toEqual({
      kind: 'pagado',
      basis: 'comprobante',
    });
  });

  it('3. sin override + pago_productos → cobrar envío', () => {
    expect(deliveryCollectOf(collectInput({ amountLabel: 'pago_productos' }))).toEqual({
      kind: 'envio',
      amount: 13,
      basis: 'comprobante',
    });
  });

  it.each([['revisar_monto'], [null]])(
    '4. %s → regla por defecto de QR (cobrar envío, sin confirmar)',
    (label) => {
      expect(deliveryCollectOf(collectInput({ amountLabel: label }))).toEqual({
        kind: 'envio',
        amount: 13,
        basis: 'pedido',
      });
    },
  );

  it('4. por defecto con envío en 0 → pagado', () => {
    expect(deliveryCollectOf(collectInput({ totalAmount: 48 }))).toEqual({
      kind: 'pagado',
      basis: 'pedido',
    });
  });

  it('override false con envío 0 → sigue siendo "cobrar envío" (decisión humana)', () => {
    expect(deliveryCollectOf(collectInput({ totalAmount: 48, deliveryFeePaid: false }))).toEqual({
      kind: 'envio',
      amount: 0,
      basis: 'persona',
    });
  });

  it('método que no es QR ni efectivo (split) → sin instrucción', () => {
    expect(deliveryCollectOf(collectInput({ paymentMethod: 'split' }))).toBeNull();
  });

  it('toNoticeCollect descarta basis/amount cuando no aplican', () => {
    expect(toNoticeCollect({ kind: 'envio', amount: 13, basis: 'pedido' })).toEqual({
      kind: 'envio',
    });
    expect(toNoticeCollect({ kind: 'pagado', basis: 'persona' })).toEqual({ kind: 'pagado' });
    expect(toNoticeCollect({ kind: 'todo', amount: 61, basis: 'efectivo' })).toEqual({
      kind: 'todo',
      amount: 61,
    });
    expect(toNoticeCollect(null)).toBeNull();
  });
});
