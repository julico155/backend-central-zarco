import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { PaymentAttemptsService } from './payment-attempts.service';
import { DecidePaymentAttemptDto } from './dto/decide-payment-attempt.dto';

@Controller()
@UseGuards(ServiceAuthGuard)
export class PaymentAttemptsController {
  constructor(private readonly paymentAttempts: PaymentAttemptsService) {}

  @Get('orders/:id/payment-attempts')
  findByOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.paymentAttempts.findByOrder(id);
  }

  @Post('payment-attempts/:id/decide')
  decide(@Param('id', ParseUUIDPipe) id: string, @Body() dto: DecidePaymentAttemptDto) {
    return this.paymentAttempts.decide(id, dto.decision);
  }
}
