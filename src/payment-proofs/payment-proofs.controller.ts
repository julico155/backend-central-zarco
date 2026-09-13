import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { PaymentProofsService } from './payment-proofs.service';
import { AssignPaymentProofDto } from './dto/assign-payment-proof.dto';
import { IntakePaymentProofDto } from './dto/intake-payment-proof.dto';
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
  intake(@Body() dto: IntakePaymentProofDto) {
    return this.paymentProofs.intake(dto);
  }

  /** Streaming autenticado — nunca una URL directa al storage. */
  @Get(':id/file')
  async streamFile(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.paymentProofs.readFile(id);
    res.setHeader('content-type', mimeType);
    res.send(bytes);
  }

  @Post(':id/assign')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignPaymentProofDto) {
    return this.paymentProofs.assign(id, dto.orderId);
  }
}
