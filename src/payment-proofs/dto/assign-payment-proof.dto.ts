import { IsUUID } from 'class-validator';

export class AssignPaymentProofDto {
  @IsUUID()
  orderId!: string;
}
