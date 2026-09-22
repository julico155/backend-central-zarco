import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OrderChannel, OrderDeliveryType, OrderPaymentMethod } from '../../database/types';
import { OrderItemInputDto } from './order-item-input.dto';
import { OrderPromotionInputDto } from './order-promotion-input.dto';

const CHANNELS: OrderChannel[] = ['whatsapp', 'web', 'pos'];
const DELIVERY_TYPES: OrderDeliveryType[] = ['delivery', 'pickup'];
const PAYMENT_METHODS: OrderPaymentMethod[] = ['qr', 'cash', 'card'];

export class CreateOrderDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsIn(CHANNELS)
  channel!: OrderChannel;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  customerName!: string;

  @IsIn(DELIVERY_TYPES)
  deliveryType!: OrderDeliveryType;

  @IsIn(PAYMENT_METHODS)
  paymentMethod!: OrderPaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => OrderItemInputDto)
  items!: OrderItemInputDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderPromotionInputDto)
  promotions?: OrderPromotionInputDto[];

  /** Solo honrado para staff con rol autorizado — ver módulo `auth` (pendiente). */
  @IsOptional()
  @IsBoolean()
  bypassHoursGate?: boolean;

  /**
   * Modo sombra: crea el pedido (o la solicitud fuera de horario) normalmente
   * — precios, disponibilidad, gate de horario e idempotencia se evalúan
   * igual — pero NO genera ningún notification_job derivado de esta llamada:
   * ni `order_received`, ni `qr_confirmation`, ni `late_request_alert`. Solo
   * para probar la integración contra datos reales sin escribirle a nadie.
   * Reservado a api_clients de servicio listados en
   * `SHADOW_ORDER_API_CLIENTS` (ver `shadow-orders.ts`); cualquier otro que
   * lo mande recibe 403. No cambia delivery ni pagos, y no afecta a los
   * avisos de los DEMÁS endpoints sobre el mismo pedido (location_request,
   * cambios de estado): esos siguen saliendo normalmente.
   *
   * Solo soportado dentro del horario normal: en la ventana `late_review` la
   * llamada falla con 409 `shadow_late_review_not_supported` y no se crea
   * nada (ver `shadow-orders.ts`).
   */
  @IsOptional()
  @IsBoolean()
  suppressNotifications?: boolean;
}
