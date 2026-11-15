import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { CreateExtraDto } from './dto/create-extra.dto';
import { UpdateExtraDto } from './dto/update-extra.dto';

export interface ExtraResponse {
  id: string;
  name: string;
  price: number;
  /** true = aplica a todos los platos; en ese caso `productIds` va vacío. */
  appliesToAll: boolean;
  /** Platos a los que aplica cuando `appliesToAll` es false. */
  productIds: string[];
  isActive: boolean;
  sortOrder: number;
}

function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23503';
}

@Injectable()
export class ExtrasService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  /** Por defecto solo los activos (lo que consume el POS); el mantenimiento pide includeInactive para poder reactivar. */
  async findMany(includeInactive = false): Promise<ExtraResponse[]> {
    let query = this.db.selectFrom('extras').selectAll();
    if (!includeInactive) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('sort_order', 'asc').orderBy('created_at', 'asc').execute();
    if (rows.length === 0) return [];

    const links = await this.db
      .selectFrom('extra_products')
      .select(['extra_id', 'product_id'])
      .where(
        'extra_id',
        'in',
        rows.map((r) => r.id),
      )
      .execute();
    const productsByExtra = new Map<string, string[]>();
    for (const link of links) {
      const list = productsByExtra.get(link.extra_id) ?? [];
      list.push(link.product_id);
      productsByExtra.set(link.extra_id, list);
    }
    return rows.map((row) => toExtraResponse(row, productsByExtra.get(row.id) ?? []));
  }

  async create(dto: CreateExtraDto): Promise<ExtraResponse> {
    assertScopeIsValid(dto.appliesToAll, dto.productIds);
    try {
      return await this.db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('extras')
          .values({
            name: dto.name.trim(),
            price: dto.price.toFixed(2),
            applies_to_all: dto.appliesToAll,
            is_active: dto.isActive ?? true,
            sort_order: dto.sortOrder ?? 0,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const productIds = await replaceProducts(trx, row.id, dto.appliesToAll ? [] : (dto.productIds ?? []));
        return toExtraResponse(row, productIds);
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new ValidationError('Alguno de los productos elegidos no existe.');
      throw error;
    }
  }

  async update(id: string, dto: UpdateExtraDto): Promise<ExtraResponse> {
    try {
      return await this.db.transaction().execute(async (trx) => {
        const current = await trx.selectFrom('extras').selectAll().where('id', '=', id).forUpdate().executeTakeFirst();
        if (!current) throw new NotFoundDomainError('extra', id);

        const appliesToAll = dto.appliesToAll ?? current.applies_to_all;
        // Si no mandan productIds se conserva la lista actual, salvo que pasen a "todos" (ahí la lista no aplica).
        const existingIds = await loadProductIds(trx, id);
        const productIds = appliesToAll ? [] : (dto.productIds ?? existingIds);
        assertScopeIsValid(appliesToAll, productIds);

        const row = await trx
          .updateTable('extras')
          .set({
            ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
            ...(dto.price !== undefined ? { price: dto.price.toFixed(2) } : {}),
            ...(dto.appliesToAll !== undefined ? { applies_to_all: dto.appliesToAll } : {}),
            ...(dto.isActive !== undefined ? { is_active: dto.isActive } : {}),
            ...(dto.sortOrder !== undefined ? { sort_order: dto.sortOrder } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', id)
          .returningAll()
          .executeTakeFirstOrThrow();

        const saved = await replaceProducts(trx, id, productIds);
        return toExtraResponse(row, saved);
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) throw new ValidationError('Alguno de los productos elegidos no existe.');
      throw error;
    }
  }
}

function assertScopeIsValid(appliesToAll: boolean, productIds: string[] | undefined): void {
  if (!appliesToAll && (!productIds || productIds.length === 0)) {
    throw new ValidationError('Elegí al menos un plato para este extra, o marcalo como "todos los platos".');
  }
}

async function loadProductIds(db: Kysely<Database>, extraId: string): Promise<string[]> {
  const rows = await db.selectFrom('extra_products').select('product_id').where('extra_id', '=', extraId).execute();
  return rows.map((r) => r.product_id);
}

/** Reemplaza la lista completa de productos del extra (mismo patrón que los complementos de un producto). */
async function replaceProducts(trx: Kysely<Database>, extraId: string, productIds: string[]): Promise<string[]> {
  await trx.deleteFrom('extra_products').where('extra_id', '=', extraId).execute();
  if (productIds.length === 0) return [];
  await trx
    .insertInto('extra_products')
    .values(productIds.map((productId) => ({ extra_id: extraId, product_id: productId })))
    .execute();
  return productIds;
}

function toExtraResponse(
  row: {
    id: string;
    name: string;
    price: string;
    applies_to_all: boolean;
    is_active: boolean;
    sort_order: number;
  },
  productIds: string[],
): ExtraResponse {
  return {
    id: row.id,
    name: row.name,
    price: Number(row.price),
    appliesToAll: row.applies_to_all,
    productIds,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  };
}
