import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

export interface ProductResponse {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  price: number;
  isActive: boolean;
  isAvailable: boolean;
  sortOrder: number;
}

@Injectable()
export class ProductsService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /** GET /products — catálogo activo. Sold-out ≠ inactivo (invariante 4). */
  async findActive(): Promise<ProductResponse[]> {
    const rows = await this.db
      .selectFrom('products')
      .selectAll()
      .where('is_active', '=', true)
      .orderBy('sort_order', 'asc')
      .execute();
    return rows.map(toProductResponse);
  }

  async create(dto: CreateProductDto): Promise<ProductResponse> {
    const row = await this.db
      .insertInto('products')
      .values({
        code: dto.code,
        name: dto.name,
        category_id: dto.categoryId,
        price: dto.price.toFixed(2),
        is_active: dto.isActive,
        is_available: dto.isAvailable,
        sort_order: dto.sortOrder,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toProductResponse(row);
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponse> {
    const row = await this.db
      .updateTable('products')
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.categoryId !== undefined ? { category_id: dto.categoryId } : {}),
        ...(dto.price !== undefined ? { price: dto.price.toFixed(2) } : {}),
        ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
        ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
        updated_at: new Date(),
      })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('product', id);
    return toProductResponse(row);
  }

  /** PATCH /products/:id/availability — toggle de staff, no afecta is_active. */
  async setAvailability(id: string, available: boolean): Promise<ProductResponse> {
    const row = await this.db
      .updateTable('products')
      .set({ is_available: available, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('product', id);
    return toProductResponse(row);
  }
}

function toProductResponse(row: {
  id: string;
  code: string;
  name: string;
  category_id: string;
  price: string;
  is_active: boolean;
  is_available: boolean;
  sort_order: number;
}): ProductResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    categoryId: row.category_id,
    price: Number(row.price),
    isActive: row.is_active,
    isAvailable: row.is_available,
    sortOrder: row.sort_order,
  };
}
