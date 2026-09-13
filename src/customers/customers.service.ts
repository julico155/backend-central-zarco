import { Inject, Injectable } from '@nestjs/common';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database } from '../database/types';
import { NotFoundDomainError, ValidationError } from '../common/exceptions/domain-exception';
import { FindOrCreateCustomerDto } from './dto/find-or-create-customer.dto';

export interface CustomerResponse {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}

@Injectable()
export class CustomersService {
  constructor(@Inject(KYSELY) private readonly db: Kysely<Database>) {}

  async findById(id: string): Promise<CustomerResponse> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundDomainError('customer', id);
    return toCustomerResponse(row);
  }

  async findByPhone(phone: string): Promise<CustomerResponse | null> {
    const row = await this.db
      .selectFrom('customers')
      .selectAll()
      .where('phone', '=', phone)
      .executeTakeFirst();
    return row ? toCustomerResponse(row) : null;
  }

  /**
   * Resuelve o crea el cliente. Cada canal decide qué identificador tiene a
   * mano: el gateway de WhatsApp llama con `phone`; el POS puede llamar sin
   * nada ("cliente genérico") o pedir el teléfono.
   *
   * TODO: si llegan phone Y email y cada uno pertenece a un customer
   * distinto ya existente, el INSERT puede violar el unique(email) aunque
   * el ON CONFLICT solo cubra `phone` — decidir la regla de fusión antes de
   * exponer este endpoint a un canal que mande ambos campos a la vez.
   */
  async findOrCreate(dto: FindOrCreateCustomerDto): Promise<CustomerResponse> {
    if (!dto.phone && !dto.email && !dto.name) {
      throw new ValidationError('Se requiere al menos uno de: phone, email, name.');
    }

    if (dto.phone) {
      const byPhone = await this.upsertByUniqueColumn('phone', dto.phone, dto);
      if (byPhone) return byPhone;
    }
    if (dto.email) {
      const byEmail = await this.upsertByUniqueColumn('email', dto.email, dto);
      if (byEmail) return byEmail;
    }

    const created = await this.db
      .insertInto('customers')
      .values({ name: dto.name, phone: dto.phone, email: dto.email })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toCustomerResponse(created);
  }

  private async upsertByUniqueColumn(
    column: 'phone' | 'email',
    value: string,
    dto: FindOrCreateCustomerDto,
  ): Promise<CustomerResponse | null> {
    const inserted = await this.db
      .insertInto('customers')
      .values({ name: dto.name, phone: dto.phone, email: dto.email })
      .onConflict((oc) => oc.column(column).doNothing())
      .returningAll()
      .executeTakeFirst();

    if (inserted) return toCustomerResponse(inserted);

    const existing = await this.db
      .selectFrom('customers')
      .selectAll()
      .where(column, '=', value)
      .executeTakeFirst();
    return existing ? toCustomerResponse(existing) : null;
  }
}

function toCustomerResponse(row: {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
}): CustomerResponse {
  return { id: row.id, name: row.name, phone: row.phone, email: row.email };
}
