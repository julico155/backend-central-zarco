import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common';
import { IsString, MinLength } from 'class-validator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { CustomersService } from '../customers/customers.service';
import { OrderQueueService } from './order-queue.service';

/** El agente identifica al cliente por su teléfono de WhatsApp (igual que en /internal/agent/*). */
class QueueCustomerDto {
  @IsString()
  @MinLength(1)
  customerPhone!: string;
}

@Controller('order-queue')
export class OrderQueueController {
  constructor(
    private readonly queue: OrderQueueService,
    private readonly customers: CustomersService,
  ) {}

  /** El agente de WhatsApp, antes de mandar el menú: ¿puede pasar este cliente o espera su turno? */
  @Post('admission')
  @HttpCode(200)
  @UseGuards(ServiceOrStaffAuthGuard)
  async admission(@Body() dto: QueueCustomerDto) {
    const customer = await this.customers.findOrCreate({ phone: dto.customerPhone });
    return this.queue.requestAdmission(customer.id);
  }

  /** El agente, cuando un cliente que ya está en espera vuelve a escribir: ¿hay que recordarle que espere? */
  @Post('remind')
  @HttpCode(200)
  @UseGuards(ServiceOrStaffAuthGuard)
  async remind(@Body() dto: QueueCustomerDto) {
    const customer = await this.customers.findByPhone(dto.customerPhone);
    // Un número que nunca pidió nada no puede estar en la fila.
    if (!customer) return { shouldRemind: false, position: null };
    return this.queue.remind(customer.id);
  }

  /** Para la pantalla de Configuración del POS: cuánta cocina hay ocupada y cuánta gente espera. */
  @Get('summary')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'kitchen', 'cashier')
  summary() {
    return this.queue.summary();
  }
}
