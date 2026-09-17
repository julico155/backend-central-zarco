import {
  IsBoolean,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsNumber,
  IsOptional,
  Max,
  Min,
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
}
