import { Body, Controller, ForbiddenException, Get, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ValidationError } from '../common/exceptions/domain-exception';
import { OrderReplacementService } from './order-replacement.service';
import { CreateOrderReplacementDto } from './dto/create-order-replacement.dto';
import { AppendOrderNoteDto } from './dto/append-order-note.dto';

/** Canal del agente de WhatsApp: se reutiliza el api_client existente, no hay canal nuevo (ver AgentLocationsController). */
const AGENT_API_CLIENT = 'whatsapp-gateway';

@Controller('internal/agent')
@UseGuards(ServiceAuthGuard)
export class OrderReplacementController {
  constructor(private readonly replacement: OrderReplacementService) {}

  private assertAgent(apiClient: string): void {
    if (apiClient !== AGENT_API_CLIENT) {
      throw new ForbiddenException('Este endpoint es solo para el canal whatsapp-gateway.');
    }
  }

  // Igual que locations/attach: todos los desenlaces son 200 con `result`, son
  // esperados del flujo (no hay pedido, no es modificable...), no errores HTTP.
  @Get('orders/replaceable')
  @HttpCode(200)
  replaceable(@Query('customerPhone') customerPhone: string, @ApiClient() apiClient: string) {
    this.assertAgent(apiClient);
    if (!customerPhone) throw new ValidationError('Falta el query param customerPhone.');
    return this.replacement.resolveReplaceable(customerPhone);
  }

  @Post('orders/notes')
  @HttpCode(200)
  appendNote(@Body() dto: AppendOrderNoteDto, @ApiClient() apiClient: string) {
    this.assertAgent(apiClient);
    return this.replacement.appendNote(dto, apiClient);
  }

  @Post('orders/replacements')
  async createReplacement(
    @Body() dto: CreateOrderReplacementDto,
    @IdempotencyKey() idempotencyKey: string,
    @ApiClient() apiClient: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    this.assertAgent(apiClient);
    const outcome = await this.replacement.createReplacement(dto, idempotencyKey, apiClient);
    res.status(outcome.httpStatus);
    return outcome.body;
  }
}
