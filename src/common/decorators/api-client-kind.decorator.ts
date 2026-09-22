import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ApiClientKind as ApiClientKindValue, AuthenticatedRequest } from '../guards/service-auth.guard';

/**
 * Cómo se autenticó la request ('service' | 'staff'), resuelto por
 * ServiceAuthGuard / ServiceOrStaffAuthGuard. Nunca usar sin uno de los dos
 * guards activo.
 */
export const ApiClientKind = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiClientKindValue => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.apiClientKind;
  },
);
