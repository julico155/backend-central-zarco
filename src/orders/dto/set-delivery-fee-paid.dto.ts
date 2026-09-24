import { IsBoolean } from 'class-validator';

export class SetDeliveryFeePaidDto {
  /** true = "envío pagado"; false = "cobrar envío". */
  @IsBoolean()
  paid!: boolean;
}
