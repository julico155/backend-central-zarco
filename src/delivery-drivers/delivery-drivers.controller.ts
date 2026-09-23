import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentStaffUser } from '../auth/current-staff-user.decorator';
import { JwtPayload } from '../auth/auth.service';
import { DeliveryDriversService } from './delivery-drivers.service';
import { AcceptDeliveryOrderDto } from './dto/accept-delivery-order.dto';

/** Pantalla del repartidor. Solo rol `delivery` (o `admin` como override). */
@Controller('delivery/orders')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('delivery', 'admin')
export class DeliveryDriversController {
  constructor(private readonly drivers: DeliveryDriversService) {}

  @Get('available')
  listAvailable() {
    return this.drivers.listAvailable();
  }

  @Get('mine')
  listMine(@CurrentStaffUser() staffUser: JwtPayload) {
    return this.drivers.listMine(staffUser.sub);
  }

  @Post(':id/accept')
  accept(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AcceptDeliveryOrderDto,
    @CurrentStaffUser() staffUser: JwtPayload,
  ) {
    return this.drivers.accept(id, staffUser, dto);
  }

  @Post(':id/deliver')
  @HttpCode(200)
  deliver(@Param('id', ParseUUIDPipe) id: string, @CurrentStaffUser() staffUser: JwtPayload) {
    return this.drivers.deliver(id, staffUser);
  }
}
