import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class UpdateOperationalSettingsDto {
  @IsOptional()
  @IsBoolean()
  rainSurchargeEnabled?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  rainSurchargeAmount?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessOpensHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  businessClosesHour?: number;

  @IsOptional()
  @IsLatitude()
  restaurantLatitude?: number;

  @IsOptional()
  @IsLongitude()
  restaurantLongitude?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  scheduleOpensHour?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  scheduleClosesHour?: number;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  closedMessage?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  extendedMessage?: string;

  @IsOptional()
  @IsBoolean()
  allowPromoWithItems?: boolean;

  @IsOptional()
  @IsBoolean()
  cashEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  extendedServiceEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  manuallyClosed?: boolean;

  @IsOptional()
  @IsBoolean()
  queueEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  queueCapacity?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  queueReleaseBatch?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  dailyResetHour?: number;
}
