import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiQuery } from '@nestjs/swagger';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ExtrasService } from './extras.service';
import { CreateExtraDto } from './dto/create-extra.dto';
import { UpdateExtraDto } from './dto/update-extra.dto';

@Controller('extras')
export class ExtrasController {
  constructor(private readonly extras: ExtrasService) {}

  @Get()
  @UseGuards(ServiceOrStaffAuthGuard)
  @ApiQuery({ name: 'includeInactive', required: false, type: Boolean })
  findMany(@Query('includeInactive') includeInactive?: string) {
    return this.extras.findMany(includeInactive === 'true');
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateExtraDto) {
    return this.extras.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateExtraDto) {
    return this.extras.update(id, dto);
  }
}
