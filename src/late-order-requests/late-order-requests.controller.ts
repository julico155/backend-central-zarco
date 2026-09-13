import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { ServiceAuthGuard } from '../common/guards/service-auth.guard';
import { ApiClient } from '../common/decorators/api-client.decorator';
import { LateOrderRequestsService } from './late-order-requests.service';
import { RejectLateOrderRequestDto } from './dto/reject-late-order-request.dto';

@Controller('late-order-requests')
@UseGuards(ServiceAuthGuard)
export class LateOrderRequestsController {
  constructor(private readonly lateOrderRequests: LateOrderRequestsService) {}

  @Get(':id')
  findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.lateOrderRequests.findById(id);
  }

  // TODO(auth): decidedBy debería venir de un dashboard_user autenticado,
  // no del api_client de servicio — ver módulo `auth` (pendiente).
  @Post(':id/accept')
  accept(@Param('id', ParseUUIDPipe) id: string, @ApiClient() apiClient: string) {
    return this.lateOrderRequests.accept(id, apiClient);
  }

  @Post(':id/reject')
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @ApiClient() apiClient: string,
    @Body() dto: RejectLateOrderRequestDto,
  ) {
    return this.lateOrderRequests.reject(id, apiClient, dto.reason);
  }
}
