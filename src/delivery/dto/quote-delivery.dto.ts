import { IsLatitude, IsLongitude, IsOptional, IsUUID } from 'class-validator';

export class QuoteDeliveryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsLatitude()
  latitude!: number;

  @IsLongitude()
  longitude!: number;
}
