import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { OperationalSettingsService } from './operational-settings.service';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';

@Controller('operational-settings')
export class OperationalSettingsController {
  constructor(private readonly settings: OperationalSettingsService) {}

  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
  get() {
    return this.settings.get();
  }

  /**
   * Estado listo para consumir (¿atendemos?, por qué, textos para el cliente, reglas de efectivo/promos/cola).
   * Lo leen el agente de WhatsApp y el menú web con su token de servicio: así deciden con la MISMA lógica que el backend.
   */
  @Get('service-status')
  @UseGuards(ServiceOrStaffAuthGuard)
  serviceStatus() {
    return this.settings.getServiceStatus();
  }

  @Patch()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Body() dto: UpdateOperationalSettingsDto) {
    return this.settings.update(dto);
  }
}
