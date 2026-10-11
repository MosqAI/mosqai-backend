import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Role } from '../generated/prisma/client.js';
import { IS_PUBLIC, ROLES, type AuthUser } from './auth.decorators.js';

/** Global guard: every route needs a valid access token unless marked @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets))
      return true;

    const req = ctx.switchToHttp().getRequest();
    const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
    if (scheme !== 'Bearer' || !token) throw new UnauthorizedException();

    let user: AuthUser;
    try {
      const payload = await this.jwt.verifyAsync<{ sub: string; role: Role }>(
        token,
      );
      user = { id: payload.sub, role: payload.role };
    } catch {
      throw new UnauthorizedException();
    }
    req.user = user;

    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES,
      targets,
    );
    if (roles && !roles.includes(user.role)) throw new ForbiddenException();
    return true;
  }
}
