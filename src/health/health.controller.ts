import { Controller, Get } from '@nestjs/common';

/**
 * Liveness para el healthcheck de Railway: responde si el proceso atiende HTTP.
 * A propósito NO consulta ninguna base de datos ni servicio externo: una DB
 * lenta no debe hacer que la plataforma reinicie una app que sí funciona.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
