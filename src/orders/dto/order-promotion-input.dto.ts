import { IsInt, IsUUID, Max, Min } from 'class-validator';

export class OrderPromotionInputDto {
  @IsUUID()
  promotionId!: string;

  @IsInt()
  @Min(1)
  @Max(10)
  quantity!: number;
}
