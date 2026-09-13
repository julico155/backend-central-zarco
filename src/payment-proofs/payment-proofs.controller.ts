import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { PaymentProofsService } from './payment-proofs.service';
import { AssignPaymentProofDto } from './dto/assign-payment-proof.dto';
import { PaymentProofRoutingException } from '../database/types';

@Controller('payment-proofs')
@UseGuards(ServiceAuthGuard)
export class PaymentProofsController {
  constructor(private readonly paymentProofs: PaymentProofsService) {}

  @Get()
  find(
    @Query('routing_exception') routingException?: PaymentProofRoutingException,
    @Query('match_method') matchMethod?: string,
    @Query('order_id') orderId?: string,
  ) {
    if (orderId === 'null' || matchMethod) {
      return this.paymentProofs.findUnassigned(matchMethod);
    }
    return this.paymentProofs.findWithRoutingException(routingException);
  }

  @Post()
  intake() {
    return this.paymentProofs.intake();
  }

  @Get(':id/file')
  streamFile() {
    return this.paymentProofs.streamFile();
  }

  @Post(':id/assign')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignPaymentProofDto) {
    return this.paymentProofs.assign(id, dto.orderId);
  }
}
