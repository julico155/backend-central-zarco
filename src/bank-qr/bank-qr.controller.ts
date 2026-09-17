import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { ServiceOrStaffAuthGuard } from '../common/guards/service-or-staff-auth.guard';
import { QrPaymentsService } from './qr-payments.service';

@Controller()
export class BankQrController {
  constructor(private readonly qrPayments: QrPaymentsService) {}

  // El cajero lo dispara desde el POS al elegir "cobrar QR" — acción
  // explícita, no automática, así no se genera un QR bancario si el cliente
  // termina pagando efectivo.
  @Post('orders/:id/qr/generate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('admin', 'cashier')
  generate(@Param('id', ParseUUIDPipe) id: string) {
    return this.qrPayments.generateForOrder(id);
  }

  /** Streaming autenticado — mismo criterio que fotos de producto, nunca Base64 crudo en un JSON. */
  @Get('orders/:id/qr-image')
  @UseGuards(ServiceOrStaffAuthGuard)
  async getImage(@Param('id', ParseUUIDPipe) id: string, @Res() res: Response) {
    const { bytes, mimeType } = await this.qrPayments.getQrImage(id);
    res.setHeader('content-type', mimeType);
    res.setHeader('cache-control', 'private, max-age=60');
    res.send(bytes);
  }

  /**
   * Webhook del banco (`notifyPaymentQR`) — sin auth propia todavía porque
   * Banco Económico no documentó cómo se autentica de su lado (ver manual,
   * sección "Lo que todavía falta validar"). Por eso NUNCA se confía en el
   * body para cambiar estado directo: solo dispara una re-verificación con
   * `statusQR` para el qrId recibido, igual que un tick del cron. Lo peor
   * que puede lograr alguien sin credenciales es forzar una consulta de más
   * — nunca falsificar un pago.
   */
  @Post('bank/baneco/webhook/notify-payment')
  async notifyPayment(@Body() body: Record<string, unknown>) {
    const qrId = typeof body.qrId === 'string' ? body.qrId : null;
    await this.qrPayments.recordNotifyPayload(qrId, body);
    if (qrId) await this.qrPayments.resolveCharge(qrId);
    return { received: true };
  }
}
