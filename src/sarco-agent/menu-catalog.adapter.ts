import { Injectable } from '@nestjs/common';
import { CategoriesService } from '../categories/categories.service';
import { ProductsService } from '../products/products.service';
import type { MenuCatalogPort, MenuItemForModel } from './tools/menu-tools';

/**
 * `get_menu_items` conectada directo a ProductsService/CategoriesService de
 * Backend Central — sin pasar por `menu_sessions` (que esta fase no porta).
 * Es la misma fuente que usa el resto del sistema: el agente no puede tener
 * un catálogo propio desincronizado de los precios reales.
 */
@Injectable()
export class MenuCatalogAdapter implements MenuCatalogPort {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
  ) {}

  async listForModel(): Promise<MenuItemForModel[]> {
    const [products, categories] = await Promise.all([
      this.products.findMany(false),
      this.categories.findMany(false),
    ]);
    const categoryName = new Map(categories.map((c) => [c.id, c.name]));

    return products
      .filter((product) => product.isAvailable)
      .map((product) => ({
        name: product.name,
        price: product.price,
        category: categoryName.get(product.categoryId) ?? 'otros',
        ...(product.description ? { description: product.description } : {}),
      }));
  }
}
