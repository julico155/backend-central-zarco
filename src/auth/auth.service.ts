import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcryptjs';
import { Kysely } from 'kysely';
import { KYSELY } from '../database/database.module';
import { Database, DashboardUserRole } from '../database/types';
import { DomainException } from '../common/exceptions/domain-exception';
import { LoginDto } from './dto/login.dto';

export interface JwtPayload {
  sub: string;
  username: string;
  role: DashboardUserRole;
}

export interface LoginResponse {
  accessToken: string;
  user: { id: string; username: string; role: DashboardUserRole };
}

/** Cuentas de staff (dashboard_users, compartidas entre dashboard y POS). */
@Injectable()
export class AuthService {
  constructor(
    @Inject(KYSELY) private readonly db: Kysely<Database>,
    private readonly jwt: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<LoginResponse> {
    const user = await this.db
      .selectFrom('dashboard_users')
      .selectAll()
      .where('username', '=', dto.username)
      .executeTakeFirst();

    // Mismo mensaje genérico tanto si el usuario no existe como si la
    // contraseña es incorrecta — no revelar cuál de las dos falló.
    const invalidCredentials = () =>
      new DomainException(
        'invalid_credentials',
        HttpStatus.UNAUTHORIZED,
        'Usuario o contraseña incorrectos.',
      );

    if (!user || !user.is_active) throw invalidCredentials();

    const passwordMatches = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordMatches) throw invalidCredentials();

    const payload: JwtPayload = { sub: user.id, username: user.username, role: user.role };
    const accessToken = await this.jwt.signAsync(payload);

    return { accessToken, user: { id: user.id, username: user.username, role: user.role } };
  }
}
