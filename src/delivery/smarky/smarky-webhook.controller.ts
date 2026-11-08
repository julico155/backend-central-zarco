import { Controller, Headers, HttpCode, NotFoundException, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { SmarkyWebhookService } from './smarky-webhook.service';

/**
 * Ruta pública: no lleva guard de servicio ni de staff porque la autenticidad la da la
 * firma HMAC del cuerpo crudo (`main.ts` lo conserva en `req.rawBody` solo para esta ruta).
 * Con DELIVERY_PROVIDER=internal la ruta no existe.
 */
@Controller('integrations/smarky')
@ApiExcludeController()
export class SmarkyWebhookController {
  constructor(private readonly webhook: SmarkyWebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  async receive(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('smarky-signature') signature: string | undefined,
  ) {
    if (!this.webhook.enabled) throw new NotFoundException();
    const result = await this.webhook.handle(req.rawBody, signature);
    return { received: true, result };
  }
}
