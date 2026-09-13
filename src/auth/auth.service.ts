import { Injectable, NotImplementedException } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';

/**
 * Cuentas de staff (dashboard_users, compartidas entre dashboard y POS).
 * El plan no fija el contrato de este módulo — queda pendiente decidir:
 *   - JWT (stateless, bueno para POS como app separada) vs sesión de
 *     servidor (cookie), y expiración/refresh.
 *   - Cómo se derivan roles ('admin'|'kitchen'|'cashier') en los endpoints
 *     de otros módulos marcados TODO(auth) (ver categories/products/
 *     promotions/operational-settings/late-order-requests).
 * Requiere agregar @nestjs/jwt (o similar) y bcrypt para comparar contra
 * dashboard_users.password_hash antes de implementar login().
 */
@Injectable()
export class AuthService {
  async login(_dto: LoginDto): Promise<never> {
    throw new NotImplementedException(
      'POST /auth/login pendiente — ver decisiones en AuthService.',
    );
  }
}
