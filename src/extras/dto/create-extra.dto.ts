import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateExtraDto {
  /** Nombre corto, tal cual se ve en el modal del lápiz del POS ("Carne", "Queso") — sin repetir el plato. */
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  name!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  price!: number;

  /** true = aplica a todos los platos (queso, huevo). false = solo a los de `productIds` (la carne es distinta por plato). */
  @IsBoolean()
  appliesToAll!: boolean;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  productIds?: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}
