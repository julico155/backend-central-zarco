import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class OrderItemInputDto {
  @IsUUID()
  productId!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}
