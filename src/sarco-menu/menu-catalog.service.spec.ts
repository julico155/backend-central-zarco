import { MenuCatalogService } from './menu-catalog.service';
import type { ProductResponse } from '../products/products.service';
import type { PromotionResponse } from '../promotions/promotions.service';

function product(overrides: Partial<ProductResponse> = {}): ProductResponse {
  return {
    id: 'prod-1',
    code: 'trancapecho',
    name: 'Trancapecho',
    description: 'El clásico',
    categoryId: 'cat-1',
    price: 25,
    isActive: true,
    isAvailable: true,
    sortOrder: 0,
    imageUrl: null,
    complements: [],
    ...overrides,
  };
}

function promotion(overrides: Partial<PromotionResponse> = {}): PromotionResponse {
  return {
    id: 'promo-1',
    name: '2x Trancapecho',
    description: null,
    promoPrice: 40,
    isActive: true,
    archivedAt: null,
    startsAt: null,
    endsAt: null,
    sortOrder: 0,
    imageUrl: null,
    revision: 3,
    status: 'activa',
    items: [{ productId: 'prod-1', productName: 'Trancapecho', quantity: 2, unitPrice: 25 }],
    ...overrides,
  };
}

describe('MenuCatalogService', () => {
  it('el catálogo proviene de ProductsService/CategoriesService/PromotionsService de Central', async () => {
    const products = { findMany: jest.fn().mockResolvedValue([product()]) };
    const categories = {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'cat-1', name: 'Hamburguesas', sortOrder: 0, isActive: true }]),
    };
    const promotions = { findAll: jest.fn().mockResolvedValue([promotion()]) };

    const service = new MenuCatalogService(
      products as never,
      categories as never,
      promotions as never,
    );
    const catalog = await service.get();

    expect(products.findMany).toHaveBeenCalledWith(false);
    expect(categories.findMany).toHaveBeenCalledWith(false);
    expect(promotions.findAll).toHaveBeenCalledTimes(1);
    expect(catalog.products).toEqual([
      expect.objectContaining({ id: 'prod-1', code: 'trancapecho', price: 25 }),
    ]);
    expect(catalog.categories).toEqual([{ id: 'cat-1', name: 'Hamburguesas', sortOrder: 0 }]);
  });

  it('solo lista promociones con status "activa" (comprables ahora)', async () => {
    const products = { findMany: jest.fn().mockResolvedValue([]) };
    const categories = { findMany: jest.fn().mockResolvedValue([]) };
    const promotions = {
      findAll: jest
        .fn()
        .mockResolvedValue([
          promotion({ id: 'promo-active', status: 'activa' }),
          promotion({ id: 'promo-expired', status: 'expirada' }),
          promotion({ id: 'promo-sold-out', status: 'agotada' }),
        ]),
    };

    const service = new MenuCatalogService(
      products as never,
      categories as never,
      promotions as never,
    );
    const catalog = await service.get();

    expect(catalog.promotions.map((p) => p.id)).toEqual(['promo-active']);
  });

  it('cashAllowed nunca queda hardcodeado en true: para el canal whatsapp siempre es false', async () => {
    const products = { findMany: jest.fn().mockResolvedValue([]) };
    const categories = { findMany: jest.fn().mockResolvedValue([]) };
    const promotions = { findAll: jest.fn().mockResolvedValue([]) };

    const service = new MenuCatalogService(
      products as never,
      categories as never,
      promotions as never,
    );
    const catalog = await service.get();

    expect(catalog.cashAllowed).toBe(false);
  });
});
