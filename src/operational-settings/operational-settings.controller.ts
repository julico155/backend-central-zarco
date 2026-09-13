import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { OperationalSettingsService } from './operational-settings.service';
import { UpdateOperationalSettingsDto } from './dto/update-operational-settings.dto';

@Controller('operational-settings')
@UseGuards(ServiceAuthGuard)
export class OperationalSettingsController {
  constructor(private readonly settings: OperationalSettingsService) {}

  @Get()
  get() {
    return this.settings.get();
  }

  // TODO(auth): restringir a staff (rol admin) una vez exista el módulo `auth`.
  @Patch()
  update(@Body() dto: UpdateOperationalSettingsDto) {
    return this.settings.update(dto);
  }
}
