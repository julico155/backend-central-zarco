import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { DomainException } from '../common/exceptions/domain-exception';
import { MenuCatalogService } from './menu-catalog.service';
import { MenuOrderService } from './menu-order.service';
import { MenuSessionRepository } from './menu-session.repository';
import { hashMenuSessionToken } from './menu-session-token';
import { SubmitMenuOrderDto } from './dto/submit-menu-order.dto';

/**
 * API del menú web (Fase 2C). Pública a propósito, igual que en
 * sarcoRestaurant: el `session_token` de la URL ES la autenticación, no un
 * bearer de servicio — nadie sin el enlace puede pagar en nombre de otro
 * cliente. El catálogo (`GET /menu-web/catalog`) es de solo lectura y no
 * exige sesión, igual que `GET /menu` en sarcoRestaurant era público.
 *
 * Esta es exactamente la superficie que el frontend Next.js existente debe
 * empezar a llamar en vez de sus propias rutas `/api/store/orders` y sus
 * lecturas directas a Supabase — ver el punto 4 del entregable.
 */
@Controller('menu-web')
export class MenuController {
  constructor(
    private readonly catalog: MenuCatalogService,
    private readonly sessions: MenuSessionRepository,
    private readonly orders: MenuOrderService,
  ) {}

  /** Catálogo (productos/categorías/promociones activas) + si se puede pagar en efectivo. Sin sesión: es público. */
  @Get('catalog')
  getCatalog() {
    return this.catalog.get();
  }

  /** Valida un `session_token` sin consumirlo. La UI lo llama al abrir el enlace. */
  @Get('session')
  async getSession(@Query('token') token: string | undefined) {
    if (!token) {
      throw new DomainException(
        'missing_session_token',
        HttpStatus.BAD_REQUEST,
        'Falta el token de sesión.',
      );
    }
    const session = await this.sessions.findByHash(hashMenuSessionToken(token));
    if (session === null) {
      throw new DomainException(
        'invalid_session',
        HttpStatus.UNAUTHORIZED,
        'El enlace del menú venció o no es válido.',
      );
    }
    return {
      valid: true,
      expiresAt: session.expiresAt,
      isReplacement: session.replacesOrderId !== null,
    };
  }

  @Post('orders')
  @HttpCode(HttpStatus.OK)
  async createOrder(@Body() dto: SubmitMenuOrderDto, @Res({ passthrough: true }) res: Response) {
    const outcome = await this.orders.submit(dto);
    res.status(outcome.httpStatus);
    return outcome.body;
  }
}
