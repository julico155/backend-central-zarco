import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Forma del carrito del menú web. Se mantiene DELIBERADAMENTE compatible con
 * el payload que ya manda el frontend de sarcoRestaurant a
 * `POST /api/store/orders` (`src/lib/orders/web-schema.ts`: snake_case,
 * items por `code` de producto) — así repuntar la UI existente a Backend
 * Central es cambiar una URL, no reescribir el formulario. Ver el punto 4
 * del entregable de esta fase.
 *
 * Lo único nuevo es `excluded_complements`, opcional: la UI actual no lo
 * manda (sarcoRestaurant no tenía complementos), así que su ausencia debe
 * seguir significando "nada excluido", exactamente como hoy.
 */

export class SubmitMenuOrderItemDto {
  @IsString()
  @MinLength(1)
  code!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  excluded_complements?: string[];
}

export class SubmitMenuOrderPromotionDto {
  @IsUUID()
  promotion_id!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;

  @IsInt()
  revision!: number;
}

const DELIVERY_TYPES = ['delivery', 'pickup'] as const;
const PAYMENT_METHODS = ['qr', 'cash'] as const;

export class SubmitMenuOrderDto {
  @IsString()
  @MinLength(1)
  session_token!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customer_name!: string;

  @IsIn(DELIVERY_TYPES)
  delivery_type!: (typeof DELIVERY_TYPES)[number];

  /**
   * `cash` se ACEPTA en la forma del payload (paridad con la UI actual, que
   * todavía puede ofrecer el botón) pero se RECHAZA siempre en
   * `MenuOrderService`: los pedidos canal `whatsapp` de Central solo se
   * pagan por QR (`assertPaymentMethodAllowed`). Ver `menu-catalog.service.ts`
   * (`cashAllowed`), que es lo que debe usar la UI para dejar de ofrecerlo.
   */
  @IsIn(PAYMENT_METHODS)
  payment_method!: (typeof PAYMENT_METHODS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => SubmitMenuOrderItemDto)
  items!: SubmitMenuOrderItemDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => SubmitMenuOrderPromotionDto)
  promotions?: SubmitMenuOrderPromotionDto[];
}
