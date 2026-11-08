import { Controller, Get, HttpCode, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ValidationError } from '../../common/exceptions/domain-exception';
import { ServiceAuthGuard } from '../../common/guards/service-auth.guard';
import { SmarkyTrackingService } from './smarky-tracking.service';

/**
 * Solo para el agente (bearer de servicio). Con DELIVERY_PROVIDER=internal ningún pedido tiene
 * link, así que siempre responde `no_tracking`: el agente deriva a una persona como siempre.
 */
@Controller('internal/agent')
@UseGuards(ServiceAuthGuard)
@ApiExcludeController()
export class SmarkyTrackingController {
  constructor(private readonly tracking: SmarkyTrackingService) {}

  @Get('orders/tracking')
  @HttpCode(200)
  find(@Query('customerPhone') customerPhone: string) {
    if (!customerPhone) throw new ValidationError('Falta el query param customerPhone.');
    return this.tracking.findForPhone(customerPhone);
  }
}
