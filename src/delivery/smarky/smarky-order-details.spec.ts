import { buildSmarkyOrderDetails } from './smarky-order-details';

const base = { payment_method: 'qr', subtotal_amount: '85.50', split_cash_amount: null, notes: null };
const item = { product_name_snapshot: 'Lomito', quantity: 1, excluded_complements: [] as string[] };

describe('buildSmarkyOrderDetails', () => {
  it('efectivo: cobra la comida con 2 decimales', () => {
    expect(buildSmarkyOrderDetails({ ...base, payment_method: 'cash', subtotal_amount: '85.5' }, [item])).toMatchObject({
      paymentMethod: 'cash',
      cashToCollect: '85.50',
    });
  });
  it('qr y tarjeta: qr sin cashToCollect', () => {
    for (const m of ['qr', 'card']) {
      const d = buildSmarkyOrderDetails({ ...base, payment_method: m }, [item]);
      expect(d.paymentMethod).toBe('qr');
      expect(d.cashToCollect).toBeUndefined();
    }
  });
  it('split: efectivo limitado a la comida; sin efectivo → qr', () => {
    expect(buildSmarkyOrderDetails({ ...base, payment_method: 'split', split_cash_amount: '40' }, [item])).toMatchObject({
      paymentMethod: 'cash',
      cashToCollect: '40.00',
    });
    expect(buildSmarkyOrderDetails({ ...base, payment_method: 'split', split_cash_amount: '200' }, [item]).cashToCollect).toBe('85.50');
    expect(buildSmarkyOrderDetails({ ...base, payment_method: 'split', split_cash_amount: '0' }, [item]).paymentMethod).toBe('qr');
  });
  it('items: complementos excluidos como nota, tope de 50 y largos', () => {
    const many = Array.from({ length: 60 }, () => ({ ...item, excluded_complements: ['tomate', 'lechuga'] }));
    const d = buildSmarkyOrderDetails(base, many);
    expect(d.items).toHaveLength(50);
    expect(d.items?.[0].notes).toBe('Sin tomate, lechuga');
    expect(buildSmarkyOrderDetails(base, [{ ...item, product_name_snapshot: 'x'.repeat(200) }]).items?.[0].name).toHaveLength(120);
  });
  it('orderNotes: omitido si vacío, recortado a 500', () => {
    expect(buildSmarkyOrderDetails({ ...base, notes: '  ' }, [item]).orderNotes).toBeUndefined();
    expect(buildSmarkyOrderDetails({ ...base, notes: 'n'.repeat(900) }, [item]).orderNotes).toHaveLength(500);
  });
});
