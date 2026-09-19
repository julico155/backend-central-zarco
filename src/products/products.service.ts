import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { DomainException, NotFoundDomainError } from '../common/exceptions/domain-exception';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { UploadProductImageDto } from './dto/upload-product-image.dto';
import {
  buildProductImageKey,
  PRODUCT_IMAGE_MAX_BYTES,
  PRODUCT_IMAGE_STORAGE,
  ProductImageStorage,
} from './storage/product-image-storage';

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';
}

export interface ProductResponse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  categoryId: string;
  price: number;
  isActive: boolean;
  isAvailable: boolean;
  sortOrder: number;
  /** Ruta relativa al backend, no una URL directa al bucket — mismo criterio que payment-proofs. Null si el producto no tiene foto. */
  imageUrl: string | null;
}

@Injectable()
export class ProductsService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    @Inject(PRODUCT_IMAGE_STORAGE) private readonly imageStorage: ProductImageStorage,
  ) {}

  /**
   * Por defecto solo los activos (es lo que consume el catálogo de venta).
   * El mantenimiento de menú necesita `includeInactive` para poder
   * reactivar uno: sin eso, desactivarlo lo vuelve irrecuperable desde la
   * UI. Sold-out ≠ inactivo (invariante 4) — `isAvailable` no se toca acá.
   */
  async findMany(includeInactive = false): Promise<ProductResponse[]> {
    let query = this.db.selectFrom('products').selectAll();
    if (!includeInactive) query = query.where('is_active', '=', true);
    const rows = await query.orderBy('sort_order', 'asc').execute();
    return rows.map(toProductResponse);
  }

  async create(dto: CreateProductDto): Promise<ProductResponse> {
    try {
      const row = await this.db
        .insertInto('products')
        .values({
          code: dto.code,
          name: dto.name,
          description: dto.description ?? null,
          category_id: dto.categoryId,
          price: dto.price.toFixed(2),
          is_active: dto.isActive,
          is_available: dto.isAvailable,
          sort_order: dto.sortOrder,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toProductResponse(row);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainException(
          'product_code_taken',
          HttpStatus.CONFLICT,
          `Ya existe un producto con el código "${dto.code}".`,
        );
      }
      throw error;
    }
  }

  async update(id: string, dto: UpdateProductDto): Promise<ProductResponse> {
    const row = await this.db
      .updateTable('products')
      .set({
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
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

  /** POST /products/:id/image — reemplaza la foto si ya había una (misma key, ver buildProductImageKey). */
  async uploadImage(id: string, dto: UploadProductImageDto): Promise<ProductResponse> {
    const bytes = Buffer.from(dto.fileBase64, 'base64');
    if (bytes.length === 0 || bytes.length > PRODUCT_IMAGE_MAX_BYTES) {
      throw new DomainException(
        'invalid_image',
        HttpStatus.BAD_REQUEST,
        `El archivo debe pesar entre 1 byte y ${PRODUCT_IMAGE_MAX_BYTES} bytes.`,
      );
    }

    const key = buildProductImageKey(id);
    await this.imageStorage.putObject({ key, bytes, mimeType: dto.mimeType });

    const row = await this.db
      .updateTable('products')
      .set({ image_key: key, image_mime_type: dto.mimeType, updated_at: new Date() })
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirst();

    if (!row) throw new NotFoundDomainError('product', id);
    return toProductResponse(row);
  }

  /** GET /products/:id/image — nunca una URL directa al bucket, se sirve siempre a través del backend. */
  async getImage(id: string): Promise<{ bytes: Buffer; mimeType: string }> {
    const row = await this.db
      .selectFrom('products')
      .select(['image_key', 'image_mime_type'])
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('product', id);
    if (!row.image_key || !row.image_mime_type) {
      throw new DomainException(
        'product_image_not_set',
        HttpStatus.NOT_FOUND,
        'El producto no tiene foto.',
      );
    }
    const bytes = await this.imageStorage.getObject(row.image_key);
    return { bytes, mimeType: row.image_mime_type };
  }
}

function toProductResponse(row: {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category_id: string;
  price: string;
  is_active: boolean;
  is_available: boolean;
  sort_order: number;
  image_key: string | null;
}): ProductResponse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    categoryId: row.category_id,
    price: Number(row.price),
    isActive: row.is_active,
    isAvailable: row.is_available,
    sortOrder: row.sort_order,
    imageUrl: row.image_key ? `/products/${row.id}/image` : null,
  };
}
