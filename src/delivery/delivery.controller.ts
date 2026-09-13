import { Body, Controller, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { DeliveryService } from './delivery.service';
import { QuoteDeliveryDto } from './dto/quote-delivery.dto';
import { ManualQuoteDto } from './dto/manual-quote.dto';

@Controller()
@UseGuards(ServiceAuthGuard)
export class DeliveryController {
  constructor(private readonly delivery: DeliveryService) {}

  @Post('delivery/quotes')
  quoteStandalone(@Body() dto: QuoteDeliveryDto, @IdempotencyKey() idempotencyKey: string) {
    return this.delivery.quoteStandalone(dto, idempotencyKey);
  }

  @Post('orders/:id/delivery/quote')
  quoteForOrder(@Param('id', ParseUUIDPipe) id: string) {
    return this.delivery.quoteForOrder(id);
  }

  @Post('orders/:id/delivery/quote/manual')
  setManualQuote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: ManualQuoteDto) {
    return this.delivery.setManualQuote(id, dto.amount);
  }
}
