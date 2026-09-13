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
import { PromotionsService } from './promotions.service';
import { CreatePromotionDto } from './dto/create-promotion.dto';
import { UpdatePromotionDto } from './dto/update-promotion.dto';
import { SetActiveDto, SetArchivedDto } from './dto/set-flag.dto';
import { MovePromotionDto } from './dto/move-promotion.dto';

@Controller('promotions')
@UseGuards(ServiceAuthGuard)
export class PromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  findAll() {
    return this.promotions.findAll();
  }

  @Get(':id')
  findOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.findOne(id);
  }

  // TODO(auth): restringir a staff una vez exista el módulo `auth`.
  @Post()
  create(@Body() dto: CreatePromotionDto) {
    return this.promotions.create(dto);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePromotionDto) {
    return this.promotions.update(id, dto);
  }

  @Patch(':id/active')
  setActive(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetActiveDto) {
    return this.promotions.setActive(id, dto.active);
  }

  @Patch(':id/archived')
  setArchived(@Param('id', ParseUUIDPipe) id: string, @Body() dto: SetArchivedDto) {
    return this.promotions.setArchived(id, dto.archived);
  }

  @Post(':id/duplicate')
  duplicate(@Param('id', ParseUUIDPipe) id: string) {
    return this.promotions.duplicate(id);
  }

  @Post(':id/move')
  move(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MovePromotionDto) {
    return this.promotions.move(id, dto.sortOrder);
  }
}
