import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { SetAvailabilityDto } from './dto/set-availability.dto';

@Controller('products')
export class ProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  @UseGuards(ServiceAuthGuard)
  findActive() {
    return this.products.findActive();
  }

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  create(@Body() dto: CreateProductDto) {
    return this.products.create(dto);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto) {
    return this.products.update(id, dto);
  }

  // Marcar agotado/disponible es una decisión de piso de cocina, no solo de admin.
  @Patch(':id/availability')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'kitchen')
  setAvailability(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetAvailabilityDto) {
    return this.products.setAvailability(id, dto.available);
  }
}
