import { Injectable } from '@nestjs/common';
import { CategoriesService } from '../categories/categories.service';
import { isPaymentMethodAllowed } from '../orders/order-channel';
import { PromotionsService, PromotionResponse } from '../promotions/promotions.service';
import { ProductsService, ProductResponse } from '../products/products.service';

export interface MenuCategoryView {
  id: string;
  name: string;
  sortOrder: number;
}

export interface MenuProductView {
  id: string;
  code: string;
  name: string;
  description: string | null;
  categoryId: string;
  price: number;
  /** Sold-out (invariante 4 de Central): distinto de `isActive`, que decide si aparece siquiera. */
  isAvailable: boolean;
  imageUrl: string | null;
}

export interface MenuPromotionView {
  id: string;
  name: string;
  description: string | null;
  promoPrice: number;
  /** El cliente lo manda de vuelta al crear el pedido (`OrderPromotionInputDto.revision`) — control de concurrencia. */
  revision: number;
  /** Solo se listan las que están realmente comprables; ver `PromotionsService.computeStatus`. */
  items: { productId: string; productName: string; quantity: number; unitPrice: number }[];
}

export interface MenuCatalog {
  categories: MenuCategoryView[];
  products: MenuProductView[];
  promotions: MenuPromotionView[];
  /**
   * ¿Se puede pagar en efectivo? Derivado de la regla REAL de Central
   * (`assertPaymentMethodAllowed`), no de un flag propio: los pedidos canal
   * `whatsapp` solo se pagan por QR, siempre — ver `sarco-agent` fase 2B/2C,
   * ítem 6. El menú web nunca debe ofrecer el botón de efectivo.
   */
  cashAllowed: boolean;
}

/**
 * Catálogo del menú web, leído SIEMPRE de Central (Products/Categories/
 * Promotions) — nunca de `menu_items` de sarcoRestaurant, que esta fase no
 * porta.
 */
@Injectable()
export class MenuCatalogService {
  constructor(
    private readonly products: ProductsService,
    private readonly categories: CategoriesService,
    private readonly promotions: PromotionsService,
  ) {}

  async get(): Promise<MenuCatalog> {
    const [products, categories, promotions] = await Promise.all([
      this.products.findMany(false),
      this.categories.findMany(false),
      this.promotions.findAll(),
    ]);

    return {
      categories: categories.map((c) => ({ id: c.id, name: c.name, sortOrder: c.sortOrder })),
      products: products.map(toProductView),
      promotions: promotions.filter((p) => p.status === 'activa').map(toPromotionView),
      cashAllowed: isPaymentMethodAllowed('whatsapp', 'cash'),
    };
  }
}

function toProductView(product: ProductResponse): MenuProductView {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    description: product.description,
    categoryId: product.categoryId,
    price: product.price,
    isAvailable: product.isAvailable,
    imageUrl: product.imageUrl,
  };
}

function toPromotionView(promotion: PromotionResponse): MenuPromotionView {
  return {
    id: promotion.id,
    name: promotion.name,
    description: promotion.description,
    promoPrice: promotion.promoPrice,
    revision: promotion.revision,
    items: promotion.items,
  };
}
