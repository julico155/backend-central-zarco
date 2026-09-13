import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { IdempotencyKey } from '../common/decorators/idempotency-key.decorator';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { OrderStatus } from '../database/types';
import { OrdersService } from './orders.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { AttachLocationDto } from './dto/attach-location.dto';
import { KitchenNoteDto } from './dto/kitchen-note.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';

@Controller()
@UseGuards(ServiceAuthGuard)
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  @Get('orders/:id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.findById(id);
  }

  @Get('orders')
  findMany(@Query('customer_id') customerId?: string, @Query('status') status?: OrderStatus) {
    return this.orders.findMany({ customerId, status });
  }

  @Post('orders')
  create(
    @Body() dto: CreateOrderDto,
    @IdempotencyKey() idempotencyKey: string,
    @ApiClient() apiClient: string,
  ) {
    return this.orders.create(dto, idempotencyKey, apiClient);
  }

  @Post('orders/:id/location-request')
  requestLocation(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.requestLocation(id);
  }

  @Post('orders/:id/location')
  attachLocation(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AttachLocationDto) {
    return this.orders.attachLocation(id, dto);
  }

  @Post('orders/:id/kitchen-note')
  addKitchenNote(@Param('id', ParseUUIDPipe) id: string, @Body() dto: KitchenNoteDto) {
    return this.orders.addKitchenNote(id, dto.note);
  }

  @Post('orders/:id/switch-to-pickup')
  switchToPickup(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.switchToPickup(id);
  }

  @Post('orders/:id/cash/confirm')
  confirmCash(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.confirmCash(id);
  }

  @Post('orders/:id/cash/cancel')
  cancelCash(@Param('id', ParseUUIDPipe) id: string) {
    return this.orders.cancelCash(id);
  }

  @Patch('orders/:id/status')
  updateStatus(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateOrderStatusDto) {
    return this.orders.updateStatus(id, dto.to);
  }
}
